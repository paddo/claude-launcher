// Claude Code emits Anthropic requests with shapes that stricter backends reject
// (Grok) or that our translators choke on (Codex/NIM/LM Studio crash iterating a
// null content). This normalizes an incoming request in place so every backend
// adapter sees well-formed, standard content. Backend-specific quirks (system
// role handling, tool `required` arrays, reasoning effort) stay in each proxy.

interface Block {
  type?: string;
  content?: unknown;
  tool_name?: string;
  [key: string]: unknown;
}

// Content-block types the Anthropic API defines. Anything else (e.g. Claude
// Code's `tool_reference`) is flattened to a text block so backends that
// validate strictly don't reject it and translators that drop it don't lose it.
const KNOWN_BLOCKS = new Set(["text", "image", "tool_use", "tool_result", "thinking", "redacted_thinking", "document"]);

function sanitizeBlock(block: unknown): unknown {
  if (!block || typeof block !== "object") return block;
  const b = block as Block;
  if (Array.isArray(b.content)) b.content = b.content.map(sanitizeBlock);
  if (typeof b.type === "string" && !KNOWN_BLOCKS.has(b.type)) {
    return { type: "text", text: typeof b.tool_name === "string" ? `(${b.type}: ${b.tool_name})` : "" };
  }
  return b;
}

interface NormalizableBody {
  messages?: { role?: string; content?: unknown }[];
}

// Coerces null message content to an empty block list and flattens unknown
// content blocks to text, recursively (including inside tool_result content).
export function normalizeAnthropicContent(body: NormalizableBody): void {
  if (!Array.isArray(body.messages)) return;
  for (const m of body.messages) {
    if (m.content == null) m.content = [];
    if (Array.isArray(m.content)) m.content = m.content.map(sanitizeBlock);
  }
}
