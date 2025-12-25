#!/usr/bin/env bun
import { spawn } from "child_process";
import { confirm } from "@inquirer/prompts";
import { getConfig, saveConfig, type Backend } from "./config";
import { fetchModels, filterAgenticModels, getNewModels } from "./models";
import { pickBackend, pickModel } from "./picker";
import { login } from "./auth";

const args = process.argv.slice(2);

function parseArgs() {
  const flags = {
    openrouter: false,
    anthropic: false,
    model: false,
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
    } else if (arg === "--model" || arg === "-m") {
      flags.model = true;
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

function launchClaude(passthrough: string[], env?: NodeJS.ProcessEnv) {
  const child = spawn("claude", passthrough, { env, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code || 0));
}

function showHelp() {
  console.log(`claude-launcher - Launch Claude Code with multiple backends

Usage: claude-launcher [command] [options] [-- claude-args...]

Commands:
  login             Authenticate with OpenRouter
  logout            Clear stored OpenRouter API key

Options:
  -o, --openrouter  Use OpenRouter backend
  -a, --anthropic   Use Anthropic backend
  -m, --model       Show model picker (implies --openrouter)
  -h, --help        Show this help

Examples:
  claude-launcher login              # authenticate with OpenRouter
  claude-launcher                    # uses last backend/model
  claude-launcher -m                 # pick a model
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
  if (flags.anthropic) {
    backend = "anthropic";
  } else if (flags.openrouter || flags.model) {
    backend = "openrouter";
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
    if (flags.model || !selectedModel) {
      selectedModel = await pickModel(models, selectedModel);
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

    // Launch claude with OpenRouter env
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: config.sonnetModel || selectedModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: config.opusModel || selectedModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: config.haikuModel || selectedModel,
    };

    console.log(`\nLaunching claude with ${selectedModel}...\n`);
    launchClaude(passthrough, env);
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
