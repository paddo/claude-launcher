import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";

// Backend-agnostic model shape the pickers and backend registry work with;
// each backend's loadCatalog normalizes its native catalog into this.
export interface CatalogModel {
  id: string;
  choiceName: string;
  description?: string;
  context: number;
  efforts?: string[];
  defaultEffort?: string;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
  };
  supported_parameters?: string[];
  hasExacto?: boolean;
}

interface ModelsResponse {
  data: OpenRouterModel[];
}

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

interface OllamaTagsResponse {
  models: OllamaModel[];
}

export async function fetchOllamaModels(host: string): Promise<OllamaModel[]> {
  const res = await fetch(`${host}/api/tags`);
  if (!res.ok) throw new Error(`Failed to fetch Ollama models: ${res.status}`);
  const data = (await res.json()) as OllamaTagsResponse;
  return data.models || [];
}

export function formatOllamaSize(size: number): string {
  const gb = size / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(1)}GB`;
  return `${(size / 1_000_000).toFixed(0)}MB`;
}

interface OllamaShowResponse {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
}

// Ollama exposes the model's trained context under a per-architecture key
// (e.g. "qwen2.context_length") in /api/show. Returns 0 if unavailable.
export async function getOllamaContext(host: string, name: string): Promise<number> {
  try {
    const res = await fetch(`${host}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return 0;
    const data = (await res.json()) as OllamaShowResponse;
    const info = data.model_info ?? {};
    const key = Object.keys(info).find((k) => k.endsWith(".context_length"));
    const val = key ? info[key] : undefined;
    return typeof val === "number" ? val : 0;
  } catch {
    return 0;
  }
}

