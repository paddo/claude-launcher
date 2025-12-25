import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

export type Backend = "anthropic" | "openrouter";

export interface Config {
  backend?: Backend;
  selectedModel?: string;
  sonnetModel?: string;
  opusModel?: string;
  haikuModel?: string;
  lastModelFetch?: string;
  seenModels?: string[];
  openrouterApiKey?: string;
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
