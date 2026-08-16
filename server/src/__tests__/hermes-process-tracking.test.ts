import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { execute } from "hermes-paperclip-adapter/server";

describe("Hermes process tracking", () => {
  it("forwards onSpawn to the managed child process", async () => {
    const onSpawn = vi.fn(async () => undefined);
    const fixtureDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "hermes-cli",
    );

    await execute({
      runId: "run-123",
      agent: {
        id: "agent-123",
        companyId: "company-123",
        name: "Hermes",
        role: "engineer",
        adapterType: "hermes_local",
        adapterConfig: {
          cwd: fixtureDir,
          hermesCommand: process.execPath,
          timeoutSec: 5,
        },
      },
      runtime: {},
      config: {},
      context: {},
      onLog: async () => undefined,
      onMeta: async () => undefined,
      onSpawn,
    } as Parameters<typeof execute>[0]);

    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(onSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: expect.any(Number),
        startedAt: expect.any(String),
      }),
    );
  });
});
