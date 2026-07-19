#!/usr/bin/env bun
import { spawn } from "child_process";
import { confirm, input } from "@inquirer/prompts";
import { getConfig, saveConfig, type Backend } from "./config";
import { fetchModels, filterAgenticModels, getNewModels, fetchOllamaModels, filterToolCapableOllamaModels, fetchOpenAIModels, fetchCodexModels, fetchGrokModels, fetchKimiModels, formatContext, getOllamaContext, openAIModelContext, getLmStudioContext } from "./models";
import { pickBackend, pickModel, pickOllamaModel, pickOpenAIModel, pickCodexModel, pickCodexEffort, pickGrokModel, pickKimiModel, pickMixedBackend, pickSlotEffort, BACK } from "./picker";
import { login } from "./auth";
import { startProxy, handleOpenAIMessages, type AnthropicRequest as OpenAIProxyRequest } from "./proxy";
import { startCodexProxy, handleCodexMessages, type AnthropicRequest as CodexRequest } from "./codex-proxy";
import { startMixedProxy, type MixedHandler } from "./mixed-proxy";
import { forwardAnthropic } from "./proxy-shared";
import { getGrokAuth } from "./grok-auth";
import { startGrokProxy, handleGrokMessages, type AnthropicBody as GrokBody } from "./grok-proxy";
import { getKimiAuth, getKimiIdentity, identityHeaders } from "./kimi-auth";
import { startKimiProxy, handleKimiMessages, type KimiBody } from "./kimi-proxy";

const args = process.argv.slice(2);

const NIM_CLOUD_HOST = "https://integrate.api.nvidia.com/v1";

function parseArgs() {
  const flags = {
    openrouter: false,
    anthropic: false,
    ollama: false,
    nim: false,
    lmstudio: false,
    codex: false,
    grok: false,
    kimi: false,
    mixed: false,
    backend: false,
    help: false,
    login: false,
    logout: false,
  };
  const passthrough: string[] = [];
  let seenDash = false;

  for (const arg of args) {
    if (seenDash) {
      passthrough.push(arg);
    } else if (arg === "--") {
      seenDash = true;
    } else if (arg === "--openrouter" || arg === "-o") {
      flags.openrouter = true;
    } else if (arg === "--anthropic" || arg === "-a") {
      flags.anthropic = true;
    } else if (arg === "--ollama" || arg === "-l") {
      flags.ollama = true;
    } else if (arg === "--nim" || arg === "-n") {
      flags.nim = true;
    } else if (arg === "--lmstudio" || arg === "-s") {
      flags.lmstudio = true;
    } else if (arg === "--codex" || arg === "-c") {
      flags.codex = true;
    } else if (arg === "--grok" || arg === "-g") {
      flags.grok = true;
    } else if (arg === "--kimi" || arg === "-k") {
      flags.kimi = true;
    } else if (arg === "--mixed" || arg === "-x") {
      flags.mixed = true;
    } else if (arg === "--backend" || arg === "-b" || arg === "--model" || arg === "-m") {
      flags.backend = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "login") {
      flags.login = true;
    } else if (arg === "logout") {
      flags.logout = true;
    } else {
      passthrough.push(arg);
    }
  }

  return { flags, passthrough };
}

function launchClaude(passthrough: string[], env?: NodeJS.ProcessEnv, onExit?: () => void) {
  const child = spawn("claude", passthrough, { env, stdio: "inherit" });
  child.on("exit", (code) => {
    onExit?.();
    process.exit(code || 0);
  });
}

// Claude Code caps non-first-party base URLs at 200k (claude-code#46416). The
// MAX_CONTEXT_TOKENS override is only honored when auto-compaction is disabled,
// so both are set together to reach a model's real window when it exceeds 200k.
function contextOverrideEnv(contextWindow: number): Record<string, string> {
  if (!contextWindow || contextWindow <= 200000) return {};
  return { DISABLE_COMPACT: "1", CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow) };
}

