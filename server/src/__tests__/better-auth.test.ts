import { afterEach, describe, expect, it } from "vitest";
import type { BetterAuthOptions } from "better-auth";
import { getCookies } from "better-auth/cookies";
import {
  buildBetterAuthAdvancedOptions,
  buildKeycloakProvider,
  deriveAuthCookiePrefix,
  deriveAuthTrustedOrigins,
} from "../auth/better-auth.js";

const ORIGINAL_INSTANCE_ID = process.env.PAPERCLIP_INSTANCE_ID;

afterEach(() => {
  if (ORIGINAL_INSTANCE_ID === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
  else process.env.PAPERCLIP_INSTANCE_ID = ORIGINAL_INSTANCE_ID;
});

describe("Better Auth cookie scoping", () => {
  it("derives an instance-scoped cookie prefix", () => {
    expect(deriveAuthCookiePrefix("default")).toBe("paperclip-default");
    expect(deriveAuthCookiePrefix("PAP-1601-worktree")).toBe("paperclip-PAP-1601-worktree");
  });

  it("uses PAPERCLIP_INSTANCE_ID for the Better Auth cookie prefix", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "sat-worktree";

    const advanced = buildBetterAuthAdvancedOptions({ disableSecureCookies: false });

    expect(advanced).toEqual({
      cookiePrefix: "paperclip-sat-worktree",
    });
    expect(getCookies({ advanced } as BetterAuthOptions).sessionToken.name).toBe(
      "paperclip-sat-worktree.session_token",
    );
  });

  it("keeps local http auth cookies non-secure while preserving the scoped prefix", () => {
    process.env.PAPERCLIP_INSTANCE_ID = "pap-worktree";

    expect(buildBetterAuthAdvancedOptions({ disableSecureCookies: true })).toEqual({
      cookiePrefix: "paperclip-pap-worktree",
      useSecureCookies: false,
    });
  });

  it("adds hostname port variants for authenticated mode on non-default ports", () => {
    const trustedOrigins = deriveAuthTrustedOrigins({
      deploymentMode: "authenticated",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      allowedHostnames: ["Board.Example.Test"],
      port: 3101,
    } as Parameters<typeof deriveAuthTrustedOrigins>[0]);

    expect(trustedOrigins).toEqual(expect.arrayContaining([
      "https://board.example.test",
      "http://board.example.test",
      "https://board.example.test:3101",
      "http://board.example.test:3101",
    ]));
  });

  it("prefers an explicit resolved listen port over the configured port", () => {
    const trustedOrigins = deriveAuthTrustedOrigins({
      deploymentMode: "authenticated",
      authBaseUrlMode: "auto",
      authPublicBaseUrl: undefined,
      allowedHostnames: ["board.example.test"],
      port: 3100,
    } as Parameters<typeof deriveAuthTrustedOrigins>[0], { listenPort: 3101 });

    expect(trustedOrigins).toEqual(expect.arrayContaining([
      "https://board.example.test:3101",
      "http://board.example.test:3101",
    ]));
    expect(trustedOrigins).not.toContain("https://board.example.test:3100");
    expect(trustedOrigins).not.toContain("http://board.example.test:3100");
  });
});

describe("Keycloak OIDC provider (Taskblu fork, ADR-012)", () => {
  const KEYS = [
    "PAPERCLIP_OIDC_ISSUER",
    "PAPERCLIP_OIDC_CLIENT_ID",
    "PAPERCLIP_OIDC_PROVIDER_ID",
  ] as const;
  const ORIGINAL = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of KEYS) {
      if (ORIGINAL[key] === undefined) delete process.env[key];
      else process.env[key] = ORIGINAL[key];
    }
  });

  it("stays absent until both variables are set", () => {
    delete process.env.PAPERCLIP_OIDC_ISSUER;
    delete process.env.PAPERCLIP_OIDC_CLIENT_ID;
    expect(buildKeycloakProvider()).toBeNull();

    process.env.PAPERCLIP_OIDC_ISSUER = "https://auth.taskblu.com/realms/taskblu";
    expect(buildKeycloakProvider()).toBeNull();
  });

  it("derives discovery from the issuer and trims the trailing slash", () => {
    process.env.PAPERCLIP_OIDC_ISSUER = "https://auth.taskblu.com/realms/taskblu/";
    process.env.PAPERCLIP_OIDC_CLIENT_ID = "taskblu-paperclip";
    expect(buildKeycloakProvider()).toMatchObject({
      providerId: "keycloak",
      discoveryUrl:
        "https://auth.taskblu.com/realms/taskblu/.well-known/openid-configuration",
      clientId: "taskblu-paperclip",
      pkce: true,
    });
  });

  it("carries no client secret and no basic authentication", () => {
    // Public client with PKCE. `authentication: "basic"` would send
    // `Basic base64(clientId + ":")` when no secret exists -- an empty password
    // rather than no authentication -- and Keycloak rejects it while the
    // configuration still reads as correct.
    process.env.PAPERCLIP_OIDC_ISSUER = "https://auth.taskblu.com/realms/taskblu";
    process.env.PAPERCLIP_OIDC_CLIENT_ID = "taskblu-paperclip";
    const provider = buildKeycloakProvider();
    expect(provider).not.toBeNull();
    expect(provider).not.toHaveProperty("clientSecret");
    expect(provider).not.toHaveProperty("authentication");
  });
});
