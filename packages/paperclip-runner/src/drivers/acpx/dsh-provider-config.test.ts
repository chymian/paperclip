import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DSH_MEM0_REGISTRY_RELATIVE, dshAcpProfileManifest, dshAcpProfilePatch, dshCredentialNames, dshModelSelector, dshStateEnvironment, resolveDshConfiguration, seedDshMem0Registry } from "./dsh-provider-config.js";

describe("DSH provider configuration", () => {
  it("keeps the upstream default without configuration", async () => {
    const configuration = resolveDshConfiguration({}, {});
    expect(configuration).toEqual({ providerId: "deepseek-official", apiKeyEnv: "DEEPSEEK_API_KEY" });
    expect(dshModelSelector("deepseek-v4-flash", {}).reportedModelId).toBe('["deepseek-official","deepseek-v4-flash"]');
    const patch = await dshAcpProfilePatch(configuration, "deepseek-v4-flash", {});
    expect(patch).toContain("session-telemetry-otel");
    expect(patch).not.toContain("llm-pi-ai");
    expect(dshCredentialNames({}, {})).toEqual(["DEEPSEEK_API_KEY"]);
  });

  it("configures an OpenAI-compatible provider with the agent overriding the instance", async () => {
    const host = { PAPERCLIP_DSH_PROVIDER_ID: "inference", PAPERCLIP_DSH_PROVIDER_BASE_URL: "http://llm.internal:4000/v1", PAPERCLIP_DSH_PROVIDER_API_KEY_ENV: "INFERENCE_API_KEY" };
    const task = { PAPERCLIP_DSH_PROVIDER_MAX_TOKENS: "8192" };
    const configuration = resolveDshConfiguration(task, host);
    expect(configuration.provider).toEqual({ baseUrl: "http://llm.internal:4000/v1", api: "openai-completions", contextWindow: 128000, maxTokens: 8192 });
    expect(dshCredentialNames(task, host)).toEqual(["DEEPSEEK_API_KEY", "INFERENCE_API_KEY"]);
    const patch = await dshAcpProfilePatch(configuration, "qwen3-coder", host);
    expect(patch).toContain('apiKeyEnv: "INFERENCE_API_KEY"');
    expect(patch).toContain('baseURL: "http://llm.internal:4000/v1"');
    expect(patch).toContain('"id":"qwen3-coder"');
    expect(dshModelSelector("qwen3-coder", host).reportedModelId).toBe('["inference","qwen3-coder"]');
    expect(dshModelSelector('["other","m/1"]', host)).toEqual({ providerId: "other", modelId: "m/1", reportedModelId: '["other","m/1"]' });
  });

  it("rejects unsafe values", () => {
    expect(() => resolveDshConfiguration({ PAPERCLIP_DSH_PROVIDER_API_KEY_ENV: "PAPERCLIP_AGENT_JWT" }, {})).toThrow("credential variable");
    expect(() => resolveDshConfiguration({ PAPERCLIP_DSH_PROVIDER_BASE_URL: "http://x/v1" }, {})).toThrow("PAPERCLIP_DSH_PROVIDER_ID");
    expect(() => resolveDshConfiguration({ PAPERCLIP_DSH_PROVIDER_ID: "p", PAPERCLIP_DSH_PROVIDER_BASE_URL: "http://u:p@x/v1" }, {})).toThrow("embedded credentials");
    expect(() => resolveDshConfiguration({ PAPERCLIP_DSH_PROFILE: "../x" }, {})).toThrow("profile name");
    expect(() => resolveDshConfiguration({ PAPERCLIP_DSH_STATE_DIR: "relative" }, {})).toThrow("absolute");
    expect(() => dshModelSelector(" m", {})).toThrow("whitespace");
    expect(() => dshModelSelector('["only"]', {})).toThrow("pair");
  });

  it("appends a named operator profile and persists mnemon state", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-config-"));
    try {
      await writeFile(join(root, "base.patch.yml"), "- id: mnemon-strategy-auto-capture\n  disabled: true\n");
      const state = join(root, "state", "agent-a");
      const configuration = resolveDshConfiguration({ PAPERCLIP_DSH_PROFILE: "base", PAPERCLIP_DSH_STATE_DIR: state }, { PAPERCLIP_DSH_PROFILE_DIR: root });
      const patch = await dshAcpProfilePatch(configuration, "deepseek-v4-flash", {});
      expect(patch).toContain("mnemon-strategy-auto-capture");
      expect(await dshStateEnvironment(configuration)).toEqual({ MNEMON_DATA_DIR: state });
      expect((await stat(state)).isDirectory()).toBe(true);
      expect(await readFile(join(root, "base.patch.yml"), "utf8")).toContain("disabled");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("composes operator plugin bundles after the shipped ACP layers", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-bundles-"));
    try {
      expect(await dshAcpProfileManifest(resolveDshConfiguration({}, {}))).toBeUndefined();
      await writeFile(join(root, "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-mnemon", "dsh-web-search-searxng"] } } }));
      const manifest = JSON.parse((await dshAcpProfileManifest(resolveDshConfiguration({ PAPERCLIP_DSH_BUNDLE_DIR: root }, {})))!);
      expect(manifest.dsh.profile.bundles).toEqual(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app", "dsh-mnemon", "dsh-web-search-searxng"]);
      await writeFile(join(root, "package.json"), JSON.stringify({ dsh: { profile: { bundles: ["../escape"] } } }));
      await expect(dshAcpProfileManifest(resolveDshConfiguration({ PAPERCLIP_DSH_BUNDLE_DIR: root }, {}))).rejects.toThrow(/dsh.profile.bundles/);
      expect(() => resolveDshConfiguration({ PAPERCLIP_DSH_BUNDLE_DIR: "relative/dir" }, {})).toThrow(/absolute/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("seeds the self-hosted Mem0 connection once without exposing it to the DSH environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-mem0-"));
    try {
      const stateDir = join(root, "state-a");
      const task = { PAPERCLIP_DSH_STATE_DIR: stateDir, PAPERCLIP_DSH_MEM0_ENDPOINT: "http://mem0-gate:8080", PAPERCLIP_DSH_MEM0_API_KEY_ENV: "MEM0_GATE_KEY_DSH", PAPERCLIP_DSH_MEM0_USER_ID: "osintia" };
      const configuration = resolveDshConfiguration(task, {});
      expect(configuration.mem0).toEqual({ endpoint: "http://mem0-gate:8080", apiKeyEnv: "MEM0_GATE_KEY_DSH", userId: "osintia", agentId: "*" });
      await expect(seedDshMem0Registry(configuration, task, {})).rejects.toThrow(/MEM0_GATE_KEY_DSH is not set/);
      expect(await seedDshMem0Registry(configuration, task, { MEM0_GATE_KEY_DSH: "k1" })).toBe("seeded");
      const path = join(stateDir, DSH_MEM0_REGISTRY_RELATIVE);
      const registry = JSON.parse(await readFile(path, "utf8"));
      expect(registry).toMatchObject({ version: 4, services: { mem0: { mode: "self-hosted", endpoint: "http://mem0-gate:8080", apiKey: "k1" } }, enabled: { mem0: true } });
      expect(registry.bodies[0]).toMatchObject({ providerId: "mem0", active: true, connection: { userId: "osintia", agentId: "*" } });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await seedDshMem0Registry(configuration, task, { MEM0_GATE_KEY_DSH: "k2" })).toBe("kept");
      expect(JSON.parse(await readFile(path, "utf8")).services.mem0.apiKey).toBe("k1");
      expect(await dshStateEnvironment(configuration)).toEqual({ MNEMON_DATA_DIR: stateDir });
      expect(dshCredentialNames(task, {})).not.toContain("MEM0_GATE_KEY_DSH");
      expect(() => resolveDshConfiguration({ PAPERCLIP_DSH_MEM0_ENDPOINT: "http://mem0-gate:8080" }, {})).toThrow(/requires PAPERCLIP_DSH_STATE_DIR/);
      expect(() => resolveDshConfiguration({ ...task, PAPERCLIP_DSH_MEM0_API_KEY_ENV: "PAPERCLIP_SECRET" }, {})).toThrow();
      await mkdir(join(root, "unused"), { recursive: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