function showHelp() {
  console.log(`claude-launcher - Launch Claude Code with multiple backends

Usage: claude-launcher [command] [options] [-- claude-args...]

Commands:
  login             Authenticate with OpenRouter
  logout            Clear stored OpenRouter API key

Options:
  -b, --backend     Pick backend and model interactively
  -m, --model       Alias for -b
  -o, --openrouter  Use OpenRouter backend
  -a, --anthropic   Use Anthropic backend
  -c, --codex       Use Codex backend (ChatGPT subscription)
  -x, --mixed       Use Mixed backend (Anthropic native + any backend per role slot)
  -g, --grok        Use Grok backend (X/SuperGrok subscription)
  -k, --kimi        Use Kimi backend (Kimi Code subscription)
  -l, --ollama      Use Ollama backend (local)
  -n, --nim         Use NVIDIA NIM backend
  -s, --lmstudio    Use LM Studio backend (local)
  -h, --help        Show this help

Examples:
  claude-launcher login              # authenticate with OpenRouter
  claude-launcher                    # uses last backend/model
  claude-launcher -b                 # pick backend and model
  claude-launcher -l                 # use Ollama local backend
  claude-launcher -n                 # use NVIDIA NIM backend
  claude-launcher -s                 # use LM Studio local backend
  claude-launcher -- --resume        # pass args to claude`);
}

