import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

export type Backend = "anthropic" | "openrouter" | "ollama" | "nim" | "lmstudio" | "llamacpp" | "codex" | "grok" | "kimi" | "mixed";

export interface Config {
  backend?: Backend;
  selectedModel?: string;
  sonnetModel?: string;
  opusModel?: string;
  haikuModel?: string;
  lastModelFetch?: string;
  seenModels?: string[];
  openrouterApiKey?: string;
  ollamaHost?: string;
  ollamaModel?: string;
  ollamaSonnetModel?: string;
  ollamaOpusModel?: string;
  ollamaHaikuModel?: string;
  nimApiKey?: string;
  nimHost?: string;
  nimModel?: string;
  nimSonnetModel?: string;
  nimOpusModel?: string;
  nimHaikuModel?: string;
  lmstudioHost?: string;
  lmstudioModel?: string;
  lmstudioSonnetModel?: string;
  lmstudioOpusModel?: string;
  lmstudioHaikuModel?: string;
  // Server root without /v1; llama-server speaks the Anthropic Messages API
  // natively, so this is passed to Claude Code as ANTHROPIC_BASE_URL as-is.
  llamacppHost?: string;
  llamacppModel?: string;
  llamacppSonnetModel?: string;
  llamacppOpusModel?: string;
  llamacppHaikuModel?: string;
  codexModel?: string;
  codexSonnetModel?: string;
  codexOpusModel?: string;
  codexHaikuModel?: string;
  codexEffort?: string;
  grokModel?: string;
  grokSonnetModel?: string;
  grokOpusModel?: string;
  grokHaikuModel?: string;
  grokEffort?: string;
  kimiModel?: string;
  kimiSonnetModel?: string;
  kimiOpusModel?: string;
  kimiHaikuModel?: string;
  // Mixed backend: each slot is a "backend:model" string (codex, grok, kimi,
  // openrouter, ollama, nim, lmstudio), optionally "@effort"-suffixed to pin
  // reasoning effort, or absent to stay on the Anthropic subscription default
  // for that role.
  mixedModel?: string;
  mixedSonnetModel?: string;
  mixedOpusModel?: string;
  mixedHaikuModel?: string;
}

const CONFIG_DIR = join(homedir(), ".config", "claude-launcher");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function getConfig(): Config {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function saveConfig(config: Config): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}
