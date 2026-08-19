import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliAuthRateLimiter } from "../services/cli-auth-rate-limit.js";

const mockAccessService = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  hasPermission: vi.fn(),
  canUser: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockBoardAuthService = vi.hoisted(() => ({
  createCliAuthChallenge: vi.fn(),
  describeCliAuthChallenge: vi.fn(),
  approveCliAuthChallenge: vi.fn(),
  cancelCliAuthChallenge: vi.fn(),
  resolveBoardAccess: vi.fn(),
  resolveBoardActivityCompanyIds: vi.fn(),
  assertCurrentBoardKey: vi.fn(),
  revokeBoardApiKey: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  boardAuthService: () => mockBoardAuthService,
  logActivity: mockLogActivity,
  notifyHireApproved: vi.fn(),
  deduplicateAgentName: vi.fn((name: string) => name),
}));

function registerModuleMocks() {
  vi.doMock("../routes/authz.js", async () => vi.importActual("../routes/authz.js"));

  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    boardAuthService: () => mockBoardAuthService,
    logActivity: mockLogActivity,
    notifyHireApproved: vi.fn(),
    deduplicateAgentName: vi.fn((name: string) => name),
  }));
}

let appImportCounter = 0;

async function createApp(
  actor: any,
  db: any = {} as any,
  routeOptions: {
    cliAuthRateLimiter?: ReturnType<typeof createCliAuthRateLimiter>;
    publicUrl?: string | null;
  } = {},
) {
  appImportCounter += 1;
  const routeModulePath = `../routes/access.js?cli-auth-routes-${appImportCounter}`;
  const middlewareModulePath = `../middleware/index.js?cli-auth-routes-${appImportCounter}`;
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import("../routes/access.js")>,
    import(middlewareModulePath) as Promise<typeof import("../middleware/index.js")>,
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
      memberships: Array.isArray(actor.memberships)
        ? actor.memberships.map((membership: unknown) =>
            typeof membership === "object" && membership !== null
              ? { ...membership }
              : membership,
          )
        : actor.memberships,
    };
    next();
  });
  app.use(
    "/api",
    accessRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
      publicUrl: "https://paperclip.example.test",
      ...routeOptions,
    }),
  );
  app.use(errorHandler);
  return app;
}

