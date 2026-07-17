import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { getGrokAuth, type GrokAuth } from "./grok-auth";
import { normalizeAnthropicContent } from "./anthropic-adapter";

const GROK_BASE_URL = "https://cli-chat-proxy.grok.com";

// Anthropic server-tool type prefixes that Grok does not implement. Claude Code
// WebSearch falls back to a side-query that sends type:web_search_* tools; Grok
// rejects those (missing description/input_schema) and never runs a real search.
const SERVER_TOOL_PREFIXES = [
  "web_search",
  "web_fetch",
  "code_execution",
  "bash_code_execution",
  "text_editor",
  "computer",
  "memory",
];

interface ContentBlock {
  type: string;
  text?: string;
}

interface Message {
  role: string;
  content: string | ContentBlock[] | null;
}

interface ToolDef {
  name?: string;
  type?: string;
  description?: string;
  input_schema?: unknown;
  allowed_domains?: string[];
  blocked_domains?: string[];
  max_uses?: number;
  user_location?: unknown;
  citations?: unknown;
  defer_loading?: boolean;
  [key: string]: unknown;
}

interface AnthropicBody {
  model?: string;
  stream?: boolean;
  system?: string | ContentBlock[];
  messages?: Message[];
  tools?: ToolDef[];
  tool_choice?: { type?: string; name?: string };
  reasoning_effort?: string;
  [key: string]: unknown;
}

interface SearchHit {
  title: string;
  url: string;
}

interface PendingSearch {
  query: string;
  allowed_domains?: string[];
  blocked_domains?: string[];
  model?: string;
  stream: boolean;
}

function isServerToolType(type: unknown): type is string {
  if (typeof type !== "string") return false;
  return SERVER_TOOL_PREFIXES.some((p) => type === p || type.startsWith(`${p}_`));
}

function isWebSearchTool(tool: ToolDef): boolean {
  const name = typeof tool.name === "string" ? tool.name : "";
  const type = typeof tool.type === "string" ? tool.type : "";
  return name === "web_search" || name === "WebSearch" || type.startsWith("web_search");
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

function defaultInputSchemaFor(name: unknown): Record<string, unknown> {
  if (name === "web_search" || name === "WebSearch") {
    return {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query to use" },
        allowed_domains: { type: "array", items: { type: "string" } },
        blocked_domains: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
    };
  }
  if (name === "web_fetch" || name === "WebFetch") {
    return {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    };
  }
  return { type: "object", properties: {}, required: [] };
}

// Grok requires every tool to be a custom tool with `description: string` and
// `input_schema`. Claude Code's WebSearch side-query sends Anthropic server tools
// like `{type:"web_search_20250305", name:"web_search"}` with neither field —
// that 422s with "missing field `description`". Convert to Grok-compatible shape.
function fixToolSchemas(tools: ToolDef[]): void {
  for (const tool of tools) {
    if (isServerToolType(tool.type)) {
      delete tool.type;
    }
    if (typeof tool.description !== "string") {
      tool.description = typeof tool.name === "string" ? tool.name : "";
    }
    if (!tool.input_schema || typeof tool.input_schema !== "object") {
      tool.input_schema = defaultInputSchemaFor(tool.name);
    }
    const schema = tool.input_schema;
    if (schema && typeof schema === "object") {
      normalizeRequired(schema);
      const obj = schema as Record<string, unknown>;
      if (!Array.isArray(obj.required)) obj.required = [];
    }
    // Drop Anthropic-only server-tool fields Grok doesn't understand.
    for (const key of ["allowed_domains", "blocked_domains", "max_uses", "user_location", "citations", "defer_loading"] as const) {
      if (key in tool) delete tool[key];
    }
  }
}

function extractSearchQuery(body: AnthropicBody): string | null {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = blocksToText(messages[i]!.content);
    const m = text.match(/Perform a web search for the query:\s*(.+)$/s);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

function isWebSearchSideQuery(body: AnthropicBody): boolean {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return false;
  if (!body.tools.some(isWebSearchTool)) return false;
  // Claude Code forces tool_choice to web_search for the side-query path.
  const tc = body.tool_choice;
  if (tc && typeof tc === "object" && tc.type === "tool" && (tc.name === "web_search" || tc.name === "WebSearch")) {
    return true;
  }
  // Or the user message is the WebSearch wrapper prompt.
  return extractSearchQuery(body) != null;
}

async function duckDuckGoSearch(
  query: string,
  opts: { allowed_domains?: string[]; blocked_domains?: string[] } = {},
): Promise<SearchHit[]> {
  const form = new URLSearchParams({ q: query, b: "" });
  if (Array.isArray(opts.allowed_domains) && opts.allowed_domains.length) {
    form.set("q", `${query} ${opts.allowed_domains.map((d) => `site:${d}`).join(" ")}`);
  }
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "text/html",
    },
    body: form.toString(),
  });
  if (!res.ok) throw new Error(`DuckDuckGo search failed (${res.status})`);
  const html = await res.text();
  const results: SearchHit[] = [];
  const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < 8) {
    let url = m[1]!;
    const title = m[2]!.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]!);
    if (!title || !/^https?:\/\//.test(url)) continue;
    if (Array.isArray(opts.blocked_domains) && opts.blocked_domains.some((d) => url.includes(d))) continue;
    results.push({ title, url });
  }
  return results;
}

