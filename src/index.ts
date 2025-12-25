#!/usr/bin/env bun
import { spawn } from "child_process";
import { getConfig, saveConfig, type Backend } from "./config";
import { fetchModels, filterAgenticModels, getNewModels } from "./models";
import { pickBackend, pickModel } from "./picker";

const args = process.argv.slice(2);

function parseArgs() {
  const flags = {
    openrouter: false,
    anthropic: false,
    model: false,
    help: false,
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
    } else {
      passthrough.push(arg);
    }
  }

  return { flags, passthrough };
}

function showHelp() {
  console.log(`claude-launcher - Launch Claude Code with multiple backends

Usage: claude-launcher [options] [-- claude-args...]

Options:
  -o, --openrouter  Use OpenRouter backend
  -a, --anthropic   Use Anthropic backend
  -m, --model       Show model picker (implies --openrouter)
  -h, --help        Show this help

Examples:
  claude-launcher                    # uses last backend/model
  claude-launcher --openrouter       # OpenRouter with saved model
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
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.error("Error: OPENROUTER_API_KEY not set");
      process.exit(1);
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
    }

    saveConfig(config);

    // Launch claude with OpenRouter env
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_MODEL: selectedModel,
    };

    console.log(`\nLaunching claude with ${selectedModel}...\n`);
    const child = spawn("claude", passthrough, {
      env,
      stdio: "inherit",
    });

    child.on("exit", (code) => process.exit(code || 0));
  } else {
    // Anthropic - just launch claude
    console.log("Launching claude...\n");
    const child = spawn("claude", passthrough, {
      stdio: "inherit",
    });

    child.on("exit", (code) => process.exit(code || 0));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