describe.sequential("cli auth routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.resetAllMocks();
  });

  it.sequential("creates a CLI auth challenge with approval metadata", async () => {
    mockBoardAuthService.createCliAuthChallenge.mockResolvedValue({
      challenge: {
        id: "challenge-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
      challengeSecret: "test_cli_auth_challenge_secret",
    });

    const app = await createApp({ type: "none", source: "none" });
    const res = await request(app)
      .post("/api/cli-auth/challenges")
      .send({
        command: "paperclipai company import",
        clientName: "paperclipai cli",
        requestedAccess: "board",
      });

    expect(res.status, res.text || JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({
      id: "challenge-1",
      token: "test_cli_auth_challenge_secret",
      approvalPath: "/cli-auth/challenge-1?token=test_cli_auth_challenge_secret",
      pollPath: "/cli-auth/challenges/challenge-1",
      expiresAt: "2026-03-23T13:00:00.000Z",
    });
    expect(res.body).not.toHaveProperty("boardApiToken");
    expect(res.body.approvalUrl).toContain("/cli-auth/challenge-1?token=test_cli_auth_challenge_secret");
  });

  it.sequential("builds approval URLs from the configured public URL", async () => {
    mockBoardAuthService.createCliAuthChallenge.mockResolvedValue({
      challenge: {
        id: "challenge-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
      challengeSecret: "test_cli_auth_challenge_secret",
    });

    const app = await createApp(
      { type: "none", source: "none" },
      {} as any,
      { publicUrl: "https://trusted.paperclip.example.test" },
    );
    const res = await request(app)
      .post("/api/cli-auth/challenges")
      .set("Host", "attacker.example.test")
      .set("X-Forwarded-Host", "attacker.example.test")
      .send({
        command: "paperclipai company import",
        clientName: "paperclipai cli",
        requestedAccess: "board",
      });

    expect(res.status).toBe(201);
    expect(res.body.approvalUrl).toBe(
      "https://trusted.paperclip.example.test/cli-auth/challenge-1?token=test_cli_auth_challenge_secret",
    );
  });

  it.sequential("rate limits challenge creation by client IP", async () => {
    mockBoardAuthService.createCliAuthChallenge.mockResolvedValue({
      challenge: {
        id: "challenge-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
      challengeSecret: "test_cli_auth_challenge_secret",
    });

    const app = await createApp(
      { type: "none", source: "none" },
      {} as any,
      {
        cliAuthRateLimiter: createCliAuthRateLimiter({
          maxRequests: 1,
          windowMs: 60_000,
          now: () => 1_000,
        }),
      },
    );
    const body = {
      command: "paperclipai company import",
      clientName: "paperclipai cli",
      requestedAccess: "board",
    };

    await request(app).post("/api/cli-auth/challenges").send(body).expect(201);
    const limited = await request(app).post("/api/cli-auth/challenges").send(body).expect(429);

    expect(mockBoardAuthService.createCliAuthChallenge).toHaveBeenCalledTimes(1);
    expect(limited.body).toMatchObject({
      error: "CLI auth challenge rate limit exceeded",
      retryAfterSeconds: 60,
    });
    expect(limited.headers["retry-after"]).toBe("60");
  });

  it.sequential("rejects anonymous access to generic skill documents", async () => {
    const indexApp = await createApp({ type: "none", source: "none" });
    const skillApp = await createApp({ type: "none", source: "none" });

    const indexRes = await request(indexApp).get("/api/skills/index");
    const skillRes = await request(skillApp).get("/api/skills/paperclip");

    expect(indexRes.status, JSON.stringify(indexRes.body)).toBe(401);
    expect(skillRes.status, skillRes.text || JSON.stringify(skillRes.body)).toBe(401);
  });

  it.sequential("serves the invite-scoped paperclip skill anonymously for active invites", async () => {
    const invite = {
      id: "invite-1",
      companyId: "company-1",
      inviteType: "company_join",
      allowedJoinTypes: "agent",
      tokenHash: "hash",
      defaultsPayload: null,
      expiresAt: new Date(Date.now() + 60_000),
      invitedByUserId: null,
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([invite]),
        })),
      })),
    };

    const app = await createApp({ type: "none", source: "none" }, db);
    const res = await request(app).get("/api/invites/token-123/skills/paperclip");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.text).toContain("# Paperclip Skill");
  });

  it.sequential("marks challenge status as requiring sign-in for anonymous viewers", async () => {
    mockBoardAuthService.describeCliAuthChallenge.mockResolvedValue({
      id: "challenge-1",
      status: "pending",
      command: "paperclipai company import",
      clientName: "paperclipai cli",
      requestedAccess: "board",
      requestedCompanyId: null,
      requestedCompanyName: null,
      approvedAt: null,
      cancelledAt: null,
      expiresAt: "2026-03-23T13:00:00.000Z",
      approvedByUser: null,
    });

    const app = await createApp({ type: "none", source: "none" });
    const res = await request(app).get("/api/cli-auth/challenges/challenge-1?token=test_cli_auth_challenge_secret");

    expect(res.status).toBe(200);
    expect(res.body.requiresSignIn).toBe(true);
    expect(res.body.canApprove).toBe(false);
    expect(res.body).not.toHaveProperty("boardApiToken");
  });

  it.sequential("does not produce a credential for an unapproved challenge", async () => {
    mockBoardAuthService.createCliAuthChallenge.mockResolvedValue({
      challenge: {
        id: "challenge-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
      challengeSecret: "test_cli_auth_challenge_secret",
    });
    mockBoardAuthService.describeCliAuthChallenge.mockResolvedValue({
      id: "challenge-1",
      status: "pending",
      command: "paperclipai company import",
      clientName: "paperclipai cli",
      requestedAccess: "board",
      requestedCompanyId: null,
      requestedCompanyName: null,
      approvedAt: null,
      cancelledAt: null,
      expiresAt: "2026-03-23T13:00:00.000Z",
      approvedByUser: null,
    });

    const app = await createApp({ type: "none", source: "none" });
    const created = await request(app)
      .post("/api/cli-auth/challenges")
      .send({
        command: "paperclipai company import",
        clientName: "paperclipai cli",
        requestedAccess: "board",
      })
      .expect(201);
    const polled = await request(app)
      .get("/api/cli-auth/challenges/challenge-1?token=test_cli_auth_challenge_secret")
      .expect(200);

    expect(created.body).not.toHaveProperty("boardApiToken");
    expect(polled.body).not.toHaveProperty("boardApiToken");
  });

  it.sequential("only returns the board API token after human approval", async () => {
    mockBoardAuthService.describeCliAuthChallenge.mockResolvedValue({
      id: "challenge-1",
      status: "approved",
      command: "paperclipai company import",
      clientName: "paperclipai cli",
      requestedAccess: "board",
      requestedCompanyId: null,
      requestedCompanyName: null,
      approvedAt: "2026-03-23T12:05:00.000Z",
      cancelledAt: null,
      expiresAt: "2026-03-23T13:00:00.000Z",
      approvedByUser: { id: "user-1", name: "User One", email: "user@example.com" },
      boardApiToken: "test_board_api_token_after_approval",
    });

    const app = await createApp({ type: "none", source: "none" });
    const res = await request(app).get("/api/cli-auth/challenges/challenge-1?token=test_cli_auth_challenge_secret");

    expect(res.status).toBe(200);
    expect(res.body.boardApiToken).toBe("test_board_api_token_after_approval");
  });

  it.sequential("approves a CLI auth challenge for a signed-in board user", async () => {
    mockBoardAuthService.approveCliAuthChallenge.mockResolvedValue({
      status: "approved",
      challenge: {
        id: "challenge-1",
        boardApiKeyId: "board-key-1",
        requestedAccess: "board",
        requestedCompanyId: "company-1",
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    });
    mockBoardAuthService.resolveBoardAccess.mockResolvedValue({
      user: { id: "user-1", name: "User One", email: "user@example.com" },
      companyIds: ["company-1"],
      isInstanceAdmin: false,
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["company-1"]);

    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "session",
      isInstanceAdmin: false,
      companyIds: ["company-1"],
    });
    const res = await request(app)
      .post("/api/cli-auth/challenges/challenge-1/approve")
      .send({ token: "test_cli_auth_challenge_secret" });

    expect(res.status).toBe(200);
    expect(mockBoardAuthService.approveCliAuthChallenge).toHaveBeenCalledWith(
      "challenge-1",
      "test_cli_auth_challenge_secret",
      "user-1",
    );
    expect(mockLogActivity).toHaveBeenCalledTimes(1);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-1",
        action: "board_api_key.created",
      }),
    );
  });

  it.sequential("logs approve activity for instance admins without company memberships", async () => {
    mockBoardAuthService.approveCliAuthChallenge.mockResolvedValue({
      status: "approved",
      challenge: {
        id: "challenge-2",
        boardApiKeyId: "board-key-2",
        requestedAccess: "instance_admin_required",
        requestedCompanyId: null,
        expiresAt: new Date("2026-03-23T13:00:00.000Z"),
      },
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["company-a", "company-b"]);

    const app = await createApp({
      type: "board",
      userId: "admin-1",
      source: "session",
      isInstanceAdmin: true,
      companyIds: [],
    });
    const res = await request(app)
      .post("/api/cli-auth/challenges/challenge-2/approve")
      .send({ token: "test_cli_auth_challenge_secret" });

    expect(res.status).toBe(200);
    expect(mockBoardAuthService.resolveBoardActivityCompanyIds).toHaveBeenCalledWith({
      userId: "admin-1",
      requestedCompanyId: null,
      boardApiKeyId: "board-key-2",
    });
    expect(mockLogActivity).toHaveBeenCalledTimes(2);
  });

  it.sequential("logs revoke activity with resolved audit company ids", async () => {
    mockBoardAuthService.assertCurrentBoardKey.mockResolvedValue({
      id: "board-key-3",
      userId: "admin-2",
    });
    mockBoardAuthService.resolveBoardActivityCompanyIds.mockResolvedValue(["company-z"]);

    const app = await createApp({
      type: "board",
      userId: "admin-2",
      keyId: "board-key-3",
      source: "board_key",
      isInstanceAdmin: true,
      companyIds: [],
    });
    const res = await request(app).post("/api/cli-auth/revoke-current").send({});

    expect(res.status).toBe(200);
    expect(mockBoardAuthService.resolveBoardActivityCompanyIds).toHaveBeenCalledWith({
      userId: "admin-2",
      boardApiKeyId: "board-key-3",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        companyId: "company-z",
        action: "board_api_key.revoked",
      }),
    );
  });
});
