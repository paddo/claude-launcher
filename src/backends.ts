import { spawn } from "child_process";
import { confirm, input } from "@inquirer/prompts";
import { saveConfig, type Backend, type Config } from "./config";
import {
  fetchModels,
  filterAgenticModels,
  getNewModels,
  fetchOllamaModels,
  filterToolCapableOllamaModels,
  fetchOpenAIModels,
  fetchCodexModels,
  fetchGrokModels,
  fetchKimiModels,
  formatContext,
  formatPrice,
  formatOllamaSize,
  getOllamaContext,
  getLmStudioContext,
  getLlamaCppContext,
  openAIModelContext,
  type CatalogModel,
} from "./models";
import { pickCatalogModel, pickCodexEffort, BACK } from "./picker";
import { login } from "./auth";
import { startProxy, handleOpenAIMessages, type AnthropicRequest as OpenAIProxyRequest } from "./proxy";
import { startCodexProxy, handleCodexMessages, type AnthropicRequest as CodexRequest } from "./codex-proxy";
import { forwardAnthropic } from "./proxy-shared";
import { forwardOpenRouter, startOpenRouterProxy } from "./openrouter-proxy";
import { getGrokAuth, hasGrokAuth, type GrokAuth } from "./grok-auth";
import { startGrokProxy, handleGrokMessages, type AnthropicBody as GrokBody } from "./grok-proxy";
import { getKimiAuth, getKimiIdentity, identityHeaders, type KimiIdentity } from "./kimi-auth";
import { startKimiProxy, handleKimiMessages, type KimiBody } from "./kimi-proxy";
import type { MixedHandler } from "./mixed-proxy";

export const NIM_CLOUD_HOST = "https://integrate.api.nvidia.com/v1";

// A user-facing failure with a clean message (unreachable host, missing
// login, empty catalog). runBackend prints it without a stack and exits;
// anything else propagates as a real crash.
export class BackendError extends Error {}

const toBackendError = (err: unknown): never => {
  throw new BackendError(err instanceof Error ? err.message : String(err));
};

type RoleSlot = "sonnet" | "opus" | "haiku";

// Config keys holding plain string values - the only kind the registry may
// bind (excludes narrower unions like `backend` and non-strings).
type StringKey = {
  [K in keyof Config]-?: Config[K] extends string | undefined ? (string extends NonNullable<Config[K]> ? K : never) : never;
}[keyof Config];

// A is the backend's credential state, produced by auth() and consumed by
// catalog/transport/credentials. Defs are authored with a concrete A via
// defineBackend and erased to BackendDef<unknown> in the registry.
export interface BackendDef<A = unknown> {
  id: Backend;
  longFlag: string;
  // Omitted when every safe letter is taken: claude's own short flags (-p
  // print, -r resume) pass through to the launched CLI and new backends must
  // not shadow them (-c/-m predate this rule and stay for compatibility).
  shortFlag?: string;
  helpText: string;
  pickerLabel: string;
  // Label in the mixed-mode slot picker when it differs from pickerLabel.
  mixedLabel?: string;
  keys: {
    model: StringKey;
    sonnet: StringKey;
    opus: StringKey;
    haiku: StringKey;
    effort?: StringKey;
  };
  // Acquire credentials; may prompt (env-var offers, OAuth, key input) and
  // persist to config. Absent when the backend needs none up front.
  auth?(config: Config): Promise<A>;
  // Cheap, non-interactive credential presence check. Gates mixed-route
  // registration; absent means always available.
  hasAuth?(config: Config): boolean;
  catalog(config: Config, auth: A): Promise<CatalogModel[]>;
  // Prompt for the server host during interactive setup (LAN servers).
  host?: { key: StringKey; default: string; message: string };
  // Fuzzy search picker instead of a plain select (large catalogs).
  searchPicker?: boolean;
  // Skip the "saved model still in catalog" check before reusing it.
  validateSaved?: boolean;
  roles: {
    message: string;
    confirmDefault: boolean;
    // Flat-subscription policy: no per-token saving from a cheaper model, so
    // every role defaults to the picked model before offering to customize.
    defaultToMain?: boolean;
    order: RoleSlot[];
    preConfigure?(config: Config, models: CatalogModel[]): void;
  };
  // Context window for the chosen model; defaults to a catalog lookup. The
  // catalog is passed lazily so backends that resolve context from the server
  // or config alone never force a catalog load (mixed launches).
  resolveContext?(modelId: string, config: Config, models: () => Promise<CatalogModel[]>): Promise<number>;
  // Applied when the resolved context is 0/unknown (subscription backends
  // assume the standard 200k window rather than no override).
  contextFallback?: number;
  transport(config: Config, auth: A): Promise<{ baseUrl: string; port?: number; close?: () => void }>;
  credentials(auth: A): { apiKey: string; authToken?: string };
  describe(model: string, context: number, port: number | undefined, config: Config): string;
  mixed: {
    route(config: Config): MixedHandler | undefined;
    // Slot models may carry a "@effort" pin. Only these backends get "@"
    // suffixes appended and stripped, so model ids that contain "@"
    // themselves survive on the others.
    effortSuffix?: boolean;
    // Efforts offered when pinning a mixed slot; defaults to the catalog
    // entry's efforts.
    slotEfforts?(model: CatalogModel): string[];
  };
}

