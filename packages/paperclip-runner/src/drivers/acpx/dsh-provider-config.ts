import { mkdir, readFile } from "node:fs/promises";
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
} as const);

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
  return Object.freeze({ providerId, apiKeyEnv, ...(provider ? { provider } : {}), ...(profilePath ? { profilePath } : {}), ...(stateDir ? { stateDir } : {}) });
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
