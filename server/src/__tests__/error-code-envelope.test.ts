import type { NextFunction, Request, Response } from "express";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ERROR_CODES } from "../errors.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { errorHandler } from "../middleware/error-handler.js";
import { privateHostnameGuard } from "../middleware/private-hostname-guard.js";
import { assertBoard, assertCompanyAccess } from "../routes/authz.js";

function makeResponse() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

function makeRequest(actor: Request["actor"], method = "GET") {
  return {
    method,
    actor,
    originalUrl: "/api/test",
    body: {},
    params: {},
    query: {},
  } as unknown as Request;
}

function responseForAssertion(assertion: () => void) {
  let thrown: unknown;
  try {
    assertion();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();

  const res = makeResponse();
  errorHandler(thrown, makeRequest({ type: "none" }), res, vi.fn() as unknown as NextFunction);
  return (res.json as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
    error: string;
    code?: string;
  };
}

describe("stable error code envelope", () => {
  it("keeps the human message while distinguishing the six documented 403 cases", async () => {
    const boardAccess = responseForAssertion(() =>
      assertBoard(makeRequest({ type: "agent", agentId: "agent-1" })),
    );
    const viewerAccess = responseForAssertion(() =>
      assertCompanyAccess(
        makeRequest(
          {
            type: "board",
            source: "session",
            companyIds: ["company-1"],
            memberships: [
              { companyId: "company-1", membershipRole: "viewer", status: "active" },
            ],
          },
          "PATCH",
        ),
        "company-1",
      ),
    );
    const inactiveMembership = responseForAssertion(() =>
      assertCompanyAccess(
        makeRequest(
          {
            type: "board",
            source: "session",
            companyIds: ["company-1"],
            memberships: [
              { companyId: "company-1", membershipRole: "operator", status: "inactive" },
            ],
          },
          "POST",
        ),
        "company-1",
      ),
    );
    const crossCompanyAgent = responseForAssertion(() =>
      assertCompanyAccess(
        makeRequest({ type: "agent", agentId: "agent-1", companyId: "company-2" }),
        "company-1",
      ),
    );

    const boardOrigin = await boardOriginError();
    const blockedHostname = await blockedHostnameError();
    const responses = [
      boardAccess,
      viewerAccess,
      inactiveMembership,
      crossCompanyAgent,
      boardOrigin,
      blockedHostname,
    ];

    expect(responses.map((response) => response.error)).toEqual([
      "Board access required",
      "Viewer access is read-only",
      "User does not have active company access",
      "Agent key cannot access another company",
      "Board mutation requires trusted browser origin",
      expect.stringContaining("Hostname 'blocked-host.invalid' is not allowed"),
    ]);

    const codes = responses.map((response) => response.code);
    expect(codes).toEqual([
      ERROR_CODES.boardAccessRequired,
      ERROR_CODES.viewerAccessReadOnly,
      ERROR_CODES.companyMembershipInactive,
      ERROR_CODES.agentCrossCompanyAccess,
      ERROR_CODES.trustedBrowserOriginRequired,
      ERROR_CODES.hostnameNotAllowed,
    ]);
    expect(new Set(codes).size).toBe(6);
  });
});

async function boardOriginError() {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "user-1", source: "session" };
    next();
  });
  app.use(boardMutationGuard());
  app.post("/mutate", (_req, res) => res.status(204).end());

  const response = await request(app).post("/mutate");
  expect(response.status).toBe(403);
  return response.body as { error: string; code?: string };
}

async function blockedHostnameError() {
  const app = express();
  app.use(
    privateHostnameGuard({
      enabled: true,
      allowedHostnames: [],
      bindHost: "0.0.0.0",
    }),
  );
  app.get("/api/health", (_req, res) => res.status(200).json({ status: "ok" }));

  const response = await request(app)
    .get("/api/health")
    .set("Host", "blocked-host.invalid:3100")
    .set("Accept", "application/json");
  expect(response.status).toBe(403);
  return response.body as { error: string; code?: string };
}