// Prefer Exa when EXA_API_KEY is set (neural/semantic search, good for agent research).
// Auth: x-api-key header (Authorization: Bearer also accepted by Exa).
async function exaSearch(
  query: string,
  opts: { allowed_domains?: string[]; blocked_domains?: string[] } = {},
): Promise<SearchHit[] | null> {
  const key = process.env.EXA_API_KEY;
  if (!key) return null;
  const body: Record<string, unknown> = {
    query,
    type: "auto",
    numResults: 8,
  };
  if (Array.isArray(opts.allowed_domains) && opts.allowed_domains.length) body.includeDomains = opts.allowed_domains;
  if (Array.isArray(opts.blocked_domains) && opts.blocked_domains.length) body.excludeDomains = opts.blocked_domains;
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Exa search failed (${res.status})`);
  const data = (await res.json()) as { results?: { title?: string; url?: string }[] };
  return (data.results || [])
    .map((r) => ({ title: r.title || r.url || "result", url: r.url || "" }))
    .filter((r) => r.url);
}

async function runWebSearch(
  query: string,
  opts: { allowed_domains?: string[]; blocked_domains?: string[] } = {},
): Promise<SearchHit[]> {
  try {
    const viaExa = await exaSearch(query, opts);
    if (viaExa && viaExa.length) return viaExa;
  } catch {
    // Fall through to DuckDuckGo.
  }
  return duckDuckGoSearch(query, opts);
}

function makeWebSearchResponse(model: string | undefined, query: string, results: SearchHit[]) {
  const id = `msg_websearch_${Date.now()}`;
  const toolUseId = `server_tool_use_${Date.now()}`;
  return {
    id,
    type: "message",
    role: "assistant",
    model: model || "grok-4.5",
    // Claude Code's WebSearch result parser expects server_tool_use +
    // web_search_tool_result content blocks (not plain tool_use).
    content: [
      {
        type: "server_tool_use",
        id: toolUseId,
        name: "web_search",
        input: { query },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: toolUseId,
        content: results.map((r) => ({ type: "web_search_result", title: r.title, url: r.url })),
      },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function writeWebSearchSse(res: ServerResponse, model: string | undefined, query: string, results: SearchHit[]): void {
  const msg = makeWebSearchResponse(model, query, results);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  res.write(
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: msg.id,
        type: "message",
        role: "assistant",
        content: [],
        model: msg.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
  );
  msg.content.forEach((block, index) => {
    res.write(sseEvent("content_block_start", { type: "content_block_start", index, content_block: block }));
    res.write(sseEvent("content_block_stop", { type: "content_block_stop", index }));
  });
  res.write(
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    }),
  );
  res.write(sseEvent("message_stop", { type: "message_stop" }));
  res.end();
}

// Grok's Anthropic endpoint only accepts user/assistant in `messages` (a
// system-role turn 400s with "Invalid message role"). Claude Code emits
// system-role turns, so their text is lifted into the top-level `system` field
// where system instructions belong. Also injects the reasoning effort.
//
// When the body is Claude Code's WebSearch side-query, also return a
// `PendingSearch` so the proxy can fulfill it locally (Grok cannot run Anthropic
// server tools). Domain filters are captured before fixToolSchemas strips them.
function rewriteBody(
  payload: string,
  effort?: string,
): { raw: string; search: PendingSearch | null } {
  let body: AnthropicBody;
  try {
    body = JSON.parse(payload) as AnthropicBody;
  } catch {
    return { raw: payload, search: null };
  }

  let search: PendingSearch | null = null;
  if (isWebSearchSideQuery(body)) {
    const wsTool = (body.tools || []).find(isWebSearchTool) || {};
    search = {
      query: extractSearchQuery(body) || "web search",
      allowed_domains: wsTool.allowed_domains,
      blocked_domains: wsTool.blocked_domains,
      model: body.model,
      stream: !!body.stream,
    };
  }

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
  if (effort) body.reasoning_effort = effort;
  return { raw: JSON.stringify(body), search };
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

// Grok Build's backend already speaks the Anthropic Messages API, so this proxy
// does no translation for normal chat. It injects the session token and the
// client-version header the backend requires (which Claude Code can't send
// itself), optionally sets the reasoning effort, and streams the response
// straight through.
//
// WebSearch is special: Claude Code issues an Anthropic server-tool side-query
// that Grok cannot execute, so we intercept those requests and fulfill them
// with Exa (if EXA_API_KEY is set) or DuckDuckGo HTML.
export async function startGrokProxy(effort?: string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
        res.writeHead(404);
        res.end();
        return;
      }

      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const { raw: payload, search } = rewriteBody(Buffer.concat(chunks).toString(), effort);

        if (search) {
          const results = await runWebSearch(search.query, {
            allowed_domains: search.allowed_domains,
            blocked_domains: search.blocked_domains,
          });
          if (search.stream) {
            writeWebSearchSse(res, search.model, search.query, results);
          } else {
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
            res.end(JSON.stringify(makeWebSearchResponse(search.model, search.query, results)));
          }
          return;
        }

        let auth = await getGrokAuth();
        let upstream = await forward(payload, auth);
        if (upstream.status === 401) {
          auth = await getGrokAuth(true);
          upstream = await forward(payload, auth);
        }

        res.writeHead(upstream.status, {
          "Content-Type": upstream.headers.get("content-type") ?? "application/json",
          "Cache-Control": "no-cache",
        });
        if (upstream.body) {
          const reader = upstream.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        }
        res.end();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (res.headersSent) {
          // Mid-stream failure: an error body would corrupt the SSE stream.
          res.end();
          return;
        }
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message } }));
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}
