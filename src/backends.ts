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
import { getGrokAuth } from "./grok-auth";
import { startGrokProxy, handleGrokMessages, type AnthropicBody as GrokBody } from "./grok-proxy";
import { getKimiAuth, getKimiIdentity, identityHeaders, type KimiIdentity } from "./kimi-auth";
import { startKimiProxy, handleKimiMessages, type KimiBody } from "./kimi-proxy";
import type { MixedHandler } from "./mixed-proxy";

export const NIM_CLOUD_HOST = "https://integrate.api.nvidia.com/v1";

// A user-facing failure with a clean message (unreachable host, missing
// login, empty catalog). runBackend prints it without a stack and exits;
// anything else propagates as a real crash.
export class BackendError extends Error {}

export interface Catalog {
  models: CatalogModel[];
  // Credential forwarded into the launch env (ANTHROPIC_AUTH_TOKEN or
  // ANTHROPIC_API_KEY depending on the backend's credentials()).
  authKey?: string;
  // Backend-private auth state the transport needs (e.g. Kimi identity).
  authCtx?: unknown;
}

type RoleSlot = "sonnet" | "opus" | "haiku";

export interface BackendDef {
  id: Backend;
  longFlag: string;
  shortFlag: string;
  helpText: string;
  pickerLabel: string;
  // Label in the mixed-mode slot picker when it differs from pickerLabel.
  mixedLabel?: string;
  keys: {
    model: keyof Config;
    sonnet: keyof Config;
    opus: keyof Config;
    haiku: keyof Config;
    effort?: keyof Config;
  };
  loadCatalog(config: Config): Promise<Catalog>;
  // Prompt for the server host during interactive setup (LAN servers).
  host?: { key: keyof Config; default: string; message: string };
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
  pickEffort?: boolean;
  // Context window for the chosen model; defaults to the catalog entry.
  resolveContext?(models: CatalogModel[], modelId: string, config: Config): Promise<number>;
  // Applied when the resolved context is 0/unknown (subscription backends
  // assume the standard 200k window rather than no override).
  contextFallback?: number;
  transport(config: Config, cat: Catalog): Promise<{ baseUrl: string; port?: number; close?: () => void }>;
  credentials(cat: Catalog): { apiKey: string; authToken?: string };
  describe(model: string, context: number, port: number | undefined, config: Config): string;
  mixed: {
    route(config: Config): MixedHandler | undefined;
    // Efforts offered when pinning a mixed slot; defaults to the catalog
    // entry's efforts.
    slotEfforts?(model: CatalogModel): string[];
  };
}

