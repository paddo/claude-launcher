import { search, select } from "@inquirer/prompts";
import type { OpenRouterModel, OllamaModel } from "./models";
import { formatContext, formatPrice, formatOllamaSize } from "./models";
import type { Backend } from "./config";

export async function pickBackend(): Promise<Backend> {
  return select({
    message: "Select backend:",
    choices: [
      { name: "Anthropic (standard)", value: "anthropic" as Backend },
      { name: "OpenRouter (multiple models)", value: "openrouter" as Backend },
      { name: "Ollama (local)", value: "ollama" as Backend },
    ],
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

export async function pickOllamaModel(models: OllamaModel[], label?: string): Promise<string> {
  const choices = models.map((m) => ({
    name: `${m.name} [${formatOllamaSize(m.size)}]`,
    value: m.name,
  }));

  return select({
    message: label ? `${label}:` : "Select Ollama model:",
    choices,
  });
}
