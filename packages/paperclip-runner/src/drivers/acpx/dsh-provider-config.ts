import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Operator configuration for the DeepSeek Harness (DSH) ACPX profile.
 *
 * Every value is read from the task environment first (agent-level override)
 * and then from the runner host environment (instance default). All values are
 * optional; without any of them DSH runs its built-in `deepseek-official`
 * provider with `DEEPSEEK_API_KEY`, exactly like the upstream default.
 */
export const DSH_ENV = Object.freeze({
  profile: "PAPERCLIP_DSH_PROFILE",
  profileDir: "PAPERCLIP_DSH_PROFILE_DIR",
  providerId: "PAPERCLIP_DSH_PROVIDER_ID",
  providerBaseUrl: "PAPERCLIP_DSH_PROVIDER_BASE_URL",
  providerApiKeyEnv: "PAPERCLIP_DSH_PROVIDER_API_KEY_ENV",
  providerApi: "PAPERCLIP_DSH_PROVIDER_API",
  providerContextWindow: "PAPERCLIP_DSH_PROVIDER_CONTEXT_WINDOW",
  providerMaxTokens: "PAPERCLIP_DSH_PROVIDER_MAX_TOKENS",
  stateDir: "PAPERCLIP_DSH_STATE_DIR",
  bundleDir: "PAPERCLIP_DSH_BUNDLE_DIR",
  mem0Endpoint: "PAPERCLIP_DSH_MEM0_ENDPOINT",
  mem0ApiKeyEnv: "PAPERCLIP_DSH_MEM0_API_KEY_ENV",
  mem0UserId: "PAPERCLIP_DSH_MEM0_USER_ID",
  mem0AgentId: "PAPERCLIP_DSH_MEM0_AGENT_ID",
} as const);

/** Shipped ACP profile layers (dsh-official-bundles PROFILE_TEMPLATES.acp); operator bundles follow them. */
export const DSH_ACP_BASE_BUNDLES = Object.freeze(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"]);
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export const DSH_DEFAULT_PROVIDER_ID = "deepseek-official";
export const DSH_DEFAULT_API_KEY_ENV = "DEEPSEEK_API_KEY";
const DSH_PROVIDER_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);
const MAX_PROFILE_BYTES = 64 * 1024;

export interface DshOpenAiCompatibleProvider {
  readonly baseUrl: string;
  readonly api: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface DshRuntimeConfiguration {
  readonly providerId: string;
  readonly apiKeyEnv: string;
  /** Present only when an OpenAI-compatible endpoint is configured. */
  readonly provider?: DshOpenAiCompatibleProvider;
  /** Absolute path of an operator profile patch appended to the ACP profile. */
  readonly profilePath?: string;
  /** Absolute persistent directory for mnemon memory (MNEMON_DATA_DIR). */
  readonly stateDir?: string;
  /** Absolute plugin-bundle directory: package.json (`dsh.profile.bundles`) plus its node_modules. */
  readonly bundleDir?: string;
  /** Self-hosted Mem0 connection seeded into the mnemon state (requires stateDir). */
  readonly mem0?: { readonly endpoint: string; readonly apiKeyEnv: string; readonly userId: string; readonly agentId: string };
}

type Environment = Readonly<Record<string, string | undefined>> | undefined;

function setting(name: string, task: Environment, host: Environment): string | undefined {
  return task?.[name]?.trim() || host?.[name]?.trim() || undefined;
}

function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]{0,8}$/.test(value)) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

export function assertDshProviderId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error("DSH provider ID must be 1-64 characters of letters, digits, '.', '_' or '-'");
  return value;
}

/** A credential variable the DSH launch may receive; Paperclip/Node internals are never credentials. */
export function assertDshApiKeyEnv(value: string): string {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(value) || /^(?:PAPERCLIP_|NODE_|NPM_|DSH_|MNEMON_)/.test(value)) {
    throw new Error(`${DSH_ENV.providerApiKeyEnv} must name an upper-case credential variable outside PAPERCLIP_, NODE_, NPM_, DSH_ and MNEMON_`);
  }
  return value;
}