const cfgGet = (config: Config, key: keyof Config): string | undefined => config[key] as string | undefined;
const cfgSet = (config: Config, key: keyof Config, value: string | undefined): void => {
  (config as Record<string, unknown>)[key] = value;
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

export async function runBackend(def: BackendDef, config: Config, interactive: boolean, passthrough: string[]): Promise<"back" | void> {
  // The host must be known before the catalog fetch, so this prompts on the
  // pre-fetch signals of a setup run: -b, or no model saved yet.
  if (def.host && (interactive || !cfgGet(config, def.keys.model))) {
    const current = cfgGet(config, def.host.key);
    const host = await input({ message: def.host.message, default: current || def.host.default });
    cfgSet(config, def.host.key, host.replace(/\/+$/, ""));
    saveConfig(config);
  }

  let cat: Catalog;
  try {
    cat = await def.loadCatalog(config);
  } catch (err) {
    if (err instanceof BackendError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const K = def.keys;
  let model = cfgGet(config, K.model);
  const saved = model && (def.validateSaved === false || cat.models.some((m) => m.id === model));
  if (interactive || !saved) {
    model = await pickCatalogModel(cat.models, { current: model, allowBack: interactive, search: def.searchPicker });
    if (model === BACK) return "back";
    cfgSet(config, K.model, model);
    config.backend = def.id;

    def.roles.preConfigure?.(config, cat.models);
    if (def.roles.defaultToMain) {
      for (const role of def.roles.order) cfgSet(config, K[role], model);
    }
    const configureRoles = await confirm({ message: def.roles.message, default: def.roles.confirmDefault });
    if (configureRoles) {
      for (const role of def.roles.order) {
        cfgSet(config, K[role], await pickCatalogModel(cat.models, { current: cfgGet(config, K[role]), label: ROLE_LABELS[role] }));
      }
    }

    if (def.pickEffort && K.effort) {
      const selected = cat.models.find((m) => m.id === model);
      if (selected?.efforts?.length) {
        cfgSet(config, K.effort, await pickCodexEffort(selected.efforts, cfgGet(config, K.effort) ?? selected.defaultEffort));
      }
    }
  }
  saveConfig(config);

  const context = (await resolveContext(def, cat.models, model!, config)) || (def.contextFallback ?? 0);
  const transport = await def.transport(config, cat);
  const creds = def.credentials(cat);
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

export async function resolveContext(def: BackendDef, models: CatalogModel[], modelId: string, config: Config): Promise<number> {
  if (def.resolveContext) return def.resolveContext(models, modelId, config);
  return models.find((m) => m.id === modelId)?.context ?? 0;
}

export const BACKEND_DEFS: BackendDef[] = [
  {
    id: "openrouter",
    longFlag: "--openrouter",
    shortFlag: "-o",
    helpText: "Use OpenRouter backend",
    pickerLabel: "OpenRouter (multiple models)",
    mixedLabel: "OpenRouter",
    keys: { model: "selectedModel", sonnet: "sonnetModel", opus: "opusModel", haiku: "haikuModel" },
    async loadCatalog(config) {
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

      return {
        models: models.map((m) => ({
          id: m.hasExacto ? `${m.id}:exacto` : m.id,
          choiceName: `${m.hasExacto ? "[exacto] " : ""}${m.name} [${formatContext(m.context_length)}] ${formatPrice(m)}`,
          description: m.hasExacto ? `${m.id}:exacto` : m.id,
          context: m.context_length,
        })),
        authKey: apiKey,
      };
    },
    searchPicker: true,
    validateSaved: false,
    roles: { message: "Configure role models?", confirmDefault: false, order: ["sonnet", "opus", "haiku"] },
    async resolveContext(models, modelId) {
      const baseId = modelId.replace(/:exacto$/, "");
      return models.find((m) => m.id === modelId || m.id === baseId)?.context ?? 0;
    },
    transport: async () => ({ baseUrl: "https://openrouter.ai/api" }),
    credentials: (cat) => ({ apiKey: "", authToken: cat.authKey }),
    describe: (model) => `\nLaunching claude with ${model}...\n`,
    mixed: {
      route(config) {
        const key = config.openrouterApiKey;
        if (!key) return undefined;
        return (p, res) => forwardAnthropic("https://openrouter.ai/api/v1/messages", { Authorization: `Bearer ${key}` }, p, res);
      },
    },
  },
  {
    id: "codex",
    longFlag: "--codex",
    shortFlag: "-c",
    helpText: "Use Codex backend (ChatGPT subscription)",
    pickerLabel: "Codex (ChatGPT subscription)",
    keys: { model: "codexModel", sonnet: "codexSonnetModel", opus: "codexOpusModel", haiku: "codexHaikuModel", effort: "codexEffort" },
    async loadCatalog() {
      let models;
      try {
        models = fetchCodexModels();
      } catch (err) {
        throw new BackendError(err instanceof Error ? err.message : String(err));
      }
      if (models.length === 0) {
        throw new BackendError("No Codex models available. Run `codex` once while signed in with ChatGPT.");
      }
      return {
        models: models.map((m) => ({
          id: m.slug,
          choiceName: `${m.displayName} [${formatContext(m.contextWindow)}]`,
          description: m.slug,
          context: m.contextWindow,
          efforts: m.efforts,
          defaultEffort: m.defaultEffort,
        })),
      };
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
    pickEffort: true,
    contextFallback: 200000,
    async transport(config) {
      console.log("Starting Codex proxy...");
      const proxy = await startCodexProxy(config.codexEffort ?? "medium");
      return { baseUrl: `http://127.0.0.1:${proxy.port}`, port: proxy.port, close: proxy.close };
    },
    credentials: () => ({ apiKey: "", authToken: "codex" }),
    describe: (model, context, port, config) =>
      `\nLaunching claude with ${model} @ ${config.codexEffort ?? "medium"} effort, ${formatContext(context)} context (Codex sub via proxy :${port})...\n`,
    mixed: {
      route: () => (p, res) => handleCodexMessages(p as unknown as CodexRequest, res, "medium"),
    },
  },
  {
    id: "grok",
    longFlag: "--grok",
    shortFlag: "-g",
    helpText: "Use Grok backend (X/SuperGrok subscription)",
    pickerLabel: "Grok (X/SuperGrok subscription)",
    keys: { model: "grokModel", sonnet: "grokSonnetModel", opus: "grokOpusModel", haiku: "grokHaikuModel", effort: "grokEffort" },
    async loadCatalog() {
      let models;
      try {
        const auth = await getGrokAuth();
        models = await fetchGrokModels(auth.token);
      } catch (err) {
        throw new BackendError(err instanceof Error ? err.message : String(err));
      }
      if (models.length === 0) {
        throw new BackendError("No Grok models available. Run `grok` once while signed in.");
      }
      return {
        models: models.map((m) => ({
          id: m.id,
          choiceName: `${m.id} [${formatContext(m.contextWindow)}]`,
          context: m.contextWindow,
          efforts: m.efforts,
          defaultEffort: m.defaultEffort,
        })),
      };
    },
    roles: { message: "Use a faster model for lighter roles?", confirmDefault: false, defaultToMain: true, order: ["opus", "sonnet", "haiku"] },
    pickEffort: true,
    contextFallback: 200000,
    async transport(config) {
      console.log("Starting Grok proxy...");
      const proxy = await startGrokProxy(config.grokEffort);
      return { baseUrl: `http://127.0.0.1:${proxy.port}`, port: proxy.port, close: proxy.close };
    },
    credentials: () => ({ apiKey: "", authToken: "grok" }),
    describe: (model, context, port, config) =>
      `\nLaunching claude with ${model}${config.grokEffort ? ` @ ${config.grokEffort} effort` : ""}, ${formatContext(context)} context (Grok sub via proxy :${port})...\n`,
    mixed: {
      route: (config) => (p, res) => handleGrokMessages(p as unknown as GrokBody, res, config.grokEffort),
    },
  },
  {
    id: "kimi",
    longFlag: "--kimi",
    shortFlag: "-k",
    helpText: "Use Kimi backend (Kimi Code subscription)",
    pickerLabel: "Kimi (Kimi Code subscription)",
    keys: { model: "kimiModel", sonnet: "kimiSonnetModel", opus: "kimiOpusModel", haiku: "kimiHaikuModel" },
    async loadCatalog() {
      let models;
      let identity: KimiIdentity;
      try {
        const auth = await getKimiAuth();
        identity = getKimiIdentity();
        models = await fetchKimiModels(auth.token, identityHeaders(identity));
      } catch (err) {
        throw new BackendError(err instanceof Error ? err.message : String(err));
      }
      if (models.length === 0) {
        throw new BackendError("No Kimi models available. Run `kimi` once while signed in.");
      }
      return {
        models: models.map((m) => ({
          id: m.id,
          choiceName: m.contextWindow ? `${m.id} [${formatContext(m.contextWindow)}]` : m.id,
          context: m.contextWindow,
        })),
        authCtx: identity,
      };
    },
    roles: { message: "Use a faster model for lighter roles?", confirmDefault: false, defaultToMain: true, order: ["opus", "sonnet", "haiku"] },
    contextFallback: 200000,
    async transport(_config, cat) {
      console.log("Starting Kimi proxy...");
      const proxy = await startKimiProxy(cat.authCtx as KimiIdentity);
      return { baseUrl: `http://127.0.0.1:${proxy.port}`, port: proxy.port, close: proxy.close };
    },
    credentials: () => ({ apiKey: "", authToken: "kimi" }),
    describe: (model, context, port) => `\nLaunching claude with ${model}, ${formatContext(context)} context (Kimi sub via proxy :${port})...\n`,
    mixed: {
      route() {
        try {
          const identity = getKimiIdentity();
          return (p, res) => handleKimiMessages(p as unknown as KimiBody, res, identity);
        } catch {
          // No Kimi login; kimi: models fall through to Anthropic's model error.
          return undefined;
        }
      },
      // Kimi's catalog exposes no effort levels; the pin is forwarded in
      // output_config.effort and support depends on the model.
      slotEfforts: () => ["low", "medium", "high", "max"],
    },
  },
  {
    id: "ollama",
    longFlag: "--ollama",
    shortFlag: "-l",
    helpText: "Use Ollama backend (local)",
    pickerLabel: "Ollama (local)",
    keys: { model: "ollamaModel", sonnet: "ollamaSonnetModel", opus: "ollamaOpusModel", haiku: "ollamaHaikuModel" },
    async loadCatalog(config) {
      const host = config.ollamaHost || "http://localhost:11434";
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
      return {
        models: models.map((m) => ({
          // Cloud models (`:cloud` suffix) run on Ollama's infra and have no local
          // size, so tag them instead of showing a meaningless byte count.
          id: m.name,
          choiceName: `${m.name} ${m.name.endsWith(":cloud") ? "[cloud]" : `[${formatOllamaSize(m.size)}]`}`,
          context: 0,
        })),
      };
    },
    roles: { message: "Configure role models? (ensures all requests stay local)", confirmDefault: true, order: ["sonnet", "opus", "haiku"] },
    resolveContext: (_models, modelId, config) => getOllamaContext(config.ollamaHost || "http://localhost:11434", modelId),
    transport: async (config) => ({ baseUrl: config.ollamaHost || "http://localhost:11434" }),
    credentials: () => ({ apiKey: "", authToken: "ollama" }),
    describe: (model) => `\nLaunching claude with ${model} (Ollama)...\n`,
    mixed: {
      route: (config) => (p, res) => forwardAnthropic(`${config.ollamaHost || "http://localhost:11434"}/v1/messages`, {}, p, res),
    },
  },
  {
    id: "nim",
    longFlag: "--nim",
    shortFlag: "-n",
    helpText: "Use NVIDIA NIM backend",
    pickerLabel: "NIM (NVIDIA)",
    keys: { model: "nimModel", sonnet: "nimSonnetModel", opus: "nimOpusModel", haiku: "nimHaikuModel" },
    async loadCatalog(config) {
      const host = config.nimHost || NIM_CLOUD_HOST;
      const isCloud = host === NIM_CLOUD_HOST;
      let apiKey = config.nimApiKey;
      if (isCloud) {
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
      } else {
        apiKey = apiKey || process.env.NVIDIA_API_KEY || "not-used";
      }
      console.log("Fetching NIM models...");
      const models = await fetchOpenAIModels(host, apiKey !== "not-used" ? apiKey : undefined);
      if (models.length === 0) {
        throw new BackendError("No models found on NIM endpoint.");
      }
      return {
        models: models.map((m) => ({ id: m.id, choiceName: m.id, context: openAIModelContext(m) })),
        authKey: apiKey,
      };
    },
    roles: { message: "Configure role models?", confirmDefault: false, order: ["sonnet", "opus", "haiku"] },
    async transport(config, cat) {
      console.log("Starting proxy...");
      const proxy = await startProxy(config.nimHost || NIM_CLOUD_HOST, cat.authKey!);
      return { baseUrl: `http://127.0.0.1:${proxy.port}`, port: proxy.port, close: proxy.close };
    },
    credentials: (cat) => ({ apiKey: cat.authKey! }),
    describe: (model, _context, port) => `\nLaunching claude with ${model} (NIM via proxy :${port})...\n`,
    mixed: {
      route(config) {
        if (!config.nimApiKey && !config.nimHost) return undefined;
        return (p, res) => handleOpenAIMessages(p as unknown as OpenAIProxyRequest, res, config.nimHost || NIM_CLOUD_HOST, config.nimApiKey);
      },
    },
  },
  {
    id: "lmstudio",
    longFlag: "--lmstudio",
    shortFlag: "-s",
    helpText: "Use LM Studio backend (local)",
    pickerLabel: "LM Studio (local)",
    keys: { model: "lmstudioModel", sonnet: "lmstudioSonnetModel", opus: "lmstudioOpusModel", haiku: "lmstudioHaikuModel" },
    async loadCatalog(config) {
      const host = config.lmstudioHost || "http://localhost:1234/v1";
      console.log("Fetching LM Studio models...");
      let models;
      try {
        models = await fetchOpenAIModels(host);
      } catch {
        throw new BackendError(`Failed to connect to LM Studio at ${host}\nMake sure the LM Studio server is running.`);
      }
      if (models.length === 0) {
        throw new BackendError("No models found. Load a model in LM Studio first.");
      }
      return { models: models.map((m) => ({ id: m.id, choiceName: m.id, context: 0 })) };
    },
    roles: { message: "Configure role models? (ensures all requests stay local)", confirmDefault: true, order: ["sonnet", "opus", "haiku"] },
    resolveContext: (_models, modelId, config) => getLmStudioContext(config.lmstudioHost || "http://localhost:1234/v1", modelId),
    async transport(config) {
      console.log("Starting proxy...");
      const proxy = await startProxy(config.lmstudioHost || "http://localhost:1234/v1");
      return { baseUrl: `http://127.0.0.1:${proxy.port}`, port: proxy.port, close: proxy.close };
    },
    credentials: () => ({ apiKey: "", authToken: "lmstudio" }),
    describe: (model, _context, port) => `\nLaunching claude with ${model} (LM Studio via proxy :${port})...\n`,
    mixed: {
      route: (config) => (p, res) =>
        handleOpenAIMessages(p as unknown as OpenAIProxyRequest, res, config.lmstudioHost || "http://localhost:1234/v1"),
    },
  },
  {
    id: "llamacpp",
    longFlag: "--llamacpp",
    shortFlag: "-p",
    helpText: "Use llama.cpp backend (local)",
    pickerLabel: "llama.cpp (local)",
    keys: { model: "llamacppModel", sonnet: "llamacppSonnetModel", opus: "llamacppOpusModel", haiku: "llamacppHaikuModel" },
    host: { key: "llamacppHost", default: "http://localhost:8080", message: "llama-server URL (server root, no /v1):" },
    async loadCatalog(config) {
      const host = config.llamacppHost || "http://localhost:8080";
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
      return { models: models.map((m) => ({ id: m.id, choiceName: m.id, context: 0 })) };
    },
    roles: { message: "Configure role models? (ensures all requests stay local)", confirmDefault: true, order: ["sonnet", "opus", "haiku"] },
    resolveContext: (_models, _modelId, config) => getLlamaCppContext(config.llamacppHost || "http://localhost:8080"),
    // llama-server implements the Anthropic Messages API natively, so Claude
    // Code talks to it directly - no translation proxy.
    transport: async (config) => ({ baseUrl: config.llamacppHost || "http://localhost:8080" }),
    credentials: () => ({ apiKey: "", authToken: "llamacpp" }),
    describe: (model) => `\nLaunching claude with ${model} (llama.cpp)...\n`,
    mixed: {
      route: (config) => (p, res) =>
        forwardAnthropic(`${config.llamacppHost || "http://localhost:8080"}/v1/messages`, {}, p, res),
    },
  },
];

export const defById = (id: string): BackendDef | undefined => BACKEND_DEFS.find((d) => d.id === id);
