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
