import { createServer, type IncomingMessage, type ServerResponse } from "http";

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string | AnthropicContentBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIRequest {
  model: string;
  max_tokens: number;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop?: string[];
}

interface OpenAITool {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

function translateMessages(req: AnthropicRequest): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  // System message
  if (req.system) {
    const systemText =
      typeof req.system === "string"
        ? req.system
        : req.system
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");
    if (systemText) messages.push({ role: "system", content: systemText });
  }

  for (const msg of req.messages) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Array content blocks
    const blocks = msg.content;
    const textParts: string[] = [];
    const toolCalls: OpenAIToolCall[] = [];
    const toolResults: OpenAIMessage[] = [];

    for (const block of blocks) {
      if (block.type === "text" && block.text) {
        textParts.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id!,
          type: "function",
          function: {
            name: block.name!,
            arguments: JSON.stringify(block.input ?? {}),
          },
        });
      } else if (block.type === "tool_result") {
        const resultContent =
          typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content
                  .filter((b) => b.type === "text")
                  .map((b) => b.text)
                  .join("\n")
              : "";
        toolResults.push({
          role: "tool",
          content: resultContent,
          tool_call_id: block.tool_use_id,
        });
      }
    }

    if (toolResults.length > 0) {
      messages.push(...toolResults);
    } else if (toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("") : null,
        tool_calls: toolCalls,
      });
    } else {
      messages.push({ role: msg.role, content: textParts.join("") });
    }
  }

  return messages;
}

function translateTools(tools: AnthropicTool[]): OpenAITool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function buildOpenAIRequest(req: AnthropicRequest): OpenAIRequest {
  const result: OpenAIRequest = {
    model: req.model,
    max_tokens: req.max_tokens,
    messages: translateMessages(req),
    stream: req.stream,
  };
  if (req.tools?.length) result.tools = translateTools(req.tools);
  if (req.temperature !== undefined) result.temperature = req.temperature;
  if (req.top_p !== undefined) result.top_p = req.top_p;
  if (req.stop_sequences?.length) result.stop = req.stop_sequences;
  return result;
}

function sseEvent(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeMessageStart(model: string): string {
  return sseEvent("message_start", {
    type: "message_start",
    message: {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
}

function makeContentBlockStart(index: number, block: { type: string; id?: string; name?: string }): string {
  return sseEvent("content_block_start", {
    type: "content_block_start",
    index,
    content_block: block,
  });
}

function makeContentBlockDelta(index: number, delta: unknown): string {
  return sseEvent("content_block_delta", {
    type: "content_block_delta",
    index,
    delta,
  });
}

function makeContentBlockStop(index: number): string {
  return sseEvent("content_block_stop", { type: "content_block_stop", index });
}

function makeMessageDelta(stopReason: string): string {
  return sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 0 },
  });
}

function makeMessageStop(): string {
  return sseEvent("message_stop", { type: "message_stop" });
}

async function handleStreaming(
  openaiRes: Response,
  res: ServerResponse,
  model: string
) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  res.write(makeMessageStart(model));

  let contentIndex = 0;
  let textStarted = false;
  // Track tool calls: index in OpenAI -> our block index
  const toolBlockIndices = new Map<number, number>();
  const toolCallArgs = new Map<number, string>();
  let hasToolCalls = false;

  const reader = openaiRes.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop()!;

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;

      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (!delta) continue;

      // Text content
      if (delta.content) {
        if (!textStarted) {
          res.write(makeContentBlockStart(contentIndex, { type: "text" }));
          textStarted = true;
        }
        res.write(
          makeContentBlockDelta(contentIndex, {
            type: "text_delta",
            text: delta.content,
          })
        );
      }

      // Tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const tcIndex = tc.index ?? 0;

          if (tc.function?.name) {
            // New tool call starting — close text block if open
            if (textStarted) {
              res.write(makeContentBlockStop(contentIndex));
              contentIndex++;
              textStarted = false;
            }

            hasToolCalls = true;
            const actualIdx = contentIndex;
            toolBlockIndices.set(tcIndex, actualIdx);
            toolCallArgs.set(tcIndex, "");
            contentIndex++;

            const toolId = tc.id || `tool_${Date.now()}_${tcIndex}`;
            res.write(
              makeContentBlockStart(actualIdx, {
                type: "tool_use",
                id: toolId,
                name: tc.function.name,
              })
            );
          }

          if (tc.function?.arguments) {
            const idx = toolBlockIndices.get(tcIndex);
            if (idx !== undefined) {
              toolCallArgs.set(tcIndex, (toolCallArgs.get(tcIndex) || "") + tc.function.arguments);
              res.write(
                makeContentBlockDelta(idx, {
                  type: "input_json_delta",
                  partial_json: tc.function.arguments,
                })
              );
            }
          }
        }
      }

      // Finish reason
      if (choice.finish_reason) {
        // Close any open blocks
        if (textStarted) {
          res.write(makeContentBlockStop(contentIndex));
        }
        for (const [, idx] of toolBlockIndices) {
          res.write(makeContentBlockStop(idx));
        }

        const stopReason =
          choice.finish_reason === "tool_calls"
            ? "tool_use"
            : choice.finish_reason === "stop"
              ? hasToolCalls
                ? "tool_use"
                : "end_turn"
              : "end_turn";
        res.write(makeMessageDelta(stopReason));
        res.write(makeMessageStop());
      }
    }
  }

  res.end();
}

async function handleNonStreaming(
  openaiRes: Response,
  res: ServerResponse,
  model: string
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await openaiRes.json()) as any;
  const choice = data.choices?.[0];
  if (!choice) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "No choices in response" }));
    return;
  }

  const content: AnthropicContentBlock[] = [];
  let stopReason = "end_turn";

  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }

  if (choice.message?.tool_calls) {
    stopReason = "tool_use";
    for (const tc of choice.message.tool_calls) {
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || "{}"),
      });
    }
  }

  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";

  const response = {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
  };

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(response));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString();
}

export async function startProxy(nimHost: string, apiKey: string): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      // Only handle POST /v1/messages
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
        res.writeHead(404);
        res.end();
        return;
      }

      try {
        const body = JSON.parse(await readBody(req));
        const anthropicReq = body as AnthropicRequest;
        const openaiReq = buildOpenAIRequest(anthropicReq);

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

        const upstream = await fetch(`${nimHost}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(openaiReq),
        });

        if (!upstream.ok) {
          const errText = await upstream.text();
          res.writeHead(upstream.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: errText } }));
          return;
        }

        if (anthropicReq.stream) {
          await handleStreaming(upstream, res, anthropicReq.model);
        } else {
          await handleNonStreaming(upstream, res, anthropicReq.model);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message } }));
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        port,
        close: () => server.close(),
      });
    });
  });
}
