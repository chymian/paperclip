/**
 * Self-hosted Mem0 connector (method `self-hosted` of app definition `mem0`).
 * Launches the stdio MCP server `@yeyuan98/mem0-mcp` (Apache-2.0) against a
 * self-hosted Mem0 REST API. The Mem0 Cloud method and its default URL stay unchanged.
 *
 * Instance configuration (all optional):
 * - PAPERCLIP_MEM0_BASE_URL: Mem0 REST base URL used when the connection has no MEM0_BASE_URL.
 * - PAPERCLIP_MEM0_MCP_COMMAND: stdio command (default `mem0-mcp`).
 *
 * Tool contract reviewed from mem0-mcp 0.3.4 `tools/list`. Only add/read tools are
 * approved; update/delete stay unexposed (write-once, auditable memory).
 */
import type { McpToolDescriptor } from "./tool-access/catalog/descriptors.js";

export const MEM0_SELF_HOSTED_TEMPLATE_ID = "paperclip.mem0-self-hosted";

export const MEM0_SELF_HOSTED_TOOLS: McpToolDescriptor[] = [
  {
    "name": "add_memory",
    "description": "Store new memory(ies). Mem0 extracts atomic facts from the messages automatically. Write ONE atomic fact per call (not a paragraph) so individual memories can be found and updated independently. Set metadata.type to a category (decision / task_learning / anti_pattern / convention / identity / prefer",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "messages": {
          "minItems": 1,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "role": {
                "type": "string",
                "description": "Conversation role, e.g. 'user' or 'assistant'."
              },
              "content": {
                "type": "string",
                "description": "Message content."
              }
            },
            "required": [
              "role",
              "content"
            ]
          },
          "description": "Conversation to extract memories from."
        },
        "user_id": {
          "description": "Scope to a user. Optional. Scoping resolves via: explicit id → MEM0_DEFAULT_* → automatic discovery (single known identity, or a query-token match for reads). Writes do NOT auto-match names — on a multi-identity store an omitted id errors, otherwise the write lands on the discovered or default identity. Pass user_id/agent_id/run_id explicitly to target a specific scope.",
          "type": "string"
        },
        "agent_id": {
          "description": "Scope to an agent. Optional. Scoping resolves via: explicit id → MEM0_DEFAULT_* → automatic discovery (single known identity, or a query-token match for reads). Writes do NOT auto-match names — on a multi-identity store an omitted id errors, otherwise the write lands on the discovered or default identity. Pass user_id/agent_id/run_id explicitly to target a specific scope.",
          "type": "string"
        },
        "run_id": {
          "description": "Scope to a run/session. Optional. Scoping resolves via: explicit id → MEM0_DEFAULT_* → automatic discovery (single known identity, or a query-token match for reads). Writes do NOT auto-match names — on a multi-identity store an omitted id errors, otherwise the write lands on the discovered or default identity. Pass user_id/agent_id/run_id explicitly to target a specific scope.",
          "type": "string"
        },
        "metadata": {
          "description": "Arbitrary metadata to attach. A `type` key (decision/task_learning/anti_pattern/convention/identity/preference) is strongly recommended to enable category filtering.",
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {}
        }
      },
      "required": [
        "messages"
      ]
    },
    "annotations": {
      "readOnlyHint": false
    }
  },
  {
    "name": "search_memories",
    "description": "Semantic search across stored memories. Use this proactively before answering when the request may depend on the user's past work, preferences, decisions, or environment — relevant memories are not always auto-injected. You do NOT need to pass user_id — scoping is automatic, and if the query mention",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "Natural-language or keyword search query."
        },
        "user_id": {
          "description": "Scope to a user. Optional. Scoping resolves via: explicit id → MEM0_DEFAULT_* → automatic discovery (single known identity, or a query-token match for reads). Writes do NOT auto-match names — on a multi-identity store an omitted id errors, otherwise the write lands on the discovered or default identity. Pass user_id/agent_id/run_id explicitly to target a specific scope.",
          "type": "string"
        },
        "agent_id": {
          "description": "Scope to an agent. Optional. Scoping resolves via: explicit id → MEM0_DEFAULT_* → automatic discovery (single known identity, or a query-token match for reads). Writes do NOT auto-match names — on a multi-identity store an omitted id errors, otherwise the write lands on the discovered or default identity. Pass user_id/agent_id/run_id explicitly to target a specific scope.",
          "type": "string"
        },
        "run_id": {
          "description": "Scope to a run/session. Optional. Scoping resolves via: explicit id → MEM0_DEFAULT_* → automatic discovery (single known identity, or a query-token match for reads). Writes do NOT auto-match names — on a multi-identity store an omitted id errors, otherwise the write lands on the discovered or default identity. Pass user_id/agent_id/run_id explicitly to target a specific scope.",
          "type": "string"
        },
        "filters": {
          "description": "Extra metadata/operator filters (merged with identity). Server supports eq/ne/in/nin/gt/gte/lt/lte/contains/icontains/AND/OR/NOT, e.g. {\"type\":\"decision\"} or {\"AND\":[{\"type\":\"decision\"},{\"confidence\":{\"gte\":0.8}}]}.",
          "type": "object",
          "propertyNames": {
            "type": "string"
          },
          "additionalProperties": {}
        },
        "top_k": {
          "description": "Max number of results after dedup (default 10).",
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "threshold": {
          "description": "Minimum similarity score (server default 0.1; raise to 0.3+ to tighten relevance).",
          "type": "number",
          "minimum": 0,
          "maximum": 1
        },
        "raw": {
          "description": "Return the raw server response instead of the distilled, deduplicated envelope. Default false.",
          "type": "boolean"
        }
      },
      "required": [
        "query"
      ]
    },
    "annotations": {
      "readOnlyHint": true
    }
  },
  {
    "name": "recall",
    "description": "Retrieve memories relevant to a natural-language request by rewriting the query into noun-phrase keywords and fanning out 2-4 parallel searches across phrasings (and a metadata category when `intent` is set), then deduping and ranking. Use this as the DEFAULT when a request may depend on past work/p",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "The user's raw message or your rephrased question; recall handles query rewriting."
        },
        "intent": {
          "description": "Hint which memory category to weight (adds one metadata-typed search). 'auto' (default) searches all.",
          "type": "string",
          "enum": [
            "auto",
            "decision",
            "task_learning",
            "anti_pattern",
            "convention",
            "identity",
            "preference"
          ]
        },
        "top_k": {
          "description": "Final number of results to return after dedup (default 5).",
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        },
        "user_id": {
          "description": "Scope to a user. Optional. Scoping resolves via: explicit id → MEM0_DEFAULT_* → automatic discovery (single known identity, or a query-token match for reads). Writes do NOT auto-match names — on a multi-identity store an omitted id errors, otherwise the write lands on the discovered or default identity. Pass user_id/agent_id/run_id explicitly to target a specific scope.",
          "type": "string"
        },
        "agent_id": {
          "description": "Scope to an agent. Optional. Scoping resolves via: explicit id → MEM0_DEFAULT_* → automatic discovery (single known identity, or a query-token match for reads). Writes do NOT auto-match names — on a multi-identity store an omitted id errors, otherwise the write lands on the discovered or default identity. Pass user_id/agent_id/run_id explicitly to target a specific scope.",
          "type": "string"
        },
        "run_id": {
          "description": "Scope to a run/session. Optional. Scoping resolves via: explicit id → MEM0_DEFAULT_* → automatic discovery (single known identity, or a query-token match for reads). Writes do NOT auto-match names — on a multi-identity store an omitted id errors, otherwise the write lands on the discovered or default identity. Pass user_id/agent_id/run_id explicitly to target a specific scope.",
          "type": "string"
        }
      },
      "required": [
        "query"
      ]
    },
    "annotations": {
      "readOnlyHint": true
    }
  },
  {
    "name": "get_memories",
    "description": "List or browse stored memories WITHOUT ranking — for auditing what is remembered or paging through everything in a scope. To find memories relevant to a question, use search_memories or recall (they rank by semantic relevance); this tool does not rank. Scoping is automatic (defaults to the single kn",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "user_id": {
          "description": "Scope to a user. Optional. Scoping resolves via: explicit id → MEM0_DEFAULT_* → automatic discovery (single known identity, or a query-token match for reads). Writes do NOT auto-match names — on a multi-identity store an omitted id errors, otherwise the write lands on the discovered or default identity. Pass user_id/agent_id/run_id explicitly to target a specific scope.",
          "type": "string"
        },
        "agent_id": {
          "description": "Scope to an agent. Optional. Scoping resolves via: explicit id → MEM0_DEFAULT_* → automatic discovery (single known identity, or a query-token match for reads). Writes do NOT auto-match names — on a multi-identity store an omitted id errors, otherwise the write lands on the discovered or default identity. Pass user_id/agent_id/run_id explicitly to target a specific scope.",
          "type": "string"
        },
        "run_id": {
          "description": "Scope to a run/session. Optional. Scoping resolves via: explicit id → MEM0_DEFAULT_* → automatic discovery (single known identity, or a query-token match for reads). Writes do NOT auto-match names — on a multi-identity store an omitted id errors, otherwise the write lands on the discovered or default identity. Pass user_id/agent_id/run_id explicitly to target a specific scope.",
          "type": "string"
        },
        "top_k": {
          "description": "Max number of memories to return.",
          "type": "integer",
          "exclusiveMinimum": 0,
          "maximum": 9007199254740991
        }
      }
    },
    "annotations": {
      "readOnlyHint": true
    }
  },
  {
    "name": "get_memory",
    "description": "Retrieve a single memory by its exact ID — e.g. a `mem0:<12hex>` citation returned by search_memories or recall, or a full UUID. Use this to read a cited memory's full content and metadata. Pass user_id/agent_id/run_id to scope resolution of a citation.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {
        "memory_id": {
          "type": "string",
          "description": "The memory ID (full UUID, or a mem0:<12hex> citation resolved back to the full UUID)."
        },
        "user_id": {
          "description": "Scope citation resolution to a user. Optional. Used only to scope citation (mem0:<hex>) resolution to a specific user/agent/run. A full UUID is resolved by the server regardless of scope.",
          "type": "string"
        },
        "agent_id": {
          "description": "Scope citation resolution to an agent. Optional. Used only to scope citation (mem0:<hex>) resolution to a specific user/agent/run. A full UUID is resolved by the server regardless of scope.",
          "type": "string"
        },
        "run_id": {
          "description": "Scope citation resolution to a run/session. Optional. Used only to scope citation (mem0:<hex>) resolution to a specific user/agent/run. A full UUID is resolved by the server regardless of scope.",
          "type": "string"
        }
      },
      "required": [
        "memory_id"
      ]
    },
    "annotations": {
      "readOnlyHint": true
    }
  },
  {
    "name": "list_entities",
    "description": "List every user_id / agent_id / run_id that owns memories, with memory counts. Useful for auditing who has stored data before a scoped search or delete. Requires an admin key.",
    "inputSchema": {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "type": "object",
      "properties": {}
    },
    "annotations": {
      "readOnlyHint": true
    }
  }
];

export function mem0SelfHostedCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PAPERCLIP_MEM0_MCP_COMMAND?.trim();
  return configured && configured.length > 0 ? configured : "mem0-mcp";
}

export const MEM0_SELF_HOSTED_TEMPLATE = {
  name: "Mem0 (self-hosted)",
  command: mem0SelfHostedCommand(),
  args: [] as string[],
  envKeys: ["MEM0_BASE_URL", "MEM0_API_KEY"],
  tools: MEM0_SELF_HOSTED_TOOLS,
};

/** Fill MEM0_BASE_URL from the instance default and require an http(s) URL. */
export function applyMem0SelfHostedEnvironment(
  env: NodeJS.ProcessEnv,
  instanceEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const fromConnection = env.MEM0_BASE_URL?.trim();
  const fallback = instanceEnv.PAPERCLIP_MEM0_BASE_URL?.trim();
  const baseUrl = fromConnection && fromConnection.length > 0 ? fromConnection : fallback;
  if (!baseUrl) throw new Error("Set the Mem0 base URL on the connection or PAPERCLIP_MEM0_BASE_URL on the instance.");
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new Error("Mem0 base URL must use http or https."); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Mem0 base URL must use http or https.");
  return { ...env, MEM0_BASE_URL: baseUrl };
}
