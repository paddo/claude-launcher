import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "http";
import { request as httpsRequest } from "https";
import { listenOnRandomPort, stripHopByHop, writeApiError } from "./proxy-shared";

const OPENROUTER_HOST = "openrouter.ai";

type TextBlock = { type: "text"; text: string } & Record<string, unknown>;
type Message = { role: string; content: string | Record<string, unknown>[] };
export type OpenRouterBody = { model?: string; messages?: Message[] } & Record<string, unknown>;

// Claude Code adds a system-role message to the conversation on most turns,
// right after a user turn. For non-Anthropic models OpenRouter moves every
// system message into the provider's system prompt (Gemini's
// systemInstruction), so that prompt changes each turn and the provider's
// prefix cache never hits. Appending the text to the preceding user message
// keeps the prefix stable. Anthropic models keep system messages in place
// and cache them natively.
export function foldSystemMessages(body: OpenRouterBody): void {
  if (!Array.isArray(body.messages) || String(body.model).replace(/^~/, "").startsWith("anthropic/")) return;
  const out: Message[] = [];
  for (const m of body.messages) {
    if (m.role !== "system") {
      out.push(m);
      continue;
    }
    const blocks: TextBlock[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as TextBlock[]);
    const prev = out[out.length - 1];
    if (prev?.role === "user") {
      const content = typeof prev.content === "string" ? [{ type: "text", text: prev.content }] : prev.content;
      out[out.length - 1] = { ...prev, content: [...content, ...blocks] };
    } else {
      out.push({ role: "user", content: blocks });
    }
  }
  body.messages = out;
}

// Raw relay, so status, rate-limit headers (retry-after) and the encoded
// body reach Claude Code exactly as OpenRouter sent them.
function relay(method: string, path: string, headers: OutgoingHttpHeaders, body: Buffer, res: ServerResponse): void {
  const upstream = httpsRequest(
    {
      hostname: OPENROUTER_HOST,
      path: `/api${path}`,
      method,
      headers: stripHopByHop({ ...headers, host: OPENROUTER_HOST, "content-length": String(body.length) }),
    },
    (ur) => {
      res.writeHead(ur.statusCode ?? 502, stripHopByHop({ ...ur.headers }));
      ur.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    if (res.headersSent) {
      // Mid-stream failure: an error body would corrupt the SSE stream.
      res.end();
      return;
    }
    writeApiError(res, 502, err.message);
  });
  // Esc in Claude Code closes the client socket; dropping the upstream
  // request stops OpenRouter generating (and billing) the rest.
  res.on("close", () => upstream.destroy());
  upstream.end(body);
}

export async function forwardOpenRouter(apiKey: string | undefined, body: OpenRouterBody, res: ServerResponse): Promise<void> {
  try {
    foldSystemMessages(body);
  } catch (err) {
    writeApiError(res, 400, err instanceof Error ? err.message : String(err));
    return;
  }
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "anthropic-version": "2023-06-01" };
  relay("POST", "/v1/messages", headers, Buffer.from(JSON.stringify(body)), res);
}

// Claude Code's own headers (Authorization with the OpenRouter key,
// anthropic-beta) pass through unchanged; only message bodies are rewritten.
export async function startOpenRouterProxy(): Promise<{ port: number; close: () => void }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // The request stream's async iterator rejects on client abort; uncaught,
    // that rejection kills the whole proxy process under bun.
    let body: Buffer;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = Buffer.concat(chunks);
    } catch {
      res.destroy();
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
      try {
        const parsed = JSON.parse(body.toString()) as OpenRouterBody;
        foldSystemMessages(parsed);
        body = Buffer.from(JSON.stringify(parsed));
      } catch (err) {
        writeApiError(res, 400, err instanceof Error ? err.message : String(err));
        return;
      }
    }
    relay(req.method ?? "GET", req.url ?? "/", req.headers, body, res);
  });

  return listenOnRandomPort(server);
}
