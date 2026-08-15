export interface PaperclipMcpConfig {
  apiUrl: string;
  /**
   * Ordered failover list for the API origin. The first entry is always the
   * configured `apiUrl`; loopback candidates derived from the server's listen
   * host/port follow so a run on the same host can bypass an edge proxy
   * (e.g. Cloudflare Access) that rejects non-browser clients.
   */
  apiUrlCandidates?: string[];
  apiKey: string;
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
  /** Bounded window for retrying transport failures (server restart). */
  connectRetryBudgetMs?: number;
}

const DEFAULT_CONNECT_RETRY_BUDGET_MS = 15_000;
const MAX_CONNECT_RETRY_BUDGET_MS = 120_000;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeApiUrl(apiUrl: string): string {
  const trimmed = stripTrailingSlash(apiUrl.trim());
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function formatHostForUrl(rawHost: string): string | null {
  const host = rawHost.trim();
  if (!host) return null;
  // A wildcard bind is not dialable; loopback is the reachable equivalent.
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::" || host === "[::]") return "[::1]";
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

function parseCandidatesJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function pushCandidate(target: string[], seen: Set<string>, rawUrl: string | null | undefined): void {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return;
  let normalized: string;
  try {
    normalized = normalizeApiUrl(trimmed);
    // Reject anything that is not a parseable absolute URL.
    new URL(normalized);
  } catch {
    return;
  }
  if (seen.has(normalized)) return;
  seen.add(normalized);
  target.push(normalized);
}

/**
 * Builds the ordered candidate list used for API failover.
 *
 * Order matters: the explicitly configured URL stays first so a remote run
 * (where loopback would point at the wrong machine) keeps its current
 * behaviour. Loopback candidates are appended, so a same-host run only uses
 * them when the configured URL is unreachable or intercepted by an access
 * gate.
 */
export function resolveApiUrlCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  pushCandidate(candidates, seen, nonEmpty(env.PAPERCLIP_API_URL));
  for (const entry of parseCandidatesJson(nonEmpty(env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON))) {
    pushCandidate(candidates, seen, entry);
  }
  pushCandidate(candidates, seen, nonEmpty(env.PAPERCLIP_RUNTIME_API_URL));

  const listenPort = nonEmpty(env.PAPERCLIP_LISTEN_PORT);
  if (listenPort) {
    const listenHost = formatHostForUrl(env.PAPERCLIP_LISTEN_HOST ?? "");
    if (listenHost) pushCandidate(candidates, seen, `http://${listenHost}:${listenPort}`);
    pushCandidate(candidates, seen, `http://127.0.0.1:${listenPort}`);
  }

  return candidates;
}

function resolveConnectRetryBudgetMs(env: NodeJS.ProcessEnv): number {
  const raw = nonEmpty(env.PAPERCLIP_API_CONNECT_RETRY_MS);
  if (!raw) return DEFAULT_CONNECT_RETRY_BUDGET_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_CONNECT_RETRY_BUDGET_MS;
  return Math.min(parsed, MAX_CONNECT_RETRY_BUDGET_MS);
}

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaperclipMcpConfig {
  const apiUrlCandidates = resolveApiUrlCandidates(env);
  if (apiUrlCandidates.length === 0) {
    throw new Error(
      "Missing PAPERCLIP_API_URL (and no PAPERCLIP_RUNTIME_API_CANDIDATES_JSON / PAPERCLIP_LISTEN_PORT fallback)",
    );
  }
  const apiKey = nonEmpty(env.PAPERCLIP_API_KEY);
  if (!apiKey) {
    throw new Error("Missing PAPERCLIP_API_KEY");
  }

  return {
    apiUrl: apiUrlCandidates[0],
    apiUrlCandidates,
    apiKey,
    companyId: nonEmpty(env.PAPERCLIP_COMPANY_ID),
    agentId: nonEmpty(env.PAPERCLIP_AGENT_ID),
    runId: nonEmpty(env.PAPERCLIP_RUN_ID),
    connectRetryBudgetMs: resolveConnectRetryBudgetMs(env),
  };
}
