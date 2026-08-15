import type { PaperclipMcpConfig } from "./config.js";

export class PaperclipApiError extends Error {
  readonly status: number;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;

  constructor(input: {
    status: number;
    method: string;
    path: string;
    body: unknown;
    message: string;
  }) {
    super(input.message);
    this.name = "PaperclipApiError";
    this.status = input.status;
    this.method = input.method;
    this.path = input.path;
    this.body = input.body;
  }
}

export interface EndpointFailure {
  /** Candidate origin that failed, e.g. `https://paperclip.example/api`. */
  apiUrl: string;
  /** `access_gate` = intercepted by a proxy; `transport` = never got a response. */
  kind: "access_gate" | "transport";
  reason: string;
  /** True when the request may have been processed by the API despite failing. */
  requestMayHaveLanded: boolean;
}

export class PaperclipApiUnreachableError extends Error {
  readonly method: string;
  readonly path: string;
  readonly failures: EndpointFailure[];

  constructor(input: { method: string; path: string; failures: EndpointFailure[] }) {
    const detail = input.failures.map((failure) => `${failure.apiUrl} (${failure.reason})`).join("; ");
    super(`${input.method} ${input.path} could not reach the Paperclip API: ${detail || "no candidates"}`);
    this.name = "PaperclipApiUnreachableError";
    this.method = input.method;
    this.path = input.path;
    this.failures = input.failures;
  }
}

export interface JsonRequestOptions {
  body?: unknown;
  includeRunId?: boolean;
}

export interface PaperclipApiClientDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const RETRY_BACKOFF_MS = [250, 500, 1000, 2000];

/** Proxy-generated statuses that mean the origin never answered. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

/**
 * Error codes that prove the request never reached the API, so replaying it —
 * including a non-idempotent write — cannot duplicate work.
 */
const PRE_REQUEST_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function isWriteMethod(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

function buildErrorMessage(method: string, path: string, status: number, body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return `${method} ${path} failed with ${status}: ${body.error}`;
  }
  return `${method} ${path} failed with ${status}`;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function errorCodeOf(error: unknown): string | null {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  for (const candidate of candidates) {
    const code = (candidate as { code?: unknown } | null)?.code;
    if (typeof code === "string") return code;
  }
  return null;
}

function isAccessGateHost(hostname: string): boolean {
  return /(^|\.)cloudflareaccess\.com$/i.test(hostname);
}

/**
 * A 3xx on a JSON API path is never a valid API response — it is an edge proxy
 * (Cloudflare Access and friends) bouncing a non-browser client to a login
 * page. Treat it as a transport failure worth failing over, not as data.
 */
function classifyGateResponse(response: Response, requestUrl: URL): EndpointFailure["reason"] | null {
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? "";
    let gateHost: string | null = null;
    try {
      gateHost = new URL(location, requestUrl).hostname;
    } catch {
      gateHost = null;
    }
    if (gateHost && isAccessGateHost(gateHost)) {
      return `HTTP ${response.status} redirect to access gate ${gateHost}`;
    }
    return `HTTP ${response.status} redirect to ${location || "unknown location"}`;
  }

  if (response.status === 401 || response.status === 403) {
    const contentType = response.headers.get("content-type") ?? "";
    if (/text\/html/i.test(contentType)) {
      return `HTTP ${response.status} HTML challenge (expected JSON)`;
    }
  }

  return null;
}

export class PaperclipApiClient {
  private readonly candidates: string[];
  private readonly connectRetryBudgetMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Last candidate that answered; retried first so failover is paid once. */
  private pinnedApiUrl: string | null = null;

  constructor(
    private readonly config: PaperclipMcpConfig,
    deps: PaperclipApiClientDeps = {},
  ) {
    const configured = (config.apiUrlCandidates ?? []).filter(
      (value) => typeof value === "string" && value.trim().length > 0,
    );
    this.candidates = Array.from(new Set([config.apiUrl, ...configured].filter(Boolean)));
    this.connectRetryBudgetMs = config.connectRetryBudgetMs ?? 15_000;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? (() => Date.now());
  }

  get defaults() {
    return {
      companyId: this.config.companyId,
      agentId: this.config.agentId,
      runId: this.config.runId,
    };
  }

  /** Candidate origins in attempt order, pinned endpoint first. */
  get apiUrlCandidates(): string[] {
    const pinned = this.pinnedApiUrl;
    if (!pinned) return [...this.candidates];
    return [pinned, ...this.candidates.filter((candidate) => candidate !== pinned)];
  }

