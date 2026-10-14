import { type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "http";
import { request as httpsRequest } from "https";
import { pipeline } from "stream";

// Distinguishes a client abort (connection is gone, nobody to answer - and the
// stream's async iterator rejection would kill the whole proxy process under
// bun if left uncaught) from malformed JSON (client gets a structured error).
export async function readJsonBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | undefined> {
  let raw: Buffer;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    raw = Buffer.concat(chunks);
  } catch {
    res.destroy();
    return undefined;
  }
  try {
    return JSON.parse(raw.toString()) as T;
  } catch {
    writeApiError(res, 400, "invalid JSON body");
    return undefined;
  }
}

// Hop-by-hop headers describe one connection, not the message; forwarding
// them alongside the re-framed body (e.g. transfer-encoding: chunked next to
// the recomputed content-length) is a protocol violation.
const HOP_BY_HOP = ["connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization", "proxy-connection"];

export function stripHopByHop<T extends Record<string, unknown>>(headers: T): T {
  for (const h of HOP_BY_HOP) delete headers[h];
  return headers;
}

// Raw relay, so status, rate-limit headers (retry-after) and the encoded
// body reach Claude Code exactly as the upstream sent them.
export function relayRaw(host: string, path: string, method: string, headers: OutgoingHttpHeaders, body: Buffer, res: ServerResponse): void {
  const upstream = httpsRequest(
    { hostname: host, path, method, headers: stripHopByHop({ ...headers, host, "content-length": String(body.length) }) },
    (ur) => {
      res.writeHead(ur.statusCode ?? 502, stripHopByHop({ ...ur.headers }));
      // pipeline, not pipe: an upstream drop mid-stream must close the client
      // connection, or Claude Code waits on a stream that never ends.
      pipeline(ur, res, () => {});
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
  // request stops the provider generating (and billing) the rest.
  res.on("close", () => upstream.destroy());
  upstream.end(body);
}

// Posts a request to an upstream that speaks the Anthropic Messages API
// natively (OpenRouter, Ollama) and streams the response back.
export async function forwardAnthropic(url: string, headers: Record<string, string>, parsed: unknown, res: ServerResponse): Promise<void> {
  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01", ...headers },
      body: JSON.stringify(parsed),
    });
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

export function listenOnRandomPort(server: Server): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

export function writeApiError(res: ServerResponse, status: number, message: string): void {
  if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "api_error", message } }));
}

export async function pipeFetchResponse(upstream: Response, res: ServerResponse): Promise<void> {
  res.writeHead(upstream.status, {
    "Content-Type": upstream.headers.get("content-type") ?? "application/json",
    "Cache-Control": "no-cache",
  });
  if (upstream.body) {
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}
