import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { TerminalPromptUsage } from "./grok-usage.js";

// DSH's ACP server returns no token usage (prompt result is only `stopReason`,
// `usage_update` is context occupancy). DSH writes every model call with its
// token counts to `$DSH_HOME/sessions/**/session.v4.jsonl.zstd`, subagent
// sessions included. A turn's receipt is the model calls that appeared in
// those logs between prompt start and the prompt's successful response.

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const count = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
const LOG = "session.v4.jsonl.zstd";
export const DSH_PRICE_ENV = "PAPERCLIP_DSH_PROVIDER_PRICE_USD_PER_MTOK";

interface Call { input: number; output: number; total: number; cacheRead: number }

/** Operator price "input,output" in USD per million tokens; anything else is unpriced. */
export function dshPrice(env: Readonly<NodeJS.ProcessEnv>): { input: number; output: number } | null {
  const parts = (env[DSH_PRICE_ENV] ?? "").split(",");
  if (parts.length !== 2 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p.trim()))) return null;
  return { input: Number(parts[0]), output: Number(parts[1]) };
}

/** Every model call in every session log under the DSH home, keyed by session id and sequence. Throws on an unreadable log. */
function ledger(home: string): Map<string, Call> {
  const calls = new Map<string, Call>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === LOG) {
        let session = "";
        for (const line of zstdDecompressSync(readFileSync(path)).toString("utf8").split("\n")) {
          if (!line) continue;
          const event = record(JSON.parse(line));
          if (event.type === "session") session = String(event.id ?? "");
          if (event.type !== "assistant/message") continue;
          const usage = record(record(event.data).usage);
          const call = { input: count(usage.inputTokens), output: count(usage.outputTokens), total: count(usage.totalTokens), cacheRead: count(usage.cacheReadTokens) ?? 0 };
          if (!session || count(event.seq) === null || call.input === null || call.output === null || call.total === null) throw new Error("DSH session log has a model call without valid usage");
          calls.set(`${session}:${event.seq}`, call as Call);
        }
      }
    }
  };
  const root = join(home, "sessions");
  if (existsSync(root)) walk(root); // a fresh home has no sessions folder before the first turn
  return calls;
}

function tryLedger(home: string | undefined): Map<string, Call> | null {
  if (!home) return null;
  try { return ledger(home); } catch { return null; }
}

/** Same contract as the Grok collector: begin per prompt, observe ACP wire messages, snapshot the terminal receipt. */
export function createDshPromptUsageCollector(home: string | undefined, env: Readonly<NodeJS.ProcessEnv> = process.env) {
  let active: { requestId: string; sessionId: string; wireId?: string | number; completed: boolean; invalid: boolean; baseline: Map<string, Call> | null } | null = null;
  return {
    begin(requestId: string, sessionId: string) {
      const baseline = tryLedger(home);
      active = { requestId, sessionId, completed: false, invalid: baseline === null, baseline };
    },
    observe(direction: "inbound" | "outbound", value: unknown) {
      if (!active || active.invalid) return;
      const message = record(value);
      if (direction === "outbound") {
        if (message.method !== "session/prompt" || record(message.params).sessionId !== active.sessionId) return;
        if (active.wireId !== undefined) { active.invalid = true; return; }
        active.wireId = message.id as string | number;
        return;
      }
      if (active.wireId === undefined || message.id !== active.wireId || message.method !== undefined) return;
      if (message.error !== undefined) active.invalid = true;
      else active.completed = true;
    },
    snapshot(): TerminalPromptUsage | null {
      if (!active || active.invalid || !active.completed || !active.baseline) return null;
      const after = tryLedger(home);
      if (!after) return null;
      const baseline = active.baseline;
      const added = [...after].filter(([key]) => !baseline.has(key)).map(([, call]) => call);
      if (!added.length) return null;
      const sum = (pick: (c: Call) => number) => added.reduce((total, c) => total + pick(c), 0);
      const input = sum((c) => c.input), output = sum((c) => c.output), cacheRead = sum((c) => c.cacheRead);
      const price = dshPrice(env);
      // shortcut: cache reads are priced like input (over-estimate); add a cache price when a priced provider needs it.
      const amount = price ? ((input + cacheRead) * price.input + output * price.output) / 1_000_000 : null;
      return {
        requestId: active.requestId,
        promptId: `dsh:${active.requestId}`,
        event: {
          type: "status", tag: "usage_update", text: "terminal prompt usage",
          ...(amount === null ? {} : { cost: { amount, currency: "USD", basis: "turn" } }),
          breakdown: { inputTokens: input, outputTokens: output, totalTokens: sum((c) => c.total), cachedReadTokens: cacheRead, cachedWriteTokens: 0, thoughtTokens: 0 },
        },
      };
    },
  };
}
