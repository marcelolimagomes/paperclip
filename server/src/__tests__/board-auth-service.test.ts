import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boardAuthService,
  createBoardApiTokenForCliChallenge,
  hashBearerToken,
} from "../services/board-auth.js";

const originalBetterAuthSecret = process.env.BETTER_AUTH_SECRET;

afterEach(() => {
  if (originalBetterAuthSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = originalBetterAuthSecret;
});

describe("board CLI auth service", () => {
  it("stores only the challenge-derived board token hash until approval", async () => {
    process.env.BETTER_AUTH_SECRET = Buffer.alloc(32, 0x42).toString("hex");
    const challengeRow = {
      id: "challenge-1",
      expiresAt: new Date("2026-03-23T13:00:00.000Z"),
    };
    const returning = vi.fn().mockResolvedValue([challengeRow]);
    const values = vi.fn((_input: Record<string, unknown>) => ({ returning }));
    const db = {
      insert: () => ({ values }),
    };

    const created = await boardAuthService(db as never).createCliAuthChallenge({
      command: "paperclipai company import",
      requestedAccess: "board",
    });
    const inserted = values.mock.calls[0]?.[0] as Record<string, unknown> | undefined;

    expect(created).toEqual({
      challenge: challengeRow,
      challengeSecret: expect.stringMatching(/^pcp_cli_auth_/),
    });
    expect(inserted?.pendingKeyHash).toBe(
      hashBearerToken(createBoardApiTokenForCliChallenge(created.challengeSecret)),
    );
    expect(created).not.toHaveProperty("pendingBoardToken");
  });

  it("derives the same board token used by the approval hash without exposing it", () => {
    process.env.BETTER_AUTH_SECRET = Buffer.alloc(32, 0x42).toString("hex");
    const challengeSecret = "test_cli_auth_challenge_secret";
    const boardToken = createBoardApiTokenForCliChallenge(challengeSecret);

    expect(boardToken).toMatch(/^pcp_board_[a-f0-9]{64}$/);
    expect(hashBearerToken(boardToken)).toBe(hashBearerToken(createBoardApiTokenForCliChallenge(challengeSecret)));
  });
});