  resolveCompanyId(companyId?: string | null): string {
    const resolved = companyId?.trim() || this.config.companyId;
    if (!resolved) {
      throw new Error("companyId is required because PAPERCLIP_COMPANY_ID is not set");
    }
    return resolved;
  }

  resolveAgentId(agentId?: string | null): string {
    const resolved = agentId?.trim() || this.config.agentId;
    if (!resolved) {
      throw new Error("agentId is required because PAPERCLIP_AGENT_ID is not set");
    }
    return resolved;
  }

  async requestJson<T>(method: string, path: string, options: JsonRequestOptions = {}): Promise<T> {
    if (!path.startsWith("/")) {
      throw new Error(`API path must start with "/": ${path}`);
    }

    const normalizedMethod = method.toUpperCase();
    const isWrite = isWriteMethod(normalizedMethod);
    const deadline = this.now() + this.connectRetryBudgetMs;
    const failures: EndpointFailure[] = [];
    let sweep = 0;

    for (;;) {
      for (const apiUrl of this.apiUrlCandidates) {
        const attempt = await this.attempt<T>(apiUrl, normalizedMethod, path, options);
        if (attempt.kind === "ok") {
          this.pinnedApiUrl = apiUrl;
          return attempt.value;
        }
        if (attempt.kind === "api_error") {
          // A real API response, even a 4xx/5xx: the endpoint works, so do not
          // fail over and risk applying the same write somewhere else.
          this.pinnedApiUrl = apiUrl;
          throw attempt.error;
        }

        failures.push(attempt.failure);
        if (this.pinnedApiUrl === apiUrl) this.pinnedApiUrl = null;
        if (isWrite && attempt.failure.requestMayHaveLanded) {
          // Unknown whether the server applied it — replaying could duplicate.
          throw new PaperclipApiUnreachableError({ method: normalizedMethod, path, failures });
        }
      }

      const backoff = RETRY_BACKOFF_MS[Math.min(sweep, RETRY_BACKOFF_MS.length - 1)];
      if (this.now() + backoff > deadline) {
        throw new PaperclipApiUnreachableError({ method: normalizedMethod, path, failures });
      }
      sweep += 1;
      await this.sleep(backoff);
    }
  }

  private async attempt<T>(
    apiUrl: string,
    method: string,
    path: string,
    options: JsonRequestOptions,
  ): Promise<
    | { kind: "ok"; value: T }
    | { kind: "api_error"; error: PaperclipApiError }
    | { kind: "failure"; failure: EndpointFailure }
  > {
    const url = new URL(path.slice(1), `${apiUrl}/`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if ((options.includeRunId ?? isWriteMethod(method)) && this.config.runId) {
      headers["X-Paperclip-Run-Id"] = this.config.runId;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        // Surface the redirect instead of following it into a login page.
        redirect: "manual",
      });
    } catch (error) {
      const code = errorCodeOf(error);
      const reason = code ?? (error instanceof Error ? error.message : String(error));
      return {
        kind: "failure",
        failure: {
          apiUrl,
          kind: "transport",
          reason,
          requestMayHaveLanded: !(code !== null && PRE_REQUEST_ERROR_CODES.has(code)),
        },
      };
    }

    const gateReason = classifyGateResponse(response, url);
    if (gateReason) {
      return {
        kind: "failure",
        failure: {
          apiUrl,
          kind: "access_gate",
          reason: gateReason,
          // The gate answered instead of the API, so nothing was applied.
          requestMayHaveLanded: false,
        },
      };
    }

    if (GATEWAY_STATUSES.has(response.status)) {
      // A proxy answered while the origin was down (server restart). The API
      // itself never uses these codes.
      return {
        kind: "failure",
        failure: {
          apiUrl,
          kind: "transport",
          reason: `HTTP ${response.status} from gateway`,
          requestMayHaveLanded: response.status === 504,
        },
      };
    }

    const parsedBody = await parseResponseBody(response);
    if (!response.ok) {
      return {
        kind: "api_error",
        error: new PaperclipApiError({
          status: response.status,
          method,
          path,
          body: parsedBody,
          message: buildErrorMessage(method, path, response.status, parsedBody),
        }),
      };
    }

    return { kind: "ok", value: parsedBody as T };
  }
}