/** Name of the environment variable holding the DSH provider credential. */
export function dshApiKeyEnv(task?: Environment, host: Environment = process.env): string {
  return assertDshApiKeyEnv(setting(DSH_ENV.providerApiKeyEnv, task, host) ?? DSH_DEFAULT_API_KEY_ENV);
}

/** The default DSH provider ID for an unqualified model ID. */
export function dshProviderId(task?: Environment, host: Environment = process.env): string {
  return assertDshProviderId(setting(DSH_ENV.providerId, task, host) ?? DSH_DEFAULT_PROVIDER_ID);
}

/**
 * DSH reports models as a JSON `[providerId, modelId]` pair. An operator may
 * pass that pair directly as the model ID; a bare model ID uses the configured
 * default provider.
 */
export function dshModelSelector(requestedModel: string, host: Environment = process.env): { providerId: string; modelId: string; reportedModelId: string } {
  if (requestedModel !== requestedModel.trim()) throw new Error("DSH model ID must not contain surrounding whitespace");
  let providerId: string;
  let modelId: string;
  if (requestedModel.startsWith("[")) {
    let parsed: unknown;
    try { parsed = JSON.parse(requestedModel); } catch { throw new Error("DSH model selector must be a JSON [providerId, modelId] pair"); }
    if (!Array.isArray(parsed) || parsed.length !== 2 || parsed.some(part => typeof part !== "string" || !part.trim() || part !== part.trim())) {
      throw new Error("DSH model selector must be a JSON [providerId, modelId] pair");
    }
    providerId = assertDshProviderId(parsed[0]);
    modelId = parsed[1];
  } else {
    providerId = dshProviderId(undefined, host);
    modelId = requestedModel;
  }
  return { providerId, modelId, reportedModelId: JSON.stringify([providerId, modelId]) };
}

