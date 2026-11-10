import { describe, expect, it } from "vitest";
import { agentAvatarWorkerLaunch } from "./agent-avatar-pool.js";

const compiled = "file:///app/server/dist/services/agent-avatar-pool.js";
const source = "file:///repo/server/src/services/agent-avatar-pool.ts";
const tsShared = () => "file:///app/packages/shared/src/index.ts";
const jsShared = () => "file:///app/node_modules/@paperclipai/shared/dist/index.js";

describe("agent avatar worker launch (no esbuild child in production workers)", () => {
  it("prefers the worker bundled next to the runtime bundle", () => {
    expect(agentAvatarWorkerLaunch({ moduleUrl: compiled, execArgv: [], exists: () => true, sharedEntry: tsShared }))
      .toEqual({ kind: "file", url: new URL("file:///app/server/dist-runtime/agent-avatar-worker.mjs") });
  });

  it("loads the compiled worker directly when workspace imports resolve to JavaScript", () => {
    expect(agentAvatarWorkerLaunch({ moduleUrl: compiled, execArgv: [], exists: () => false, sharedEntry: jsShared }))
      .toEqual({ kind: "file", url: new URL("file:///app/server/dist/services/agent-avatar-worker.js") });
    expect(agentAvatarWorkerLaunch({ moduleUrl: compiled, execArgv: ["--import", "tsx"], exists: () => false, sharedEntry: tsShared }).kind).toBe("file");
  });

  it("keeps tsx only where nothing else can run the TypeScript", () => {
    expect(agentAvatarWorkerLaunch({ moduleUrl: compiled, execArgv: [], exists: () => false, sharedEntry: tsShared }).kind).toBe("tsx");
    expect(agentAvatarWorkerLaunch({ moduleUrl: source, execArgv: [], exists: () => true, sharedEntry: tsShared }).kind).toBe("tsx");
    expect(agentAvatarWorkerLaunch({ moduleUrl: source, execArgv: ["--import", "tsx"], exists: () => true, sharedEntry: tsShared }))
      .toEqual({ kind: "file", url: new URL("file:///repo/server/src/services/agent-avatar-worker.ts") });
  });
});
