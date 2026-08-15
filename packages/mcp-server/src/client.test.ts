import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PaperclipApiClient,
  PaperclipApiError,
  PaperclipApiUnreachableError,
} from "./client.js";

const PUBLIC_API = "https://paperclip.taskblu.com/api";
const LOOPBACK_API = "http://127.0.0.1:3100/api";

function makeClient(overrides: { connectRetryBudgetMs?: number } = {}) {
  const sleep = vi.fn(async (_ms: number) => {});
  let clock = 0;
  const client = new PaperclipApiClient(
    {
      apiUrl: PUBLIC_API,
      apiUrlCandidates: [PUBLIC_API, LOOPBACK_API],
      apiKey: "token-123",
      companyId: "11111111-1111-1111-1111-111111111111",
      agentId: "22222222-2222-2222-2222-222222222222",
      runId: "33333333-3333-3333-3333-333333333333",
      connectRetryBudgetMs: overrides.connectRetryBudgetMs ?? 15_000,
    },
    {
      sleep: async (ms) => {
        clock += ms;
        await sleep(ms);
      },
      now: () => clock,
    },
  );
  return { client, sleep };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function cloudflareAccessRedirect() {
  return new Response(null, {
    status: 302,
    headers: {
      location:
        "https://still-dust-ef57.cloudflareaccess.com/cdn-cgi/access/login/paperclip.taskblu.com",
    },
  });
}

function connectionRefused() {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });
  return error;
}

function requestedUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

describe("PaperclipApiClient endpoint failover", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fails over to loopback when the public host is gated by Cloudflare Access", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(cloudflareAccessRedirect())
      .mockResolvedValueOnce(jsonResponse({ id: "issue-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const { client } = makeClient();
    const result = await client.requestJson<{ id: string }>("GET", "/issues/issue-1");

    expect(result).toEqual({ id: "issue-1" });
    expect(requestedUrls(fetchMock)).toEqual([
      "https://paperclip.taskblu.com/api/issues/issue-1",
      "http://127.0.0.1:3100/api/issues/issue-1",
    ]);
  });

  it("does not follow the access-gate redirect", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(cloudflareAccessRedirect())
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { client } = makeClient();
    await client.requestJson("GET", "/issues");

    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "manual" });
  });

  it("pins the working endpoint so failover is paid once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(cloudflareAccessRedirect())
      .mockImplementation(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { client } = makeClient();
    await client.requestJson("GET", "/issues");
    await client.requestJson("GET", "/issues");

    expect(requestedUrls(fetchMock)).toEqual([
      "https://paperclip.taskblu.com/api/issues",
      "http://127.0.0.1:3100/api/issues",
      "http://127.0.0.1:3100/api/issues",
    ]);
  });

  it("retries within a bounded window while the server restarts", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(connectionRefused())
      .mockRejectedValueOnce(connectionRefused())
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { client, sleep } = makeClient();
    await expect(client.requestJson("GET", "/issues")).resolves.toEqual({ ok: true });
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("gives up with an unreachable error once the retry budget is exhausted", async () => {
    const fetchMock = vi.fn().mockRejectedValue(connectionRefused());
    vi.stubGlobal("fetch", fetchMock);

    const { client } = makeClient({ connectRetryBudgetMs: 600 });
    await expect(client.requestJson("GET", "/issues")).rejects.toBeInstanceOf(
      PaperclipApiUnreachableError,
    );
  });

  it("retries a write only when the request provably never landed", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(connectionRefused())
      .mockRejectedValueOnce(connectionRefused())
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { client } = makeClient();
    await expect(
      client.requestJson("POST", "/issues/issue-1/comments", { body: { body: "hi" } }),
    ).resolves.toEqual({ ok: true });
  });

  it("never replays a write whose fate is unknown", async () => {
    const midFlight = new TypeError("terminated");
    (midFlight as { cause?: unknown }).cause = Object.assign(new Error("socket hang up"), {
      code: "ECONNRESET",
    });
    const fetchMock = vi.fn().mockRejectedValue(midFlight);
    vi.stubGlobal("fetch", fetchMock);

    const { client } = makeClient();
    await expect(
      client.requestJson("POST", "/issues/issue-1/comments", { body: { body: "hi" } }),
    ).rejects.toBeInstanceOf(PaperclipApiUnreachableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats a real API error as an answer, not a reason to fail over", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "not found" }, 404));
    vi.stubGlobal("fetch", fetchMock);

    const { client } = makeClient();
    await expect(client.requestJson("GET", "/issues/missing")).rejects.toBeInstanceOf(
      PaperclipApiError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails over when a gateway answers for a down origin", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { client } = makeClient();
    await expect(client.requestJson("GET", "/issues")).resolves.toEqual({ ok: true });
  });

  it("works with a single-endpoint config", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new PaperclipApiClient({
      apiUrl: LOOPBACK_API,
      apiKey: "token-123",
      companyId: null,
      agentId: null,
      runId: null,
    });

    await expect(client.requestJson("GET", "/issues")).resolves.toEqual({ ok: true });
    expect(client.apiUrlCandidates).toEqual([LOOPBACK_API]);
  });
});
