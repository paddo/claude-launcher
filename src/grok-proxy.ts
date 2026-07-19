import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { getGrokAuth, type GrokAuth } from "./grok-auth";
import { normalizeAnthropicContent } from "./anthropic-adapter";
import { listenOnRandomPort, pipeFetchResponse, readJsonBody, writeApiError } from "./proxy-shared";

const GROK_BASE_URL = "https://cli-chat-proxy.grok.com";

interface ContentBlock {
  type: string;
  text?: string;
}

interface Message {
  role: string;
  content: string | ContentBlock[] | null;
}

export interface AnthropicBody {
  system?: string | ContentBlock[];
  messages?: Message[];
  tools?: { input_schema?: unknown }[];
  reasoning_effort?: string;
  output_config?: { effort?: string };
  [key: string]: unknown;
}

function blocksToText(content: string | ContentBlock[] | null): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n");
  return "";
}

// Grok validates tool schemas strictly: a null `required` is rejected, and each
// tool's top-level schema must carry a `required` array. Claude Code emits both
// shapes, so normalize any null `required` to [] and ensure the top level has one.
function normalizeRequired(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(normalizeRequired);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (obj.required === null) obj.required = [];
    for (const value of Object.values(obj)) normalizeRequired(value);
  }
}

function fixToolSchemas(tools: { input_schema?: unknown }[]): void {
  for (const tool of tools) {
    const schema = tool.input_schema;
    if (schema && typeof schema === "object") {
      normalizeRequired(schema);
      const obj = schema as Record<string, unknown>;
      if (!Array.isArray(obj.required)) obj.required = [];
    }
  }
}

// Grok's Anthropic endpoint only accepts user/assistant in `messages` (a
// system-role turn 400s with "Invalid message role"). Claude Code emits
// system-role turns, so their text is lifted into the top-level `system` field
// where system instructions belong. Also injects the reasoning effort.
function prepareBody(body: AnthropicBody, effort?: string): string {
  normalizeAnthropicContent(body);
  if (Array.isArray(body.messages)) {
    // Grok only accepts user/assistant in `messages`; lift other roles' text
    // into the top-level `system` field where system instructions belong.
    const lifted: string[] = [];
    body.messages = body.messages.filter((m) => {
      if (m.role === "user" || m.role === "assistant") return true;
      lifted.push(blocksToText(m.content));
      return false;
    });
    const extra = lifted.filter(Boolean).join("\n\n");
    if (extra) {
      if (Array.isArray(body.system)) body.system.push({ type: "text", text: extra });
      else body.system = body.system ? `${body.system}\n\n${extra}` : extra;
    }
  }
  if (Array.isArray(body.tools)) fixToolSchemas(body.tools);
  // A pinned slot effort arrives via output_config.effort and outranks the
  // backend-configured default.
  const eff = body.output_config?.effort ?? effort;
  if (eff) body.reasoning_effort = eff;
  return JSON.stringify(body);
}

async function forward(body: string, auth: GrokAuth): Promise<Response> {
  return fetch(`${GROK_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "x-grok-client-version": auth.version,
      "x-grok-client-surface": "grok-build",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body,
  });
}

// Grok Build's backend already speaks the Anthropic Messages API: no
// translation, just the session token and client-version headers the backend
// requires (which Claude Code can't send itself), an optional reasoning
// effort, and a straight stream-through of the response.
export async function handleGrokMessages(body: AnthropicBody, res: ServerResponse, effort?: string): Promise<void> {
  try {
    const payload = prepareBody(body, effort);

    let auth = await getGrokAuth();
    let upstream = await forward(payload, auth);
    if (upstream.status === 401) {
      auth = await getGrokAuth(true);
      upstream = await forward(payload, auth);
    }

    await pipeFetchResponse(upstream, res);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (res.headersSent) {
      // Mid-stream failure: an error body would corrupt the SSE stream.
      res.end();
      return;
    }
    writeApiError(res, 500, message);
  }
}

export async function startGrokProxy(effort?: string): Promise<{ port: number; close: () => void }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const parsed = await readJsonBody<AnthropicBody>(req, res);
    if (!parsed) return;
    await handleGrokMessages(parsed, res, effort);
  });

  return listenOnRandomPort(server);
}
