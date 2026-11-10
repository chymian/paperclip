import { describe, expect, it } from "vitest";
import {
  MEM0_SELF_HOSTED_TEMPLATE,
  MEM0_SELF_HOSTED_TOOLS,
  applyMem0SelfHostedEnvironment,
  mem0SelfHostedCommand,
} from "./mem0-self-hosted-connection.js";

describe("mem0 self-hosted connector", () => {
  it("exposes only add/read tools", () => {
    expect(MEM0_SELF_HOSTED_TOOLS.map((tool) => tool.name).sort()).toEqual(
      ["add_memory", "get_memories", "get_memory", "list_entities", "recall", "search_memories"],
    );
    expect(MEM0_SELF_HOSTED_TOOLS.filter((tool) => tool.annotations?.readOnlyHint === false).map((tool) => tool.name)).toEqual(["add_memory"]);
    expect(MEM0_SELF_HOSTED_TEMPLATE.envKeys).toEqual(["MEM0_BASE_URL", "MEM0_API_KEY"]);
  });

  it("uses the connection URL first, then PAPERCLIP_MEM0_BASE_URL", () => {
    expect(applyMem0SelfHostedEnvironment({ MEM0_BASE_URL: "http://mem0-gate:8080" }, { PAPERCLIP_MEM0_BASE_URL: "http://other:1" }).MEM0_BASE_URL).toBe("http://mem0-gate:8080");
    expect(applyMem0SelfHostedEnvironment({ MEM0_API_KEY: "k" }, { PAPERCLIP_MEM0_BASE_URL: "http://mem0-gate:8080" })).toEqual({ MEM0_API_KEY: "k", MEM0_BASE_URL: "http://mem0-gate:8080" });
  });

  it("fails closed without a usable URL", () => {
    expect(() => applyMem0SelfHostedEnvironment({}, {})).toThrow(/PAPERCLIP_MEM0_BASE_URL/);
    expect(() => applyMem0SelfHostedEnvironment({ MEM0_BASE_URL: "file:///etc/passwd" }, {})).toThrow(/http or https/);
    expect(() => applyMem0SelfHostedEnvironment({ MEM0_BASE_URL: "not a url" }, {})).toThrow(/http or https/);
  });

  it("allows an instance command override", () => {
    expect(mem0SelfHostedCommand({})).toBe("mem0-mcp");
    expect(mem0SelfHostedCommand({ PAPERCLIP_MEM0_MCP_COMMAND: "/opt/bin/mem0-mcp" })).toBe("/opt/bin/mem0-mcp");
  });
});
