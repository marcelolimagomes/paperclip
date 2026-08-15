import { describe, expect, it } from "vitest";
import { readConfigFromEnv, resolveApiUrlCandidates } from "./config.js";

describe("resolveApiUrlCandidates", () => {
  it("keeps the configured URL first and appends the loopback failover", () => {
    expect(
      resolveApiUrlCandidates({
        PAPERCLIP_API_URL: "https://paperclip.taskblu.com",
        PAPERCLIP_LISTEN_HOST: "127.0.0.1",
        PAPERCLIP_LISTEN_PORT: "3100",
      }),
    ).toEqual(["https://paperclip.taskblu.com/api", "http://127.0.0.1:3100/api"]);
  });

  it("includes the propagated runtime candidate list", () => {
    expect(
      resolveApiUrlCandidates({
        PAPERCLIP_API_URL: "https://paperclip.taskblu.com",
        PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: JSON.stringify([
          "https://paperclip.taskblu.com",
          "http://192.168.1.10:3100",
        ]),
        PAPERCLIP_LISTEN_HOST: "127.0.0.1",
        PAPERCLIP_LISTEN_PORT: "3100",
      }),
    ).toEqual([
      "https://paperclip.taskblu.com/api",
      "http://192.168.1.10:3100/api",
      "http://127.0.0.1:3100/api",
    ]);
  });

  it("resolves a wildcard listen host to a dialable loopback address", () => {
    expect(
      resolveApiUrlCandidates({
        PAPERCLIP_API_URL: "https://paperclip.taskblu.com",
        PAPERCLIP_LISTEN_HOST: "0.0.0.0",
        PAPERCLIP_LISTEN_PORT: "3100",
      }),
    ).toEqual(["https://paperclip.taskblu.com/api", "http://127.0.0.1:3100/api"]);
  });

  it("brackets an IPv6 listen host", () => {
    expect(
      resolveApiUrlCandidates({
        PAPERCLIP_LISTEN_HOST: "::1",
        PAPERCLIP_LISTEN_PORT: "3100",
      }),
    ).toEqual(["http://[::1]:3100/api", "http://127.0.0.1:3100/api"]);
  });

  it("ignores malformed candidate payloads", () => {
    expect(
      resolveApiUrlCandidates({
        PAPERCLIP_API_URL: "https://paperclip.taskblu.com",
        PAPERCLIP_RUNTIME_API_CANDIDATES_JSON: "not json",
      }),
    ).toEqual(["https://paperclip.taskblu.com/api"]);
  });
});

describe("readConfigFromEnv", () => {
  it("derives an endpoint from the listen host when PAPERCLIP_API_URL is absent", () => {
    const config = readConfigFromEnv({
      PAPERCLIP_API_KEY: "token-123",
      PAPERCLIP_LISTEN_HOST: "127.0.0.1",
      PAPERCLIP_LISTEN_PORT: "3100",
    });

    expect(config.apiUrl).toBe("http://127.0.0.1:3100/api");
    expect(config.apiUrlCandidates).toEqual(["http://127.0.0.1:3100/api"]);
  });

  it("throws when there is no endpoint at all", () => {
    expect(() => readConfigFromEnv({ PAPERCLIP_API_KEY: "token-123" })).toThrow(
      /Missing PAPERCLIP_API_URL/,
    );
  });

  it("honours a bounded connect-retry override", () => {
    const config = readConfigFromEnv({
      PAPERCLIP_API_KEY: "token-123",
      PAPERCLIP_API_URL: "http://127.0.0.1:3100",
      PAPERCLIP_API_CONNECT_RETRY_MS: "5000",
    });

    expect(config.connectRetryBudgetMs).toBe(5000);
  });
});
