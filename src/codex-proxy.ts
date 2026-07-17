import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { randomUUID } from "crypto";
import { getCodexTokens, getCodexVersion, type CodexTokens } from "./codex-auth";
import { normalizeAnthropicContent } from "./anthropic-adapter";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

interface AnthropicRequest {
  model: string;
  system?: string | AnthropicContentBlock[];
  messages: AnthropicMessage[];
  tools?: { name: string; description?: string; input_schema: Record<string, unknown> }[];
  stream?: boolean;
}

interface ResponseItem {
  type: string;
  role?: string;
  content?: { type: string; text: string }[];
  name?: string;
  call_id?: string;
  arguments?: string;
  output?: string;
}

function systemToText(system?: string | AnthropicContentBlock[]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

function textItem(role: string, text: string): ResponseItem {
  // The Codex backend rejects "system" role items ("System messages are not
  // allowed"), so any non-user/assistant role is folded into "developer".
  const outRole = role === "assistant" ? "assistant" : role === "user" ? "user" : "developer";
  const kind = outRole === "assistant" ? "output_text" : "input_text";
  return { type: "message", role: outRole, content: [{ type: kind, text }] };
}

function messagesToInput(messages: AnthropicMessage[]): ResponseItem[] {
  const items: ResponseItem[] = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      items.push(textItem(msg.role, msg.content));
      continue;
    }
    let textParts: string[] = [];
    const flush = () => {
      if (textParts.length) {
        items.push(textItem(msg.role, textParts.join("")));
        textParts = [];
      }
    };
    for (const block of msg.content) {
      if (block.type === "text" && block.text) {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        flush();
        items.push({
          type: "function_call",
          name: block.name,
          call_id: block.id,
          arguments: JSON.stringify(block.input ?? {}),
        });
      } else if (block.type === "tool_result") {
        flush();
        const output =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
              : "";
        items.push({ type: "function_call_output", call_id: block.tool_use_id, output });
      }
    }
    flush();
  }
  return items;
}

function buildResponsesBody(req: AnthropicRequest, effort: string): Record<string, unknown> {
  const instructions = systemToText(req.system);
  const body: Record<string, unknown> = {
    model: req.model,
    input: messagesToInput(req.messages),
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { effort },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
  };
  if (instructions) body.instructions = instructions;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      // Some Claude Code tool payloads omit description; keep Codex shape valid.
      description: typeof t.description === "string" ? t.description : t.name,
      strict: false,
      parameters: t.input_schema,
    }));
  }
  return body;
}

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

const userAgent = `codex_cli_rs/${getCodexVersion()} (${process.platform}; ${process.arch})`;