async function main() {
  const { flags, passthrough } = parseArgs();

  if (flags.help) {
    showHelp();
    process.exit(0);
  }

  const config = getConfig();

  // Handle login command
  if (flags.login) {
    const apiKey = await login();
    config.openrouterApiKey = apiKey;
    config.backend = "openrouter";
    saveConfig(config);
    console.log("Logged in successfully!");
    process.exit(0);
  }

  // Handle logout command
  if (flags.logout) {
    delete config.openrouterApiKey;
    saveConfig(config);
    console.log("Logged out.");
    process.exit(0);
  }

  let backend: Backend;
  let selectedModel = config.selectedModel;

  // Determine backend
  if (flags.backend) {
    backend = await pickBackend(config.backend);
    config.backend = backend;
    saveConfig(config);
  } else if (flags.openrouter) {
    backend = "openrouter";
  } else if (flags.anthropic) {
    backend = "anthropic";
  } else if (flags.ollama) {
    backend = "ollama";
  } else if (flags.nim) {
    backend = "nim";
  } else if (flags.lmstudio) {
    backend = "lmstudio";
  } else if (flags.codex) {
    backend = "codex";
  } else if (flags.grok) {
    backend = "grok";
  } else if (flags.kimi) {
    backend = "kimi";
  } else if (flags.mixed) {
    backend = "mixed";
  } else if (config.backend) {
    backend = config.backend;
  } else {
    backend = await pickBackend();
    config.backend = backend;
    saveConfig(config);
  }

  // OpenRouter-specific setup
  if (backend === "openrouter") {
    let apiKey = config.openrouterApiKey;

    // Check for env var if no stored key
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

    // Fetch models
    console.log("Fetching models...");
    const allModels = await fetchModels();
    const models = filterAgenticModels(allModels);

    // Check for new models
    const seenModels = config.seenModels || [];
    const newModels = getNewModels(models, seenModels);
    if (newModels.length > 0 && seenModels.length > 0) {
      console.log(`\n${newModels.length} new model(s) available:`);
      newModels.slice(0, 5).forEach((m) => console.log(`  - ${m.name}`));
      if (newModels.length > 5) console.log(`  ... and ${newModels.length - 5} more`);
      console.log();
    }

    // Update seen models
    config.seenModels = models.map((m) => m.id);
    config.lastModelFetch = new Date().toISOString();

    // Model selection
    if (flags.backend || !selectedModel) {
      selectedModel = await pickModel(models, selectedModel, undefined, flags.backend);
      if (selectedModel === BACK) return main();
      config.selectedModel = selectedModel;

      const configureRoles = await confirm({
        message: "Configure role models?",
        default: false,
      });

      if (configureRoles) {
        config.sonnetModel = await pickModel(models, config.sonnetModel, "Sonnet (lighter tasks)");
        config.opusModel = await pickModel(models, config.opusModel, "Opus (complex tasks)");
        config.haikuModel = await pickModel(models, config.haikuModel, "Haiku (quick/cheap)");
      }
    }

    saveConfig(config);

    const baseId = selectedModel?.replace(/:exacto$/, "");
    const orContext = models.find((m) => m.id === baseId)?.context_length ?? 0;
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: config.sonnetModel || selectedModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: config.opusModel || selectedModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: config.haikuModel || selectedModel,
      ...contextOverrideEnv(orContext),
    };

    console.log(`\nLaunching claude with ${selectedModel}...\n`);
    launchClaude(passthrough, env);
  } else if (backend === "ollama") {
    const host = config.ollamaHost || "http://localhost:11434";

    // Check Ollama is running
    console.log("Checking Ollama...");
    let allModels;
    try {
      allModels = await fetchOllamaModels(host);
    } catch {
      console.error(`Failed to connect to Ollama at ${host}`);
      console.error("Make sure Ollama is running: ollama serve");
      process.exit(1);
    }

    if (allModels.length === 0) {
      console.error("No models found. Pull a model first: ollama pull <model>");
      process.exit(1);
    }

    // Filter to tool-capable models
    console.log("Checking model capabilities...");
    const models = await filterToolCapableOllamaModels(host, allModels);

    if (models.length === 0) {
      console.error("No tool-capable models found.");
      console.error("Try: ollama pull qwen2.5:7b");
      process.exit(1);
    }

    const hidden = allModels.length - models.length;
    if (hidden > 0) {
      console.log(`Showing ${models.length} tool-capable model(s) (${hidden} hidden - no tool support)\n`);
    }

    // Model selection
    let ollamaModel = config.ollamaModel;
    if (flags.backend || !ollamaModel || !models.some((m) => m.name === ollamaModel)) {
      ollamaModel = await pickOllamaModel(models, undefined, flags.backend);
      if (ollamaModel === BACK) return main();
      config.ollamaModel = ollamaModel;
      config.backend = "ollama";

      const configureRoles = await confirm({
        message: "Configure role models? (ensures all requests stay local)",
        default: true,
      });

      if (configureRoles) {
        config.ollamaSonnetModel = await pickOllamaModel(models, "Sonnet (lighter tasks)");
        config.ollamaOpusModel = await pickOllamaModel(models, "Opus (complex tasks)");
        config.ollamaHaikuModel = await pickOllamaModel(models, "Haiku (quick/cheap)");
      }

      saveConfig(config);
    }

    const ollamaContext = await getOllamaContext(host, ollamaModel);
    // Launch with Ollama env vars - set all role models to stay fully local
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: host,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "ollama",
      ANTHROPIC_MODEL: ollamaModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: config.ollamaSonnetModel || ollamaModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: config.ollamaOpusModel || ollamaModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: config.ollamaHaikuModel || ollamaModel,
      ...contextOverrideEnv(ollamaContext),
    };

    console.log(`\nLaunching claude with ${ollamaModel} (Ollama)...\n`);
    launchClaude(passthrough, env);
  } else if (backend === "nim") {
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
      console.error("No models found on NIM endpoint.");
      process.exit(1);
    }

    let nimModel = config.nimModel;
    if (flags.backend || !nimModel || !models.some((m) => m.id === nimModel)) {
      nimModel = await pickOpenAIModel(models, undefined, flags.backend);
      if (nimModel === BACK) return main();
      config.nimModel = nimModel;
      config.backend = "nim";

      const configureRoles = await confirm({
        message: "Configure role models?",
        default: false,
      });

      if (configureRoles) {
        config.nimSonnetModel = await pickOpenAIModel(models, "Sonnet (lighter tasks)");
        config.nimOpusModel = await pickOpenAIModel(models, "Opus (complex tasks)");
        config.nimHaikuModel = await pickOpenAIModel(models, "Haiku (quick/cheap)");
      }

      saveConfig(config);
    }

    console.log("Starting proxy...");
    const proxy = await startProxy(host, apiKey!);

    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_MODEL: nimModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: config.nimSonnetModel || nimModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: config.nimOpusModel || nimModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: config.nimHaikuModel || nimModel,
      ...contextOverrideEnv(openAIModelContext(models.find((m) => m.id === nimModel))),
    };

    console.log(`\nLaunching claude with ${nimModel} (NIM via proxy :${proxy.port})...\n`);
    launchClaude(passthrough, env, () => proxy.close());
  } else if (backend === "lmstudio") {
    const host = config.lmstudioHost || "http://localhost:1234/v1";

    console.log("Fetching LM Studio models...");
    let models;
    try {
      models = await fetchOpenAIModels(host);
    } catch {
      console.error(`Failed to connect to LM Studio at ${host}`);
      console.error("Make sure the LM Studio server is running.");
      process.exit(1);
    }

    if (models.length === 0) {
      console.error("No models found. Load a model in LM Studio first.");
      process.exit(1);
    }

    let lmstudioModel = config.lmstudioModel;
    if (flags.backend || !lmstudioModel || !models.some((m) => m.id === lmstudioModel)) {
      lmstudioModel = await pickOpenAIModel(models, undefined, flags.backend);
      if (lmstudioModel === BACK) return main();
      config.lmstudioModel = lmstudioModel;
      config.backend = "lmstudio";

      const configureRoles = await confirm({
        message: "Configure role models? (ensures all requests stay local)",
        default: true,
      });

      if (configureRoles) {
        config.lmstudioSonnetModel = await pickOpenAIModel(models, "Sonnet (lighter tasks)");
        config.lmstudioOpusModel = await pickOpenAIModel(models, "Opus (complex tasks)");
        config.lmstudioHaikuModel = await pickOpenAIModel(models, "Haiku (quick/cheap)");
      }

      saveConfig(config);
    }

    console.log("Starting proxy...");
    const proxy = await startProxy(host);

    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "lmstudio",
      ANTHROPIC_MODEL: lmstudioModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: config.lmstudioSonnetModel || lmstudioModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: config.lmstudioOpusModel || lmstudioModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: config.lmstudioHaikuModel || lmstudioModel,
      ...contextOverrideEnv(await getLmStudioContext(host, lmstudioModel)),
    };

    console.log(`\nLaunching claude with ${lmstudioModel} (LM Studio via proxy :${proxy.port})...\n`);
    launchClaude(passthrough, env, () => proxy.close());
  } else if (backend === "codex") {
    let models;
    try {
      models = fetchCodexModels();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    if (models.length === 0) {
      console.error("No Codex models available. Run `codex` once while signed in with ChatGPT.");
      process.exit(1);
    }

    let codexModel = config.codexModel;
    if (flags.backend || !codexModel || !models.some((m) => m.slug === codexModel)) {
      codexModel = await pickCodexModel(models, codexModel, undefined, flags.backend);
      if (codexModel === BACK) return main();
      config.codexModel = codexModel;
      config.backend = "codex";

      // Map OpenAI's flagship/mid/cheap tiers onto Claude Code's task roles so
      // its router sends hard work to Sol, lighter work to Terra, quick to Luna.
      const slugs = new Set(models.map((m) => m.slug));
      if (slugs.has("gpt-5.6-sol") && slugs.has("gpt-5.6-terra") && slugs.has("gpt-5.6-luna")) {
        config.codexOpusModel = "gpt-5.6-sol";
        config.codexSonnetModel = "gpt-5.6-terra";
        config.codexHaikuModel = "gpt-5.6-luna";
        console.log("Role mapping: opus -> sol, sonnet -> terra, haiku -> luna");
      }

      const customize = await confirm({ message: "Customize role models?", default: false });
      if (customize) {
        config.codexOpusModel = await pickCodexModel(models, config.codexOpusModel, "Opus (complex tasks)");
        config.codexSonnetModel = await pickCodexModel(models, config.codexSonnetModel, "Sonnet (lighter tasks)");
        config.codexHaikuModel = await pickCodexModel(models, config.codexHaikuModel, "Haiku (quick/cheap)");
      }

      const selected = models.find((m) => m.slug === codexModel)!;
      config.codexEffort = await pickCodexEffort(selected.efforts, config.codexEffort ?? selected.defaultEffort);

      saveConfig(config);
    }

    const effort = config.codexEffort ?? "medium";
    const contextWindow = models.find((m) => m.slug === codexModel)?.contextWindow || 200000;

    console.log("Starting Codex proxy...");
    const proxy = await startCodexProxy(effort);

    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "codex",
      ANTHROPIC_MODEL: codexModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: config.codexOpusModel || codexModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: config.codexSonnetModel || codexModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: config.codexHaikuModel || codexModel,
      ...contextOverrideEnv(contextWindow),
    };

    console.log(`\nLaunching claude with ${codexModel} @ ${effort} effort, ${formatContext(contextWindow)} context (Codex sub via proxy :${proxy.port})...\n`);
    launchClaude(passthrough, env, () => proxy.close());
  } else if (backend === "grok") {
    let auth;
    try {
      auth = await getGrokAuth();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    let models;
    try {
      models = await fetchGrokModels(auth.token);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    if (models.length === 0) {
      console.error("No Grok models available. Run `grok` once while signed in.");
      process.exit(1);
    }

    let grokModel = config.grokModel;
    if (flags.backend || !grokModel || !models.some((m) => m.id === grokModel)) {
      grokModel = await pickGrokModel(models, grokModel, undefined, flags.backend);
      if (grokModel === BACK) return main();
      config.grokModel = grokModel;
      config.backend = "grok";

      // On a flat subscription there's no per-token saving from a cheaper
      // model, so every role defaults to the picked model for consistent
      // quality (and one context window). Opt into a faster model per role below.
      config.grokOpusModel = grokModel;
      config.grokSonnetModel = grokModel;
      config.grokHaikuModel = grokModel;

      const customize = await confirm({ message: "Use a faster model for lighter roles?", default: false });
      if (customize) {
        config.grokOpusModel = await pickGrokModel(models, config.grokOpusModel, "Opus (complex tasks)");
        config.grokSonnetModel = await pickGrokModel(models, config.grokSonnetModel, "Sonnet (lighter tasks)");
        config.grokHaikuModel = await pickGrokModel(models, config.grokHaikuModel, "Haiku (quick/cheap)");
      }

      const selected = models.find((m) => m.id === grokModel)!;
      if (selected.efforts.length) {
        config.grokEffort = await pickCodexEffort(selected.efforts, config.grokEffort ?? selected.defaultEffort);
      }

      saveConfig(config);
    }

    const effort = config.grokEffort;
    const contextWindow = models.find((m) => m.id === grokModel)?.contextWindow || 200000;

    console.log("Starting Grok proxy...");
    const proxy = await startGrokProxy(effort);

    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "grok",
      ANTHROPIC_MODEL: grokModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: config.grokOpusModel || grokModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: config.grokSonnetModel || grokModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: config.grokHaikuModel || grokModel,
      ...contextOverrideEnv(contextWindow),
    };

    console.log(`\nLaunching claude with ${grokModel}${effort ? ` @ ${effort} effort` : ""}, ${formatContext(contextWindow)} context (Grok sub via proxy :${proxy.port})...\n`);
    launchClaude(passthrough, env, () => proxy.close());
  } else if (backend === "kimi") {
    let auth;
    let identity;
    try {
      auth = await getKimiAuth();
      identity = getKimiIdentity();
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    let models;
    try {
      models = await fetchKimiModels(auth.token, identityHeaders(identity));
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    if (models.length === 0) {
      console.error("No Kimi models available. Run `kimi` once while signed in.");
      process.exit(1);
    }

    let kimiModel = config.kimiModel;
    if (flags.backend || !kimiModel || !models.some((m) => m.id === kimiModel)) {
      kimiModel = await pickKimiModel(models, kimiModel, undefined, flags.backend);
      if (kimiModel === BACK) return main();
      config.kimiModel = kimiModel;
      config.backend = "kimi";

      // On a flat subscription there's no per-token saving from a cheaper
      // model, so every role defaults to the picked model. Opt into a faster
      // model per role below.
      config.kimiOpusModel = kimiModel;
      config.kimiSonnetModel = kimiModel;
      config.kimiHaikuModel = kimiModel;

      const customize = await confirm({ message: "Use a faster model for lighter roles?", default: false });
      if (customize) {
        config.kimiOpusModel = await pickKimiModel(models, config.kimiOpusModel, "Opus (complex tasks)");
        config.kimiSonnetModel = await pickKimiModel(models, config.kimiSonnetModel, "Sonnet (lighter tasks)");
        config.kimiHaikuModel = await pickKimiModel(models, config.kimiHaikuModel, "Haiku (quick/cheap)");
      }

      saveConfig(config);
    }

    const contextWindow = models.find((m) => m.id === kimiModel)?.contextWindow || 200000;

    console.log("Starting Kimi proxy...");
    const proxy = await startKimiProxy(identity);

    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "kimi",
      ANTHROPIC_MODEL: kimiModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: config.kimiOpusModel || kimiModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: config.kimiSonnetModel || kimiModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: config.kimiHaikuModel || kimiModel,
      ...contextOverrideEnv(contextWindow),
    };

    console.log(`\nLaunching claude with ${kimiModel}, ${formatContext(contextWindow)} context (Kimi sub via proxy :${proxy.port})...\n`);
    launchClaude(passthrough, env, () => proxy.close());
  } else if (backend === "mixed") {
    const MIXED_BACKENDS = ["codex", "grok", "kimi", "openrouter", "ollama", "nim", "lmstudio"];
    const slots = () => [config.mixedModel, config.mixedOpusModel, config.mixedSonnetModel, config.mixedHaikuModel];
    const prefixOf = (s: string) => s.slice(0, s.indexOf(":"));
    const validSlot = (s: string) => s.indexOf(":") > 0 && MIXED_BACKENDS.includes(prefixOf(s));

    // Catalogs and auth are fetched lazily so setup only touches the backends
    // actually routed to.
    let codexModels: ReturnType<typeof fetchCodexModels> | undefined;
    let grokModels: Awaited<ReturnType<typeof fetchGrokModels>> | undefined;
    let kimiModels: Awaited<ReturnType<typeof fetchKimiModels>> | undefined;
    let orModels: Awaited<ReturnType<typeof fetchModels>> | undefined;
    let olModels: Awaited<ReturnType<typeof fetchOllamaModels>> | undefined;
    let nimModels: Awaited<ReturnType<typeof fetchOpenAIModels>> | undefined;
    let lmModels: Awaited<ReturnType<typeof fetchOpenAIModels>> | undefined;

    const pickSlot = async (label: string, current?: string, allowBack?: boolean): Promise<string | undefined | typeof BACK> => {
      const curBackend = current && validSlot(current) ? prefixOf(current) : undefined;
      const b = await pickMixedBackend(label, curBackend, allowBack);
      if (b === BACK) return BACK;
      if (b === "claude") return undefined;
      const curModel = current && curBackend === b ? current.slice(b.length + 1).replace(/@[^@]*$/, "") : undefined;
      // An effort pick is encoded into the slot as "model@effort" so the pin
      // is visible wherever the model name shows (launch line, /model).
      const withEffort = async (model: string, efforts: string[]) => {
        const e = efforts.length ? await pickSlotEffort(efforts) : undefined;
        return e ? `${model}@${e}` : model;
      };
      if (b === "codex") {
        codexModels ??= fetchCodexModels();
        const m = await pickCodexModel(codexModels, curModel, label);
        return `codex:${await withEffort(m, codexModels.find((x) => x.slug === m)?.efforts ?? [])}`;
      }
      if (b === "grok") {
        grokModels ??= await fetchGrokModels((await getGrokAuth()).token);
        const m = await pickGrokModel(grokModels, curModel, label);
        return `grok:${await withEffort(m, grokModels.find((x) => x.id === m)?.efforts ?? [])}`;
      }
      if (b === "kimi") {
        kimiModels ??= await fetchKimiModels((await getKimiAuth()).token, identityHeaders(getKimiIdentity()));
        const m = await pickKimiModel(kimiModels, curModel, label);
        // Kimi's catalog exposes no effort levels; the pin is forwarded in
        // output_config.effort and support depends on the model.
        return `kimi:${await withEffort(m, ["low", "medium", "high", "max"])}`;
      }
      if (b === "openrouter") {
        if (!config.openrouterApiKey) {
          console.log("No OpenRouter API key found. Starting login...\n");
          config.openrouterApiKey = await login();
        }
        orModels ??= filterAgenticModels(await fetchModels());
        return `openrouter:${await pickModel(orModels, curModel, label)}`;
      }
      if (b === "ollama") {
        olModels ??= await fetchOllamaModels(config.ollamaHost || "http://localhost:11434");
        return `ollama:${await pickOllamaModel(olModels, label)}`;
      }
      if (b === "nim") {
        const host = config.nimHost || NIM_CLOUD_HOST;
        if (host === NIM_CLOUD_HOST && !config.nimApiKey) {
          config.nimApiKey = await input({ message: "Enter NVIDIA API key (nvapi-...):" });
        }
        nimModels ??= await fetchOpenAIModels(host, config.nimApiKey);
        return `nim:${await pickOpenAIModel(nimModels, label)}`;
      }
      lmModels ??= await fetchOpenAIModels(config.lmstudioHost || "http://localhost:1234/v1");
      return `lmstudio:${await pickOpenAIModel(lmModels, label)}`;
    };

    // config.backend only becomes "mixed" after a completed setup, so an
    // all-Claude slot choice persists instead of re-prompting every launch.
    if (flags.backend || (config.backend !== "mixed" && !slots().some(Boolean)) || slots().some((s) => s && !validSlot(s))) {
      console.log("Each role stays on your Anthropic subscription unless routed to another backend.");
      try {
        const first = await pickSlot("Main model", config.mixedModel, flags.backend);
        if (first === BACK) return main();
        config.mixedModel = first;
        config.mixedOpusModel = (await pickSlot("Opus (complex tasks)", config.mixedOpusModel)) as string | undefined;
        config.mixedSonnetModel = (await pickSlot("Sonnet (lighter tasks)", config.mixedSonnetModel)) as string | undefined;
        config.mixedHaikuModel = (await pickSlot("Haiku (quick/cheap)", config.mixedHaikuModel)) as string | undefined;
      } catch (err) {
        if (err instanceof Error && err.name === "ExitPromptError") throw err;
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      config.backend = "mixed";
      saveConfig(config);
    }

    // Every backend with usable credentials is registered, not just the
    // configured slots, so /model backend:model mid-session can reach any of
    // them. Handlers resolve auth per request, so a backend the user never
    // routes to costs nothing.
    const routes: Record<string, MixedHandler> = {
      codex: (p, res) => handleCodexMessages(p as unknown as CodexRequest, res, "medium"),
      grok: (p, res) => handleGrokMessages(p as unknown as GrokBody, res, config.grokEffort),
      ollama: (p, res) => forwardAnthropic(`${config.ollamaHost || "http://localhost:11434"}/v1/messages`, {}, p, res),
      lmstudio: (p, res) => handleOpenAIMessages(p as unknown as OpenAIProxyRequest, res, config.lmstudioHost || "http://localhost:1234/v1"),
    };
    try {
      const identity = getKimiIdentity();
      routes.kimi = (p, res) => handleKimiMessages(p as unknown as KimiBody, res, identity);
    } catch {
      // No Kimi login; kimi: models fall through to Anthropic's model error.
    }
    if (config.openrouterApiKey) {
      const key = config.openrouterApiKey;
      routes.openrouter = (p, res) => forwardAnthropic("https://openrouter.ai/api/v1/messages", { Authorization: `Bearer ${key}` }, p, res);
    }
    if (config.nimApiKey || config.nimHost) {
      routes.nim = (p, res) => handleOpenAIMessages(p as unknown as OpenAIProxyRequest, res, config.nimHost || NIM_CLOUD_HOST, config.nimApiKey);
    }

    // The context override follows the main slot's model: the interactive
    // session lives there, and Claude Code has only one global cap. Trade-off:
    // /model to a smaller-window model mid-session keeps the raised cap.
    let mainContext = 0;
    const mainSlot = config.mixedModel;
    if (mainSlot && validSlot(mainSlot)) {
      const mb = prefixOf(mainSlot);
      const mm = mainSlot.slice(mb.length + 1).replace(/@[^@]*$/, "");
      try {
        if (mb === "codex") mainContext = (codexModels ??= fetchCodexModels()).find((x) => x.slug === mm)?.contextWindow ?? 0;
        else if (mb === "grok") mainContext = (grokModels ??= await fetchGrokModels((await getGrokAuth()).token)).find((x) => x.id === mm)?.contextWindow ?? 0;
        else if (mb === "kimi") mainContext = (kimiModels ??= await fetchKimiModels((await getKimiAuth()).token, identityHeaders(getKimiIdentity()))).find((x) => x.id === mm)?.contextWindow ?? 0;
        else if (mb === "ollama") mainContext = await getOllamaContext(config.ollamaHost || "http://localhost:11434", mm);
        else if (mb === "openrouter") mainContext = (orModels ??= filterAgenticModels(await fetchModels())).find((x) => x.id === mm.replace(/:exacto$/, ""))?.context_length ?? 0;
        else if (mb === "nim") mainContext = openAIModelContext((nimModels ??= await fetchOpenAIModels(config.nimHost || NIM_CLOUD_HOST, config.nimApiKey)).find((x) => x.id === mm));
        else if (mb === "lmstudio") mainContext = await getLmStudioContext(config.lmstudioHost || "http://localhost:1234/v1", mm);
      } catch {
        mainContext = 0;
      }
    }

    console.log("Starting mixed proxy...");
    const proxy = await startMixedProxy(routes);

    // ANTHROPIC_AUTH_TOKEN/API_KEY must not reach Claude Code: their presence
    // (even inherited from the user's shell) switches it out of subscription
    // OAuth mode (claude-code#33330). Role env vars are set for any routed
    // slot; unrouted roles keep Claude Code's own defaults.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
      ...contextOverrideEnv(mainContext),
    };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    if (config.mixedModel) env.ANTHROPIC_MODEL = config.mixedModel;
    if (config.mixedOpusModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = config.mixedOpusModel;
    if (config.mixedSonnetModel) env.ANTHROPIC_DEFAULT_SONNET_MODEL = config.mixedSonnetModel;
    if (config.mixedHaikuModel) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = config.mixedHaikuModel;

    console.log(
      `\nLaunching claude (mixed): main=${config.mixedModel ?? "claude"}${mainContext > 200000 ? ` [${formatContext(mainContext)}]` : ""} opus=${config.mixedOpusModel ?? "claude"} sonnet=${config.mixedSonnetModel ?? "claude"} haiku=${config.mixedHaikuModel ?? "claude"} (proxy :${proxy.port})...\n`
    );
    launchClaude(passthrough, env, () => proxy.close());
  } else {
    // Anthropic - just launch claude
    console.log("Launching claude...\n");
    launchClaude(passthrough);
  }
}

main().catch((err) => {
  if (err.name === "ExitPromptError") {
    process.exit(130);
  }
  console.error(err);
  process.exit(1);
});
