import { search, select } from "@inquirer/prompts";
import type { OpenRouterModel, OllamaModel, OpenAIModel, CodexModel, GrokModel } from "./models";
import { formatContext, formatPrice, formatOllamaSize } from "./models";
import type { Backend } from "./config";

export async function pickBackend(defaultValue?: Backend): Promise<Backend> {
  return select({
    message: "Select backend:",
    default: defaultValue,
    choices: [
      { name: "Anthropic (standard)", value: "anthropic" as Backend },
      { name: "OpenRouter (multiple models)", value: "openrouter" as Backend },
      { name: "Codex (ChatGPT subscription)", value: "codex" as Backend },
      { name: "Grok (X/SuperGrok subscription)", value: "grok" as Backend },
      { name: "Ollama (local)", value: "ollama" as Backend },
      { name: "NIM (NVIDIA)", value: "nim" as Backend },
      { name: "LM Studio (local)", value: "lmstudio" as Backend },
    ],
  });
}

export async function pickCodexModel(models: CodexModel[], currentModel?: string, label?: string): Promise<string> {
  return select({
    message: label ? `${label}:` : "Select model:",
    default: currentModel,
    choices: models.map((m) => ({
      name: `${m.displayName} [${formatContext(m.contextWindow)}]`,
      value: m.slug,
      description: m.slug,
    })),
  });
}

export async function pickCodexEffort(efforts: string[], currentEffort?: string): Promise<string> {
  return select({
    message: "Reasoning effort:",
    default: currentEffort,
    choices: efforts.map((e) => ({ name: e, value: e })),
  });
}

export async function pickGrokModel(models: GrokModel[], currentModel?: string, label?: string): Promise<string> {
  return select({
    message: label ? `${label}:` : "Select model:",
    default: currentModel,
    choices: models.map((m) => ({
      name: `${m.id} [${formatContext(m.contextWindow)}]`,
      value: m.id,
    })),
  });
}

export async function pickModel(
  models: OpenRouterModel[],
  currentModel?: string,
  label?: string
): Promise<string> {
  const choices = models.map((m) => ({
    name: `${m.hasExacto ? "[exacto] " : ""}${m.name} [${formatContext(m.context_length)}] ${formatPrice(m)}`,
    value: m.hasExacto ? `${m.id}:exacto` : m.id,
    description: m.hasExacto ? `${m.id}:exacto` : m.id,
  }));

  return search({
    message: label ? `${label}:` : "Select model:",
    source: async (input) => {
      if (!input) return choices.slice(0, 20);
      const lower = input.toLowerCase();
      return choices.filter(
        (c) =>
          c.name.toLowerCase().includes(lower) ||
          c.value.toLowerCase().includes(lower)
      );
    },
  });
}

export async function pickOpenAIModel(models: OpenAIModel[], label?: string): Promise<string> {
  const choices = models.map((m) => ({
    name: m.id,
    value: m.id,
  }));

  return select({
    message: label ? `${label}:` : "Select model:",
    choices,
  });
}

export async function pickOllamaModel(models: OllamaModel[], label?: string): Promise<string> {
  const choices = models.map((m) => ({
    // Cloud models (`:cloud` suffix) run on Ollama's infra and have no local
    // size, so tag them instead of showing a meaningless byte count.
    name: `${m.name} ${m.name.endsWith(":cloud") ? "[cloud]" : `[${formatOllamaSize(m.size)}]`}`,
    value: m.name,
  }));

  return select({
    message: label ? `${label}:` : "Select Ollama model:",
    choices,
  });
}
