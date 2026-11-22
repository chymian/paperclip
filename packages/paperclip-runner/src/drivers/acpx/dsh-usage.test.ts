import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createDshPromptUsageCollector, dshPrice } from "./dsh-usage.js";
import { persistedAcpxTurnUsage } from "./usage-accounting.js";

const request = { jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "s-main" } };
const response = { jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } };
const reply = (turn: number, seq: number, input: number, output: number, cacheRead = 0) => ({
  type: "assistant/message", seq, time: seq,
  data: { turn, step: 1, usage: { inputTokens: input, outputTokens: output, totalTokens: input + output, cacheReadTokens: cacheRead } },
});

function writeLog(home: string, sessionId: string, events: unknown[]): void {
  const dir = join(home, "sessions", "--workspace--", sessionId);
  mkdirSync(dir, { recursive: true });
  const lines = [{ type: "session", version: 4, id: sessionId }, ...events].map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(join(dir, "session.v4.jsonl.zstd"), zstdCompressSync(Buffer.from(lines)));
}

function turn(collector: ReturnType<typeof createDshPromptUsageCollector>, requestId: string, wireId = 3) {
  collector.begin(requestId, "s-main");
  collector.observe("outbound", { ...request, id: wireId });
  collector.observe("inbound", { ...response, id: wireId });
}

describe("DSH terminal prompt usage", () => {
  it("sums the turn's model calls, including subagent sessions, and nothing from earlier turns", () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-usage-"));
    writeLog(home, "s-main", [reply(1, 2, 100, 10)]);
    const collector = createDshPromptUsageCollector(home, {});
    collector.begin("req-2", "s-main");
    collector.observe("outbound", request);
    writeLog(home, "s-main", [reply(1, 2, 100, 10), reply(2, 5, 1000, 50, 400), reply(2, 7, 1200, 60)]);
    writeLog(home, "s-sub", [reply(1, 2, 300, 30)]);
    collector.observe("inbound", response);
    const receipt = collector.snapshot();
    expect(receipt?.requestId).toBe("req-2");
    expect(receipt?.event).toEqual({
      type: "status", tag: "usage_update", text: "terminal prompt usage",
      breakdown: { inputTokens: 2500, outputTokens: 140, totalTokens: 2640, cachedReadTokens: 400, cachedWriteTokens: 0, thoughtTokens: 0 },
    });
    expect(persistedAcpxTurnUsage({ lastRequestId: "req-1" }, { lastRequestId: "req-2", terminalPromptUsage: receipt }, "req-2", "dsh"))
      .toEqual(receipt?.event);
  });

  it("prices the turn only when the operator configured a price", () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-usage-"));
    const collector = createDshPromptUsageCollector(home, { PAPERCLIP_DSH_PROVIDER_PRICE_USD_PER_MTOK: "2,8" });
    collector.begin("req-1", "s-main");
    collector.observe("outbound", request);
    writeLog(home, "s-main", [reply(1, 2, 1_000_000, 500_000)]);
    collector.observe("inbound", response);
    expect(collector.snapshot()?.event.cost).toEqual({ amount: 6, currency: "USD", basis: "turn" });
    const free = createDshPromptUsageCollector(home, { PAPERCLIP_DSH_PROVIDER_PRICE_USD_PER_MTOK: "0,0" });
    turn(free, "req-2", 4);
    expect(free.snapshot()).toBeNull(); // no new model call in this turn: no receipt
  });

  it("reports a free provider as cost 0, not as unpriced", () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-usage-"));
    const collector = createDshPromptUsageCollector(home, { PAPERCLIP_DSH_PROVIDER_PRICE_USD_PER_MTOK: "0,0" });
    collector.begin("req-1", "s-main");
    collector.observe("outbound", request);
    writeLog(home, "s-main", [reply(1, 2, 10, 5)]);
    collector.observe("inbound", response);
    expect(collector.snapshot()?.event.cost).toEqual({ amount: 0, currency: "USD", basis: "turn" });
  });

  it("stays unknown when the prompt failed, never completed, or the log is unreadable", () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-usage-"));
    const failed = createDshPromptUsageCollector(home, {});
    failed.begin("req-1", "s-main");
    failed.observe("outbound", request);
    writeLog(home, "s-main", [reply(1, 2, 10, 5)]);
    failed.observe("inbound", { jsonrpc: "2.0", id: 3, error: { code: -32603, message: "x" } });
    expect(failed.snapshot()).toBeNull();

    const open = createDshPromptUsageCollector(home, {});
    open.begin("req-2", "s-main");
    open.observe("outbound", request);
    expect(open.snapshot()).toBeNull();

    const broken = createDshPromptUsageCollector(home, {});
    broken.begin("req-3", "s-main");
    broken.observe("outbound", request);
    writeFileSync(join(home, "sessions", "--workspace--", "s-main", "session.v4.jsonl.zstd"), Buffer.from("not zstd"));
    broken.observe("inbound", response);
    expect(broken.snapshot()).toBeNull();

    expect(createDshPromptUsageCollector(undefined, {}).snapshot()).toBeNull();
  });

  it("parses only a valid input,output price", () => {
    expect(dshPrice({ PAPERCLIP_DSH_PROVIDER_PRICE_USD_PER_MTOK: "0.27,1.1" })).toEqual({ input: 0.27, output: 1.1 });
    for (const bad of [undefined, "", "1", "a,b", "-1,2", "1,2,3"]) {
      expect(dshPrice({ PAPERCLIP_DSH_PROVIDER_PRICE_USD_PER_MTOK: bad })).toBeNull();
    }
  });
});