async function hasToolCapability(host: string, modelName: string): Promise<boolean> {
  try {
    const res = await fetch(`${host}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as OllamaShowResponse;
    return data.capabilities?.includes("tools") ?? false;
  } catch {
    return false;
  }
}

export async function filterToolCapableOllamaModels(
  host: string,
  models: OllamaModel[]
): Promise<OllamaModel[]> {
  const results = await Promise.all(
    models.map(async (m) => ({ model: m, hasTools: await hasToolCapability(host, m.name) }))
  );
  return results.filter((r) => r.hasTools).map((r) => r.model);
}

export interface OpenAIModel {
  id: string;
  object: string;
  max_model_len?: number;
  context_length?: number;
  max_context_length?: number;
}

// OpenAI-compatible /models responses don't standardize a context field; read
// whichever the endpoint happens to expose (vLLM/NIM use max_model_len, LM
// Studio sometimes context_length). Returns 0 when none is present.
export function openAIModelContext(model?: OpenAIModel): number {
  const value = model?.max_model_len ?? model?.context_length ?? model?.max_context_length;
  return typeof value === "number" ? value : 0;
}

// LM Studio's OpenAI-compat /v1/models omits context entirely; its native
// /api/v0/models exposes loaded_context_length (the window actually being
// served). Returning that avoids over-promising a window LM Studio isn't
// serving. Returns 0 when the model isn't loaded, so no override is applied.
export async function getLmStudioContext(host: string, modelId: string): Promise<number> {
  try {
    const base = host.replace(/\/v1\/?$/, "");
    const res = await fetch(`${base}/api/v0/models`);
    if (!res.ok) return 0;
    const data = (await res.json()) as {
      data?: { id: string; loaded_context_length?: number | null }[];
    };
    const model = data.data?.find((m) => m.id === modelId);
    return typeof model?.loaded_context_length === "number" ? model.loaded_context_length : 0;
  } catch {
    return 0;
  }
}

interface OpenAIModelsResponse {
  data: OpenAIModel[];
}

export async function fetchOpenAIModels(host: string, apiKey?: string): Promise<OpenAIModel[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(`${host}/models`, { headers });
  if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
  const data = (await res.json()) as OpenAIModelsResponse;
  return data.data || [];
}

export interface CodexModel {
  slug: string;
  displayName: string;
  contextWindow: number;
  efforts: string[];
  defaultEffort: string;
}

interface RawCodexModel {
  slug: string;
  display_name?: string;
  context_window?: number;
  visibility?: string;
  supported_reasoning_levels?: (string | { effort: string })[];
  default_reasoning_level?: string;
}

// Codex caches the model catalog the backend returned for the signed-in
// ChatGPT plan here; reading it means the picker reflects real plan access
// and updates whenever Codex refreshes, with no hardcoded list to rot.
export function fetchCodexModels(): CodexModel[] {
  const path = join(homedir(), ".codex", "models_cache.json");
  if (!existsSync(path)) {
    throw new Error("No Codex model cache. Run `codex` once while signed in with ChatGPT.");
  }
  const data = JSON.parse(readFileSync(path, "utf-8")) as { models?: RawCodexModel[] };
  return (data.models ?? [])
    .filter((m) => m.visibility === "list")
    .map((m) => ({
      slug: m.slug,
      displayName: m.display_name ?? m.slug,
      contextWindow: m.context_window ?? 0,
      // "ultra" is a codex-CLI orchestration mode (client-side task
      // delegation), not a reasoning.effort the Responses API accepts - the
      // API enum tops out at "max" and 400s on it.
      efforts: (m.supported_reasoning_levels ?? []).map((l) => (typeof l === "string" ? l : l.effort)).filter((e) => e !== "ultra"),
      defaultEffort: m.default_reasoning_level ?? "medium",
    }));
}

export interface GrokModel {
  id: string;
  contextWindow: number;
  efforts: string[];
  defaultEffort: string;
}

interface RawGrokEffort {
  id?: string;
  value?: string;
  default?: boolean;
}

interface RawGrokModel {
  id: string;
  context_window?: number;
  reasoning_efforts?: RawGrokEffort[] | null;
  reasoning_effort?: string | null;
}

// Grok Build's backend lists the models the signed-in plan can use. Discovering
// them live keeps the picker honest and picks up new models without a release.
export async function fetchGrokModels(token: string): Promise<GrokModel[]> {
  const res = await fetch("https://cli-chat-proxy.grok.com/v1/models", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch Grok models: ${res.status}`);
  const data = (await res.json()) as { data?: RawGrokModel[]; models?: RawGrokModel[] };
  return (data.data ?? data.models ?? []).map((m) => {
    const levels = m.reasoning_efforts ?? [];
    const def = levels.find((e) => e.default);
    return {
      id: m.id,
      contextWindow: m.context_window ?? 0,
      efforts: levels.map((e) => e.value ?? e.id ?? "").filter(Boolean),
      defaultEffort: m.reasoning_effort ?? def?.value ?? def?.id ?? "high",
    };
  });
}

export interface KimiModel {
  id: string;
  contextWindow: number;
}

interface RawKimiModel {
  id: string;
  context_length?: number;
}

// Kimi's coding backend lists the models the signed-in plan can use, in
// OpenAI-compatible shape. Discovering them live keeps the picker honest as
// Moonshot reshuffles plan/model gating.
export async function fetchKimiModels(token: string, headers: Record<string, string>): Promise<KimiModel[]> {
  const res = await fetch("https://api.kimi.com/coding/v1/models", {
    headers: { Authorization: `Bearer ${token}`, ...headers },
  });
  if (!res.ok) throw new Error(`Failed to fetch Kimi models: ${res.status}`);
  const data = (await res.json()) as { data?: RawKimiModel[] };
  return (data.data ?? []).map((m) => ({
    id: m.id,
    contextWindow: m.context_length ?? 0,
  }));
}

export async function fetchModels(): Promise<OpenRouterModel[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
  const data = (await res.json()) as ModelsResponse;
  return data.data;
}

export function filterAgenticModels(models: OpenRouterModel[]): OpenRouterModel[] {
  // Find all exacto variant IDs
  const exactoIds = new Set(
    models.filter((m) => m.id.endsWith(":exacto")).map((m) => m.id.replace(/:exacto$/, ""))
  );

  return models
    .filter(
      (m) =>
        !m.id.endsWith(":exacto") &&
        (m.supported_parameters?.includes("tools") || m.supported_parameters?.includes("tool_choice"))
    )
    .map((m) => ({ ...m, hasExacto: exactoIds.has(m.id) }));
}

export function getNewModels(models: OpenRouterModel[], seenIds: string[]): OpenRouterModel[] {
  const seen = new Set(seenIds);
  return models.filter((m) => !seen.has(m.id));
}

export function formatPrice(model: OpenRouterModel): string {
  const promptPrice = parseFloat(model.pricing.prompt) * 1_000_000;
  const completionPrice = parseFloat(model.pricing.completion) * 1_000_000;
  if (promptPrice === 0 && completionPrice === 0) return "free";
  return `$${promptPrice.toFixed(2)}/$${completionPrice.toFixed(2)} per 1M`;
}

export function formatContext(contextLength: number): string {
  if (contextLength >= 1_000_000) return `${(contextLength / 1_000_000).toFixed(1)}M`;
  if (contextLength >= 1000) return `${Math.round(contextLength / 1000)}k`;
  return String(contextLength);
}