async function callCodex(body: Record<string, unknown>, tokens: CodexTokens): Promise<Response> {
  return fetch(`${CODEX_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      "ChatGPT-Account-ID": tokens.accountId,
      originator: "codex_cli_rs",
      "User-Agent": userAgent,
      "session-id": randomUUID(),
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

interface StreamResult {
  text: string;
  toolCalls: { id: string; name: string; args: string }[];
  usage: { input: number; output: number };
  stopReason: string;
  error?: string;
}

// Translates the Codex Responses SSE stream into Anthropic Messages SSE (when
// `res` is provided) and always returns the aggregated result for the
// non-streaming path.
async function consumeCodexStream(
  upstream: Response,
  model: string,
  res?: ServerResponse
): Promise<StreamResult> {
  if (res) {
    res.write(
      sseEvent("message_start", {
        type: "message_start",
        message: {
          id: `msg_${randomUUID()}`,
          type: "message",
          role: "assistant",
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
    );
  }

  const result: StreamResult = { text: "", toolCalls: [], usage: { input: 0, output: 0 }, stopReason: "end_turn" };
  let contentIndex = 0;
  let textOpen = false;
  let completed = false;

  const reader = upstream.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emit = (type: string, data: unknown) => res?.write(sseEvent(type, data));

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;

      let ev: {
        type?: string;
        delta?: string;
        item?: ResponseItem;
        response?: { usage?: Record<string, number>; end_turn?: boolean; error?: { message?: string } };
      };
      try {
        ev = JSON.parse(raw);
      } catch {
        continue;
      }

      switch (ev.type) {
        case "response.output_text.delta": {
          const text = ev.delta ?? "";
          if (!text) break;
          result.text += text;
          if (!textOpen) {
            emit("content_block_start", { type: "content_block_start", index: contentIndex, content_block: { type: "text", text: "" } });
            textOpen = true;
          }
          emit("content_block_delta", { type: "content_block_delta", index: contentIndex, delta: { type: "text_delta", text } });
          break;
        }
        case "response.output_item.done": {
          const item = ev.item;
          if (item?.type !== "function_call") break;
          if (textOpen) {
            emit("content_block_stop", { type: "content_block_stop", index: contentIndex });
            contentIndex++;
            textOpen = false;
          }
          const id = item.call_id ?? `call_${randomUUID()}`;
          const args = item.arguments ?? "{}";
          result.toolCalls.push({ id, name: item.name ?? "", args });
          result.stopReason = "tool_use";
          emit("content_block_start", { type: "content_block_start", index: contentIndex, content_block: { type: "tool_use", id, name: item.name, input: {} } });
          emit("content_block_delta", { type: "content_block_delta", index: contentIndex, delta: { type: "input_json_delta", partial_json: args } });
          emit("content_block_stop", { type: "content_block_stop", index: contentIndex });
          contentIndex++;
          break;
        }
        case "response.completed": {
          if (textOpen) {
            emit("content_block_stop", { type: "content_block_stop", index: contentIndex });
            textOpen = false;
          }
          const usage = ev.response?.usage;
          result.usage = { input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0 };
          emit("message_delta", {
            type: "message_delta",
            delta: { stop_reason: result.stopReason, stop_sequence: null },
            usage: { output_tokens: result.usage.output },
          });
          emit("message_stop", { type: "message_stop" });
          completed = true;
          break;
        }
        case "response.failed":
        case "response.incomplete": {
          result.error = ev.response?.error?.message ?? "Codex stream failed";
          break;
        }
      }
    }
  }

  // Ensure the Anthropic stream always terminates, even when the upstream
  // failed mid-turn or closed without a response.completed event.
  if (res && !completed) {
    if (textOpen) emit("content_block_stop", { type: "content_block_stop", index: contentIndex });
    if (result.error) emit("error", { type: "error", error: { type: "api_error", message: result.error } });
    emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: result.stopReason, stop_sequence: null },
      usage: { output_tokens: result.usage.output },
    });
    emit("message_stop", { type: "message_stop" });
  }

  return result;
}

export async function startCodexProxy(effort: string): Promise<{ port: number; close: () => void }> {
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
        const anthropicReq = JSON.parse(Buffer.concat(chunks).toString()) as AnthropicRequest;
        normalizeAnthropicContent(anthropicReq);
        const body = buildResponsesBody(anthropicReq, effort);

        let tokens = await getCodexTokens();
        let upstream = await callCodex(body, tokens);
        if (upstream.status === 401) {
          tokens = await getCodexTokens(true);
          upstream = await callCodex(body, tokens);
        }

        if (!upstream.ok) {
          const errText = await upstream.text();
          res.writeHead(upstream.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: errText } }));
          return;
        }

        if (anthropicReq.stream) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          await consumeCodexStream(upstream, anthropicReq.model, res);
          res.end();
        } else {
          const result = await consumeCodexStream(upstream, anthropicReq.model);
          if (result.error && !result.text && result.toolCalls.length === 0) {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: result.error } }));
            return;
          }
          const content: AnthropicContentBlock[] = [];
          if (result.text) content.push({ type: "text", text: result.text });
          for (const tc of result.toolCalls) {
            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = JSON.parse(tc.args || "{}");
            } catch {
              parsedArgs = {};
            }
            content.push({ type: "tool_use", id: tc.id, name: tc.name, input: parsedArgs });
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: `msg_${randomUUID()}`,
              type: "message",
              role: "assistant",
              content,
              model: anthropicReq.model,
              stop_reason: result.stopReason,
              stop_sequence: null,
              usage: { input_tokens: result.usage.input, output_tokens: result.usage.output },
            })
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
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