export function resolveDshConfiguration(task?: Environment, host: Environment = process.env): DshRuntimeConfiguration {
  const providerId = dshProviderId(task, host);
  const apiKeyEnv = dshApiKeyEnv(task, host);
  const baseUrl = setting(DSH_ENV.providerBaseUrl, task, host);
  let provider: DshOpenAiCompatibleProvider | undefined;
  if (baseUrl !== undefined) {
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error(`${DSH_ENV.providerBaseUrl} must be an absolute http(s) URL`); }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
      throw new Error(`${DSH_ENV.providerBaseUrl} must be an absolute http(s) URL without embedded credentials`);
    }
    if (providerId === DSH_DEFAULT_PROVIDER_ID) throw new Error(`${DSH_ENV.providerBaseUrl} requires ${DSH_ENV.providerId} other than ${DSH_DEFAULT_PROVIDER_ID}`);
    const api = setting(DSH_ENV.providerApi, task, host) ?? "openai-completions";
    if (!DSH_PROVIDER_APIS.has(api)) throw new Error(`${DSH_ENV.providerApi} must be one of ${[...DSH_PROVIDER_APIS].join(", ")}`);
    provider = {
      baseUrl, api,
      contextWindow: positiveInteger(DSH_ENV.providerContextWindow, setting(DSH_ENV.providerContextWindow, task, host), 128_000),
      maxTokens: positiveInteger(DSH_ENV.providerMaxTokens, setting(DSH_ENV.providerMaxTokens, task, host), 16_384),
    };
  }
  const profile = setting(DSH_ENV.profile, task, host);
  let profilePath: string | undefined;
  if (profile !== undefined) {
    if (isAbsolute(profile)) profilePath = resolve(profile);
    else {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(profile) || profile.includes("..")) throw new Error(`${DSH_ENV.profile} must be an absolute path or a profile name`);
      const directory = setting(DSH_ENV.profileDir, task, host);
      if (directory === undefined || !isAbsolute(directory)) throw new Error(`${DSH_ENV.profile} by name requires an absolute ${DSH_ENV.profileDir}`);
      profilePath = join(resolve(directory), profile.endsWith(".yml") || profile.endsWith(".yaml") ? profile : `${profile}.patch.yml`);
    }
  }
  const stateDir = setting(DSH_ENV.stateDir, task, host);
  if (stateDir !== undefined && (!isAbsolute(stateDir) || resolve(stateDir) !== stateDir)) throw new Error(`${DSH_ENV.stateDir} must be an absolute normalized path`);
  const bundleDir = setting(DSH_ENV.bundleDir, task, host);
  if (bundleDir !== undefined && (!isAbsolute(bundleDir) || resolve(bundleDir) !== bundleDir)) throw new Error(`${DSH_ENV.bundleDir} must be an absolute normalized path`);
  const mem0Endpoint = setting(DSH_ENV.mem0Endpoint, task, host);
  let mem0: DshRuntimeConfiguration["mem0"];
  if (mem0Endpoint !== undefined) {
    let url: URL;
    try { url = new URL(mem0Endpoint); } catch { throw new Error(`${DSH_ENV.mem0Endpoint} must be an absolute http(s) URL`); }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
      throw new Error(`${DSH_ENV.mem0Endpoint} must be an absolute http(s) URL without credentials, query or fragment`);
    }
    if (stateDir === undefined) throw new Error(`${DSH_ENV.mem0Endpoint} requires ${DSH_ENV.stateDir}`);
    const keyEnv = setting(DSH_ENV.mem0ApiKeyEnv, task, host);
    if (keyEnv === undefined) throw new Error(`${DSH_ENV.mem0Endpoint} requires ${DSH_ENV.mem0ApiKeyEnv}`);
    const userId = setting(DSH_ENV.mem0UserId, task, host);
    if (userId === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(userId)) throw new Error(`${DSH_ENV.mem0UserId} must be set to 1-128 safe characters`);
    const agentId = setting(DSH_ENV.mem0AgentId, task, host) ?? "*";
    if (agentId !== "*" && !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/.test(agentId)) throw new Error(`${DSH_ENV.mem0AgentId} must be '*' or 1-128 safe characters`);
    mem0 = Object.freeze({ endpoint: mem0Endpoint, apiKeyEnv: assertDshApiKeyEnv(keyEnv), userId, agentId });
  }
  return Object.freeze({ providerId, apiKeyEnv, ...(provider ? { provider } : {}), ...(profilePath ? { profilePath } : {}), ...(stateDir ? { stateDir } : {}),
    ...(bundleDir ? { bundleDir } : {}), ...(mem0 ? { mem0 } : {}) });
}

/** Credential names a DSH launch may receive. */
export function dshCredentialNames(environment?: Environment, host: Environment = process.env): readonly string[] {
  return [...new Set([DSH_DEFAULT_API_KEY_ENV, dshApiKeyEnv(environment, host)])];
}

/**
 * The ACP profile patch written to `$DSH_HOME/profiles/acp/cordis.patch.yml`:
 * telemetry and session upload off, then the optional OpenAI-compatible
 * provider, then the optional operator profile. Values are JSON-quoted, which
 * YAML accepts verbatim; the credential is referenced by name only.
 */
export async function dshAcpProfilePatch(configuration: DshRuntimeConfiguration, requestedModel: string, host: Environment = process.env): Promise<string> {
  const lines = [
    "- id: session-log-deepseek",
    "  config:",
    "    enabled: false",
    "- id: session-telemetry-otel",
    "  disabled: true",
  ];
  if (configuration.provider) {
    const selector = dshModelSelector(requestedModel, host);
    const q = JSON.stringify;
    lines.push(
      "- id: llm-pi-ai",
      `  name: ${q("@deepseek-ai/dsh-llm-pi-ai")}`,
      "  config:",
      "    providers:",
      `      ${q(configuration.providerId)}:`,
      `        displayName: ${q(configuration.providerId)}`,
      `        apiKeyEnv: ${q(configuration.apiKeyEnv)}`,
      `        api: ${q(configuration.provider.api)}`,
      `        baseURL: ${q(configuration.provider.baseUrl)}`,
      `        models: ${q([...new Set([selector.modelId])].map(id => ({ id, contextWindow: configuration.provider!.contextWindow, maxTokens: configuration.provider!.maxTokens })))}`,
    );
  }
  if (configuration.profilePath) {
    const bytes = await readFile(configuration.profilePath);
    if (bytes.byteLength > MAX_PROFILE_BYTES) throw new Error(`DSH profile ${configuration.profilePath} exceeds ${MAX_PROFILE_BYTES} bytes`);
    lines.push(`# Operator profile: ${configuration.profilePath}`, bytes.toString("utf8").replace(/\s+$/, ""));
  }
  return `${lines.join("\n")}\n`;
}

