import { search, select } from "@inquirer/prompts";
import type { OpenRouterModel, OllamaModel, OpenAIModel, CodexModel, GrokModel, KimiModel } from "./models";
import { formatContext, formatPrice, formatOllamaSize } from "./models";
import type { Backend } from "./config";

// Sentinel returned by model pickers when the user backs out to the backend
// selection. Distinguishable from any real model id (those never equal it).
export const BACK = "__back__";

function backChoice(allowBack?: boolean): { name: string; value: string }[] {
  return allowBack ? [{ name: "\u2190 Back (backend selection)", value: BACK }] : [];
}

export async function pickBackend(defaultValue?: Backend): Promise<Backend> {
  return select({
    message: "Select backend:",
    default: defaultValue,
    choices: [
      { name: "Anthropic (standard)", value: "anthropic" as Backend },
      { name: "OpenRouter (multiple models)", value: "openrouter" as Backend },
      { name: "Codex (ChatGPT subscription)", value: "codex" as Backend },
      { name: "Mixed (Anthropic native + any backend per role slot)", value: "mixed" as Backend },
      { name: "Grok (X/SuperGrok subscription)", value: "grok" as Backend },
      { name: "Kimi (Kimi Code subscription)", value: "kimi" as Backend },
      { name: "Ollama (local)", value: "ollama" as Backend },
      { name: "NIM (NVIDIA)", value: "nim" as Backend },
      { name: "LM Studio (local)", value: "lmstudio" as Backend },
    ],
  });
}

export async function pickCodexModel(models: CodexModel[], currentModel?: string, label?: string, allowBack?: boolean): Promise<string> {
  return select({
    message: label ? `${label}:` : "Select model:",
    default: currentModel,
    choices: [
      ...backChoice(allowBack),
      ...models.map((m) => ({
        name: `${m.displayName} [${formatContext(m.contextWindow)}]`,
        value: m.slug,
        description: m.slug,
      })),
    ],
  });
}

// Returns the backend a mixed slot routes to, "claude" to stay on the
// Anthropic subscription default, or BACK to exit to the backend selection.
export async function pickMixedBackend(label: string, current?: string, allowBack?: boolean): Promise<Backend | "claude" | typeof BACK> {
  return select({
    message: `${label} backend:`,
    default: (current ?? "claude") as Backend | "claude",
    choices: [
      ...(backChoice(allowBack) as { name: string; value: Backend | "claude" }[]),
      { name: "Claude (Anthropic subscription)", value: "claude" as const },
      { name: "Codex (ChatGPT subscription)", value: "codex" as Backend },
      { name: "Grok (X/SuperGrok subscription)", value: "grok" as Backend },
      { name: "Kimi (Kimi Code subscription)", value: "kimi" as Backend },
      { name: "OpenRouter", value: "openrouter" as Backend },
      { name: "Ollama (local)", value: "ollama" as Backend },
      { name: "NIM (NVIDIA)", value: "nim" as Backend },
      { name: "LM Studio (local)", value: "lmstudio" as Backend },
    ],
  });
}

// Returns an effort level to pin into the slot ("model@effort"), or undefined
// to let the session's /effort selector drive it per request.
export async function pickSlotEffort(efforts: string[]): Promise<string | undefined> {
  const OBEY = "__obey__";
  const picked = await select({
    message: "Reasoning effort:",
    default: OBEY,
    choices: [
      { name: "Obey session /effort", value: OBEY },
      ...efforts.map((e) => ({ name: `pin ${e}`, value: e })),
    ],
  });
  return picked === OBEY ? undefined : picked;
}

export async function pickCodexEffort(efforts: string[], currentEffort?: string): Promise<string> {
  return select({
    message: "Reasoning effort:",
    default: currentEffort,
    choices: efforts.map((e) => ({ name: e, value: e })),
  });
}

export async function pickGrokModel(models: GrokModel[], currentModel?: string, label?: string, allowBack?: boolean): Promise<string> {
  return select({
    message: label ? `${label}:` : "Select model:",
    default: currentModel,
    choices: [
      ...backChoice(allowBack),
      ...models.map((m) => ({
        name: `${m.id} [${formatContext(m.contextWindow)}]`,
        value: m.id,
      })),
    ],
  });
}

export async function pickKimiModel(models: KimiModel[], currentModel?: string, label?: string, allowBack?: boolean): Promise<string> {
  return select({
    message: label ? `${label}:` : "Select model:",
    default: currentModel,
    choices: [
      ...backChoice(allowBack),
      ...models.map((m) => ({
        name: m.contextWindow ? `${m.id} [${formatContext(m.contextWindow)}]` : m.id,
        value: m.id,
      })),
    ],
  });
}

export async function pickModel(
  models: OpenRouterModel[],
  currentModel?: string,
  label?: string,
  allowBack?: boolean
): Promise<string> {
  const choices = [
    ...backChoice(allowBack),
    ...models.map((m) => ({
      name: `${m.hasExacto ? "[exacto] " : ""}${m.name} [${formatContext(m.context_length)}] ${formatPrice(m)}`,
      value: m.hasExacto ? `${m.id}:exacto` : m.id,
      description: m.hasExacto ? `${m.id}:exacto` : m.id,
    })),
  ];

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

export async function pickOpenAIModel(models: OpenAIModel[], label?: string, allowBack?: boolean): Promise<string> {
  const choices = [
    ...backChoice(allowBack),
    ...models.map((m) => ({
      name: m.id,
      value: m.id,
    })),
  ];

  return select({
    message: label ? `${label}:` : "Select model:",
    choices,
  });
}

export async function pickOllamaModel(models: OllamaModel[], label?: string, allowBack?: boolean): Promise<string> {
  const choices = [
    ...backChoice(allowBack),
    ...models.map((m) => ({
      // Cloud models (`:cloud` suffix) run on Ollama's infra and have no local
      // size, so tag them instead of showing a meaningless byte count.
      name: `${m.name} ${m.name.endsWith(":cloud") ? "[cloud]" : `[${formatOllamaSize(m.size)}]`}`,
      value: m.name,
    })),
  ];

  return select({
    message: label ? `${label}:` : "Select Ollama model:",
    choices,
  });
}
