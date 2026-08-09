import { search, select } from "@inquirer/prompts";
import type { Backend } from "./config";
import type { CatalogModel } from "./models";

// Sentinel returned by model pickers when the user backs out to the backend
// selection. Distinguishable from any real model id (those never equal it).
export const BACK = "__back__";

// Minimal slice of BackendDef the pickers need; taking it as a parameter
// keeps picker.ts out of a runtime cycle with backends.ts.
export interface BackendChoice {
  id: Backend;
  pickerLabel: string;
  mixedLabel?: string;
}

function backChoice(allowBack?: boolean): { name: string; value: string }[] {
  return allowBack ? [{ name: "← Back (backend selection)", value: BACK }] : [];
}

// Registry order, with the launcher modes anchored: Anthropic first, Mixed
// after the first two backends. Anthropic and Mixed are launcher modes, not
// registry backends, so they are interleaved here.
export async function pickBackend(defs: BackendChoice[], defaultValue?: Backend): Promise<Backend> {
  const backends = defs.map((d) => ({ name: d.pickerLabel, value: d.id }));
  return select({
    message: "Select backend:",
    default: defaultValue,
    choices: [
      { name: "Anthropic (standard)", value: "anthropic" as Backend },
      ...backends.slice(0, 2),
      { name: "Mixed (Anthropic native + any backend per role slot)", value: "mixed" as Backend },
      ...backends.slice(2),
    ],
  });
}

// Returns the backend a mixed slot routes to, "claude" to stay on the
// Anthropic subscription default, or BACK to exit to the backend selection.
export async function pickMixedBackend(defs: BackendChoice[], label: string, current?: string, allowBack?: boolean): Promise<Backend | "claude" | typeof BACK> {
  // Subscription backends first; registry entries not listed here follow in
  // registry order so a new backend is never invisible.
  const preferred: Backend[] = ["codex", "grok", "kimi", "openrouter"];
  const ordered = [
    ...preferred.flatMap((id) => defs.filter((d) => d.id === id)),
    ...defs.filter((d) => !preferred.includes(d.id)),
  ];
  return select({
    message: `${label} backend:`,
    default: (current ?? "claude") as Backend | "claude",
    choices: [
      ...(backChoice(allowBack) as { name: string; value: Backend | "claude" }[]),
      { name: "Claude (Anthropic subscription)", value: "claude" as const },
      ...ordered.map((d) => ({ name: d.mixedLabel ?? d.pickerLabel, value: d.id })),
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

export async function pickCatalogModel(
  models: CatalogModel[],
  opts: { current?: string; label?: string; allowBack?: boolean; search?: boolean } = {}
): Promise<string> {
  const choices = [
    ...backChoice(opts.allowBack),
    ...models.map((m) => ({ name: m.choiceName, value: m.id, description: m.description })),
  ];
  const message = opts.label ? `${opts.label}:` : "Select model:";

  if (opts.search) {
    return search({
      message,
      source: async (input) => {
        if (!input) return choices.slice(0, 20);
        const lower = input.toLowerCase();
        return choices.filter((c) => c.name.toLowerCase().includes(lower) || c.value.toLowerCase().includes(lower));
      },
    });
  }

  return select({ message, default: opts.current, choices });
}