// Erases the per-def credential type for registry storage; every consumer of
// an erased def passes the auth value straight back into the same def.
const defineBackend = <A>(def: BackendDef<A>): BackendDef => def as unknown as BackendDef;

// Backends whose four role-model config keys all follow the `<id>Model`
// naming scheme ("mixed" has the keys but is a launcher mode, not a backend).
type RoleKeyedBackend = Exclude<
  { [I in Backend]: (`${I}Model` | `${I}SonnetModel` | `${I}OpusModel` | `${I}HaikuModel`) extends StringKey ? I : never }[Backend],
  "mixed"
>;

const roleKeys = (id: RoleKeyedBackend): BackendDef["keys"] => ({
  model: `${id}Model` as StringKey,
  sonnet: `${id}SonnetModel` as StringKey,
  opus: `${id}OpusModel` as StringKey,
  haiku: `${id}HaikuModel` as StringKey,
});

const cfgGet = (config: Config, key: StringKey): string | undefined => config[key];
const cfgSet = (config: Config, key: StringKey, value: string | undefined): void => {
  config[key] = value;
};

export function launchClaude(passthrough: string[], env?: NodeJS.ProcessEnv, onExit?: () => void): void {
  const child = spawn("claude", passthrough, { env, stdio: "inherit" });
  child.on("exit", (code) => {
    onExit?.();
    process.exit(code || 0);
  });
}

// Claude Code caps non-first-party base URLs at 200k (claude-code#46416). The
// MAX_CONTEXT_TOKENS override is only honored when auto-compaction is disabled,
// so both are set together to reach a model's real window when it exceeds 200k.
export function contextOverrideEnv(contextWindow: number): Record<string, string> {
  if (!contextWindow || contextWindow <= 200000) return {};
  return { DISABLE_COMPACT: "1", CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow) };
}

const ROLE_LABELS: Record<RoleSlot, string> = {
  sonnet: "Sonnet (lighter tasks)",
  opus: "Opus (complex tasks)",
  haiku: "Haiku (quick/cheap)",
};

const LOCAL_ROLES: BackendDef["roles"] = {
  message: "Configure role models? (ensures all requests stay local)",
  confirmDefault: true,
  order: ["sonnet", "opus", "haiku"],
};

const DEFAULT_ROLES: BackendDef["roles"] = {
  message: "Configure role models?",
  confirmDefault: false,
  order: ["sonnet", "opus", "haiku"],
};

const SUBSCRIPTION_ROLES: BackendDef["roles"] = {
  message: "Use a faster model for lighter roles?",
  confirmDefault: false,
  defaultToMain: true,
  order: ["opus", "sonnet", "haiku"],
};

const proxyTransport =
  <A,>(label: string, start: (config: Config, auth: A) => Promise<{ port: number; close: () => void }>) =>
  async (config: Config, auth: A) => {
    console.log(label);
    const proxy = await start(config, auth);
    return { baseUrl: `http://127.0.0.1:${proxy.port}`, port: proxy.port, close: proxy.close };
  };

const tokenCredentials = (token: string) => () => ({ apiKey: "", authToken: token });