/** Ensure the persistent mnemon directory exists and return its launch environment. */
export async function dshStateEnvironment(configuration: DshRuntimeConfiguration): Promise<Record<string, string>> {
  if (!configuration.stateDir) return {};
  await mkdir(configuration.stateDir, { recursive: true, mode: 0o700 });
  return { MNEMON_DATA_DIR: configuration.stateDir };
}

/**
 * The ACP profile manifest (`$DSH_HOME/profiles/acp/package.json`) when an operator
 * bundle directory is configured: the shipped ACP layers, then the bundles listed in
 * `<bundleDir>/package.json` under `dsh.profile.bundles`, in order and without duplicates.
 * DSH resolves these from its installation first, then from the profile's node_modules,
 * which the runner links to `<bundleDir>/node_modules`.
 */
export async function dshAcpProfileManifest(configuration: DshRuntimeConfiguration): Promise<string | undefined> {
  if (!configuration.bundleDir) return undefined;
  const bytes = await readFile(join(configuration.bundleDir, "package.json"));
  if (bytes.byteLength > MAX_PROFILE_BYTES) throw new Error(`${DSH_ENV.bundleDir}/package.json exceeds ${MAX_PROFILE_BYTES} bytes`);
  const listed = (JSON.parse(bytes.toString("utf8")) as { dsh?: { profile?: { bundles?: unknown } } }).dsh?.profile?.bundles;
  if (!Array.isArray(listed) || listed.some(name => typeof name !== "string" || !NPM_NAME.test(name))) {
    throw new Error(`${DSH_ENV.bundleDir}/package.json must list package names in dsh.profile.bundles`);
  }
  const bundles = [...new Set([...DSH_ACP_BASE_BUNDLES, ...(listed as string[])])];
  return `${JSON.stringify({ name: "dsh-profile-acp", private: true, dependencies: {}, dsh: { profile: { bundles } } }, undefined, 2)}\n`;
}

/** mnemon Memory Spaces provider registry (dsh-mnemon-source-memory-spaces, format version 4). */
export const DSH_MEM0_REGISTRY_RELATIVE = join("state", "memory-providers.json");

/**
 * Seed the self-hosted Mem0 connection into the agent's persistent mnemon state, once:
 * an existing registry (operator- or DSH-managed) is never overwritten. The credential is
 * read from the runner environment by name and stays in the 0700 state directory; it is
 * not passed to the DSH process environment.
 */
export async function seedDshMem0Registry(configuration: DshRuntimeConfiguration, task?: Environment, host: Environment = process.env, now = new Date()): Promise<"seeded" | "kept" | "none"> {
  if (!configuration.mem0 || !configuration.stateDir) return "none";
  const apiKey = setting(configuration.mem0.apiKeyEnv, task, host);
  if (apiKey === undefined) throw new Error(`${configuration.mem0.apiKeyEnv} is not set for the DSH Mem0 connection`);
  const directory = join(configuration.stateDir, "state");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const at = now.toISOString();
  const registry = {
    version: 4,
    services: { mem0: { mode: "self-hosted", endpoint: configuration.mem0.endpoint, apiKey } },
    enabled: { mem0: true },
    bodies: [{ id: "mem0-default", name: "Mem0", active: true, providerId: "mem0",
      connection: { userId: configuration.mem0.userId, agentId: configuration.mem0.agentId }, createdAt: at, updatedAt: at }],
  };
  try {
    await writeFile(join(configuration.stateDir, DSH_MEM0_REGISTRY_RELATIVE), `${JSON.stringify(registry, undefined, 2)}\n`, { flag: "wx", mode: 0o600 });
    return "seeded";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "kept";
    throw error;
  }
}