// The host must be known before the catalog fetch. Forced on the setup
// signals of a run (-b, or no model saved yet); otherwise prompts only when
// no host is stored (e.g. first mixed-slot route to this backend).
export async function ensureHost(def: BackendDef, config: Config, force: boolean): Promise<void> {
  if (!def.host || (!force && cfgGet(config, def.host.key))) return;
  const current = cfgGet(config, def.host.key);
  const host = await input({ message: def.host.message, default: current || def.host.default });
  cfgSet(config, def.host.key, host.replace(/\/+$/, ""));
  saveConfig(config);
}

// Acquire credentials (if any) and fetch the model catalog with them.
export async function loadModels(def: BackendDef, config: Config): Promise<{ auth: unknown; models: CatalogModel[] }> {
  const auth = def.auth ? await def.auth(config) : undefined;
  return { auth, models: await def.catalog(config, auth) };
}

export async function runBackend(def: BackendDef, config: Config, interactive: boolean, passthrough: string[]): Promise<"back" | void> {
  await ensureHost(def, config, interactive || !cfgGet(config, def.keys.model));

  let auth: unknown;
  let models: CatalogModel[];
  try {
    ({ auth, models } = await loadModels(def, config));
  } catch (err) {
    if (err instanceof BackendError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const K = def.keys;
  let model = cfgGet(config, K.model);
  const saved = model && (def.validateSaved === false || models.some((m) => m.id === model));
  if (interactive || !saved) {
    model = await pickCatalogModel(models, { current: model, allowBack: interactive, search: def.searchPicker });
    if (model === BACK) return "back";
    cfgSet(config, K.model, model);
    config.backend = def.id;

    def.roles.preConfigure?.(config, models);
    if (def.roles.defaultToMain) {
      for (const role of def.roles.order) cfgSet(config, K[role], model);
    }
    const configureRoles = await confirm({ message: def.roles.message, default: def.roles.confirmDefault });
    if (configureRoles) {
      for (const role of def.roles.order) {
        cfgSet(config, K[role], await pickCatalogModel(models, { current: cfgGet(config, K[role]), label: ROLE_LABELS[role], search: def.searchPicker }));
      }
    }

    if (K.effort) {
      const selected = models.find((m) => m.id === model);
      if (selected?.efforts?.length) {
        cfgSet(config, K.effort, await pickCodexEffort(selected.efforts, cfgGet(config, K.effort) ?? selected.defaultEffort));
      }
    }
  }
  saveConfig(config);

  const context = (await resolveContext(def, model!, config, async () => models)) || (def.contextFallback ?? 0);
  const transport = await def.transport(config, auth);
  const creds = def.credentials(auth);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: transport.baseUrl,
    ANTHROPIC_API_KEY: creds.apiKey,
    ...(creds.authToken !== undefined ? { ANTHROPIC_AUTH_TOKEN: creds.authToken } : {}),
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: cfgGet(config, K.sonnet) || model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: cfgGet(config, K.opus) || model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: cfgGet(config, K.haiku) || model,
    ...contextOverrideEnv(context),
  };

  console.log(def.describe(model!, context, transport.port, config));
  launchClaude(passthrough, env, transport.close);
}

export async function resolveContext(def: BackendDef, modelId: string, config: Config, models: () => Promise<CatalogModel[]>): Promise<number> {
  if (def.resolveContext) return def.resolveContext(modelId, config, models);
  return (await models()).find((m) => m.id === modelId)?.context ?? 0;
}

// Local (or LAN) server speaking the Anthropic Messages API natively: Claude
// Code gets the host as ANTHROPIC_BASE_URL directly, no translation proxy.
function nativeAnthropicBackend(opts: {
  id: RoleKeyedBackend;
  longFlag: string;
  shortFlag?: string;
  helpText: string;
  pickerLabel: string;
  host: (config: Config) => string;
  hostPrompt?: BackendDef["host"];
  catalog: (host: string) => Promise<CatalogModel[]>;
  context: (host: string, modelId: string) => Promise<number>;
  tag: string;
}): BackendDef {
  return defineBackend<void>({
    id: opts.id,
    longFlag: opts.longFlag,
    shortFlag: opts.shortFlag,
    helpText: opts.helpText,
    pickerLabel: opts.pickerLabel,
    keys: roleKeys(opts.id),
    host: opts.hostPrompt,
    catalog: (config) => opts.catalog(opts.host(config)),
    roles: LOCAL_ROLES,
    resolveContext: (modelId, config) => opts.context(opts.host(config), modelId),
    transport: async (config) => ({ baseUrl: opts.host(config) }),
    credentials: tokenCredentials(opts.id),
    describe: (model) => `\nLaunching claude with ${model} ${opts.tag}...\n`,
    mixed: {
      route: (config) => (p, res) => forwardAnthropic(`${opts.host(config)}/v1/messages`, {}, p, res),
    },
  });
}

// OpenAI-compatible endpoint behind the in-process Anthropic-to-OpenAI
// translation proxy.
function openAICompatibleBackend(opts: {
  id: RoleKeyedBackend;
  longFlag: string;
  shortFlag?: string;
  helpText: string;
  pickerLabel: string;
  host: (config: Config) => string;
  hostPrompt?: BackendDef["host"];
  // Resolves the API key; may prompt. Absent (or resolving undefined) means
  // an unauthenticated endpoint.
  auth?: (config: Config) => Promise<string | undefined>;
  fetchLabel: string;
  connectError?: (host: string) => string;
  emptyError: string;
  roles: BackendDef["roles"];
  // Live context lookup for servers whose /models omits it.
  context?: (host: string, modelId: string) => Promise<number>;
  credentials?: BackendDef<string | undefined>["credentials"];
  tag: string;
  hasAuth?: (config: Config) => boolean;
  routeKey?: (config: Config) => string | undefined;
}): BackendDef {
  const connectError = opts.connectError ?? ((host: string) => `Failed to connect to ${opts.tag} at ${host}`);
  return defineBackend<string | undefined>({
    id: opts.id,
    longFlag: opts.longFlag,
    shortFlag: opts.shortFlag,
    helpText: opts.helpText,
    pickerLabel: opts.pickerLabel,
    keys: roleKeys(opts.id),
    host: opts.hostPrompt,
    auth: opts.auth,
    hasAuth: opts.hasAuth,
    async catalog(config, key) {
      const host = opts.host(config);
      console.log(opts.fetchLabel);
      let models;
      try {
        models = await fetchOpenAIModels(host, key);
      } catch {
        throw new BackendError(connectError(host));
      }
      if (models.length === 0) {
        throw new BackendError(opts.emptyError);
      }
      return models.map((m) => ({ id: m.id, choiceName: m.id, context: openAIModelContext(m) }));
    },
    roles: opts.roles,
    resolveContext: opts.context ? (modelId, config) => opts.context!(opts.host(config), modelId) : undefined,
    transport: proxyTransport("Starting proxy...", (config, key) => startProxy(opts.host(config), key)),
    credentials: opts.credentials ?? tokenCredentials(opts.id),
    describe: (model, _context, port) => `\nLaunching claude with ${model} (${opts.tag} via proxy :${port})...\n`,
    mixed: {
      route: (config) => (p, res) => handleOpenAIMessages(p as unknown as OpenAIProxyRequest, res, opts.host(config), opts.routeKey?.(config)),
    },
  });
}

const ollamaHost = (c: Config) => c.ollamaHost || "http://localhost:11434";
const lmstudioHost = (c: Config) => c.lmstudioHost || "http://localhost:1234/v1";
const nimHost = (c: Config) => c.nimHost || NIM_CLOUD_HOST;
const LLAMACPP_DEFAULT_HOST = "http://localhost:8080";
const llamacppHost = (c: Config) => c.llamacppHost || LLAMACPP_DEFAULT_HOST;

export const BACKEND_DEFS: BackendDef[] = [
  defineBackend<string>({
    id: "openrouter",
    longFlag: "--openrouter",
    shortFlag: "-o",
    helpText: "Use OpenRouter backend",
    pickerLabel: "OpenRouter (multiple models)",
    mixedLabel: "OpenRouter",
    // Flat key names are persisted in existing user configs, so they can't
    // be renamed to the `<id>Model` scheme roleKeys derives.
    keys: { model: "selectedModel", sonnet: "sonnetModel", opus: "opusModel", haiku: "haikuModel" },
    async auth(config) {
      let apiKey = config.openrouterApiKey;
      if (!apiKey && process.env.OPENROUTER_API_KEY) {
        const useEnv = await confirm({ message: "Use existing OPENROUTER_API_KEY from environment?" });
        if (useEnv) {
          apiKey = process.env.OPENROUTER_API_KEY;
          config.openrouterApiKey = apiKey;
          saveConfig(config);
        }
      }
      if (!apiKey) {
        console.log("No API key found. Starting login...\n");
        apiKey = await login();
        config.openrouterApiKey = apiKey;
        saveConfig(config);
      }
      return apiKey;
    },
    async catalog(config) {
      console.log("Fetching models...");
      const models = filterAgenticModels(await fetchModels());

      const seenModels = config.seenModels || [];
      const newModels = getNewModels(models, seenModels);
      if (newModels.length > 0 && seenModels.length > 0) {
        console.log(`\n${newModels.length} new model(s) available:`);
        newModels.slice(0, 5).forEach((m) => console.log(`  - ${m.name}`));
        if (newModels.length > 5) console.log(`  ... and ${newModels.length - 5} more`);
        console.log();
      }
      config.seenModels = models.map((m) => m.id);
      config.lastModelFetch = new Date().toISOString();

      return models.map((m) => ({
        id: m.hasExacto ? `${m.id}:exacto` : m.id,
        choiceName: `${m.hasExacto ? "[exacto] " : ""}${m.name} [${formatContext(m.context_length)}] ${formatPrice(m)}`,
        description: m.hasExacto ? `${m.id}:exacto` : m.id,
        context: m.context_length,
      }));
    },
    searchPicker: true,
    validateSaved: false,
    hasAuth: (config) => !!config.openrouterApiKey,
    roles: DEFAULT_ROLES,
    // Catalog ids carry the :exacto suffix when the variant exists, while a
    // saved model may predate it; compare with the suffix stripped on both sides.
    async resolveContext(modelId, _config, models) {
      const baseId = modelId.replace(/:exacto$/, "");
      return (await models()).find((m) => m.id.replace(/:exacto$/, "") === baseId)?.context ?? 0;
    },
    transport: proxyTransport("Starting OpenRouter proxy...", () => startOpenRouterProxy()),
    credentials: (apiKey) => ({ apiKey: "", authToken: apiKey }),
    describe: (model, _context, port) => `\nLaunching claude with ${model} (via proxy :${port})...\n`,
    mixed: {
      route: (config) => (p, res) => forwardOpenRouter(config.openrouterApiKey, p, res),
    },
  }),
  defineBackend<void>({
    id: "codex",
    longFlag: "--codex",
    shortFlag: "-c",
    helpText: "Use Codex backend (ChatGPT subscription)",
    pickerLabel: "Codex (ChatGPT subscription)",
    keys: { ...roleKeys("codex"), effort: "codexEffort" },
    async catalog() {
      let models;
      try {
        models = fetchCodexModels();
      } catch (err) {
        return toBackendError(err);
      }
      if (models.length === 0) {
        throw new BackendError("No Codex models available. Run `codex` once while signed in with ChatGPT.");
      }
      return models.map((m) => ({
        id: m.slug,
        choiceName: `${m.displayName} [${formatContext(m.contextWindow)}]`,
        description: m.slug,
        context: m.contextWindow,
        efforts: m.efforts,
        defaultEffort: m.defaultEffort,
      }));
    },
    roles: {
      message: "Customize role models?",
      confirmDefault: false,
      order: ["opus", "sonnet", "haiku"],
      // Map OpenAI's flagship/mid/cheap tiers onto Claude Code's task roles so
      // its router sends hard work to Sol, lighter work to Terra, quick to Luna.
      preConfigure(config, models) {
        const slugs = new Set(models.map((m) => m.id));
        if (slugs.has("gpt-5.6-sol") && slugs.has("gpt-5.6-terra") && slugs.has("gpt-5.6-luna")) {
          config.codexOpusModel = "gpt-5.6-sol";
          config.codexSonnetModel = "gpt-5.6-terra";
          config.codexHaikuModel = "gpt-5.6-luna";
          console.log("Role mapping: opus -> sol, sonnet -> terra, haiku -> luna");
        }
      },
    },
    hasAuth() {
      try {
        return fetchCodexModels().length > 0;
      } catch {
        return false;
      }
    },
    contextFallback: 200000,
    transport: proxyTransport("Starting Codex proxy...", (config) => startCodexProxy(config.codexEffort ?? "medium")),
    credentials: tokenCredentials("codex"),
    describe: (model, context, port, config) =>
      `\nLaunching claude with ${model} @ ${config.codexEffort ?? "medium"} effort, ${formatContext(context)} context (Codex sub via proxy :${port})...\n`,
    mixed: {
      route: (config) => (p, res) => handleCodexMessages(p as unknown as CodexRequest, res, config.codexEffort ?? "medium"),
      effortSuffix: true,
    },
  }),
  defineBackend<GrokAuth>({
    id: "grok",
    longFlag: "--grok",
    shortFlag: "-g",
    helpText: "Use Grok backend (X/SuperGrok subscription)",
    pickerLabel: "Grok (X/SuperGrok subscription)",
    keys: { ...roleKeys("grok"), effort: "grokEffort" },
    auth: () => getGrokAuth().catch(toBackendError),
    hasAuth: hasGrokAuth,
    async catalog(_config, auth) {
      const models = await fetchGrokModels(auth.token).catch(toBackendError);
      if (models.length === 0) {
        throw new BackendError("No Grok models available. Run `grok` once while signed in.");
      }
      return models.map((m) => ({
        id: m.id,
        choiceName: `${m.id} [${formatContext(m.contextWindow)}]`,
        context: m.contextWindow,
        efforts: m.efforts,
        defaultEffort: m.defaultEffort,
      }));
    },
    roles: SUBSCRIPTION_ROLES,
    contextFallback: 200000,
    transport: proxyTransport("Starting Grok proxy...", (config) => startGrokProxy(config.grokEffort)),
    credentials: tokenCredentials("grok"),
    describe: (model, context, port, config) =>
      `\nLaunching claude with ${model}${config.grokEffort ? ` @ ${config.grokEffort} effort` : ""}, ${formatContext(context)} context (Grok sub via proxy :${port})...\n`,
    mixed: {
      route: (config) => (p, res) => handleGrokMessages(p as unknown as GrokBody, res, config.grokEffort),
      effortSuffix: true,
    },
  }),
  defineBackend<{ token: string; identity: KimiIdentity }>({
    id: "kimi",
    longFlag: "--kimi",
    shortFlag: "-k",
    helpText: "Use Kimi backend (Kimi Code subscription)",
    pickerLabel: "Kimi (Kimi Code subscription)",
    keys: roleKeys("kimi"),
    hasAuth() {
      try {
        getKimiIdentity();
        return true;
      } catch {
        return false;
      }
    },
    async auth() {
      try {
        const auth = await getKimiAuth();
        return { token: auth.token, identity: getKimiIdentity() };
      } catch (err) {
        return toBackendError(err);
      }
    },
    async catalog(_config, auth) {
      const models = await fetchKimiModels(auth.token, identityHeaders(auth.identity)).catch(toBackendError);
      if (models.length === 0) {
        throw new BackendError("No Kimi models available. Run `kimi` once while signed in.");
      }
      return models.map((m) => ({
        id: m.id,
        choiceName: m.contextWindow ? `${m.id} [${formatContext(m.contextWindow)}]` : m.id,
        context: m.contextWindow,
      }));
    },
    roles: SUBSCRIPTION_ROLES,
    contextFallback: 200000,
    transport: proxyTransport("Starting Kimi proxy...", (_config, auth: { identity: KimiIdentity }) => startKimiProxy(auth.identity)),
    credentials: tokenCredentials("kimi"),
    describe: (model, context, port) => `\nLaunching claude with ${model}, ${formatContext(context)} context (Kimi sub via proxy :${port})...\n`,
    mixed: {
      route() {
        // hasAuth gates registration, so the identity read cannot fail here
        // short of the credential file vanishing mid-launch.
        const identity = getKimiIdentity();
        return (p, res) => handleKimiMessages(p as unknown as KimiBody, res, identity);
      },
      effortSuffix: true,
      // Kimi's catalog exposes no effort levels; the pin is forwarded in
      // output_config.effort and support depends on the model.
      slotEfforts: () => ["low", "medium", "high", "max"],
    },
  }),
  nativeAnthropicBackend({
    id: "ollama",
    longFlag: "--ollama",
    shortFlag: "-l",
    helpText: "Use Ollama backend (local)",
    pickerLabel: "Ollama (local)",
    host: ollamaHost,
    async catalog(host) {
      console.log("Checking Ollama...");
      let allModels;
      try {
        allModels = await fetchOllamaModels(host);
      } catch {
        throw new BackendError(`Failed to connect to Ollama at ${host}\nMake sure Ollama is running: ollama serve`);
      }
      if (allModels.length === 0) {
        throw new BackendError("No models found. Pull a model first: ollama pull <model>");
      }
      console.log("Checking model capabilities...");
      const models = await filterToolCapableOllamaModels(host, allModels);
      if (models.length === 0) {
        throw new BackendError("No tool-capable models found.\nTry: ollama pull qwen2.5:7b");
      }
      const hidden = allModels.length - models.length;
      if (hidden > 0) {
        console.log(`Showing ${models.length} tool-capable model(s) (${hidden} hidden - no tool support)\n`);
      }
      // Cloud models (`:cloud` suffix) run on Ollama's infra and have no local
      // size, so tag them instead of showing a meaningless byte count.
      return models.map((m) => ({
        id: m.name,
        choiceName: `${m.name} ${m.name.endsWith(":cloud") ? "[cloud]" : `[${formatOllamaSize(m.size)}]`}`,
        context: 0,
      }));
    },
    context: getOllamaContext,
    tag: "(Ollama)",
  }),
  openAICompatibleBackend({
    id: "nim",
    longFlag: "--nim",
    shortFlag: "-n",
    helpText: "Use NVIDIA NIM backend",
    pickerLabel: "NIM (NVIDIA)",
    host: nimHost,
    async auth(config) {
      const isCloud = nimHost(config) === NIM_CLOUD_HOST;
      let apiKey = config.nimApiKey;
      // Self-hosted NIMs run keyless; undefined means no Authorization header.
      if (!isCloud) return apiKey || process.env.NVIDIA_API_KEY;
      if (!apiKey && process.env.NVIDIA_API_KEY) {
        const useEnv = await confirm({ message: "Use existing NVIDIA_API_KEY from environment?" });
        if (useEnv) {
          apiKey = process.env.NVIDIA_API_KEY;
          config.nimApiKey = apiKey;
          saveConfig(config);
        }
      }
      if (!apiKey) {
        apiKey = await input({ message: "Enter NVIDIA API key (nvapi-...):" });
        config.nimApiKey = apiKey;
        saveConfig(config);
      }
      return apiKey;
    },
    fetchLabel: "Fetching NIM models...",
    emptyError: "No models found on NIM endpoint.",
    roles: DEFAULT_ROLES,
    // A non-empty ANTHROPIC_API_KEY keeps Claude Code off subscription OAuth
    // even when the endpoint itself is keyless.
    credentials: (apiKey) => ({ apiKey: apiKey ?? "not-used" }),
    tag: "NIM",
    hasAuth: (config) => !!(config.nimApiKey || config.nimHost),
    routeKey: (config) => config.nimApiKey,
  }),
  openAICompatibleBackend({
    id: "lmstudio",
    longFlag: "--lmstudio",
    shortFlag: "-s",
    helpText: "Use LM Studio backend (local)",
    pickerLabel: "LM Studio (local)",
    host: lmstudioHost,
    fetchLabel: "Fetching LM Studio models...",
    connectError: (host) => `Failed to connect to LM Studio at ${host}\nMake sure the LM Studio server is running.`,
    emptyError: "No models found. Load a model in LM Studio first.",
    roles: LOCAL_ROLES,
    context: getLmStudioContext,
    credentials: tokenCredentials("lmstudio"),
    tag: "LM Studio",
  }),
  nativeAnthropicBackend({
    id: "llamacpp",
    longFlag: "--llamacpp",
    helpText: "Use llama.cpp backend (local)",
    pickerLabel: "llama.cpp (local)",
    host: llamacppHost,
    hostPrompt: { key: "llamacppHost", default: LLAMACPP_DEFAULT_HOST, message: "llama-server URL (server root, no /v1):" },
    async catalog(host) {
      console.log("Fetching llama.cpp models...");
      let models;
      try {
        models = await fetchOpenAIModels(`${host}/v1`);
      } catch {
        throw new BackendError(`Failed to connect to llama.cpp at ${host}\nMake sure llama-server is running.`);
      }
      if (models.length === 0) {
        throw new BackendError("No models found on llama.cpp server.");
      }
      return models.map((m) => ({ id: m.id, choiceName: m.id, context: 0 }));
    },
    context: (host) => getLlamaCppContext(host),
    tag: "(llama.cpp)",
  }),
];

export const defById = (id: string): BackendDef | undefined => BACKEND_DEFS.find((d) => d.id === id);
