import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { request as httpsRequest } from "https";
import { listenOnRandomPort, stripHopByHop, writeApiError } from "./proxy-shared";

const ANTHROPIC_HOST = "api.anthropic.com";

// A routed request is the parsed /v1/messages body with the backend prefix
// already stripped from the model field.
export type RoutedRequest = { model: string; output_config?: { effort?: string } } & Record<string, unknown>;
export type MixedHandler = (parsed: RoutedRequest, res: ServerResponse) => Promise<void>;
// effortSuffix marks backends whose slot models may carry a "@effort" pin;
// only their "@" suffixes are stripped, so model ids that legitimately
// contain "@" (LM Studio quant tags, HF revisions) survive on other backends.
export interface MixedRoute {
  handler: MixedHandler;
  effortSuffix?: boolean;
}

// Forwards the request end-to-end so Claude Code's subscription OAuth bearer
// and anthropic-beta headers reach the API unmodified.
function passthrough(req: IncomingMessage, body: Buffer, res: ServerResponse): void {
  const headers = stripHopByHop({ ...req.headers, host: ANTHROPIC_HOST, "content-length": String(body.length) });
  const upstream = httpsRequest(
    { hostname: ANTHROPIC_HOST, path: req.url, method: req.method, headers },
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
  upstream.end(body);
}

// Routes per request on the model field's "backend:model" prefix; the handler
// map is assembled by the caller so this module knows nothing about
// individual backends. count_tokens for routed models gets a 404 (Claude Code
// falls back to estimation) - the translation backends have no count
// endpoint, and a uniform answer beats per-backend guesses. Everything else,
// including unprefixed Claude models, passes through to Anthropic.
export async function startMixedProxy(routes: Record<string, MixedRoute>): Promise<{ port: number; close: () => void }> {
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
      let parsed: RoutedRequest | undefined;
      try {
        parsed = JSON.parse(body.toString()) as RoutedRequest;
      } catch {
        parsed = undefined;
      }
      // Split on the FIRST colon: model ids themselves may contain colons
      // (openrouter:vendor/model:free, ollama:qwen3:8b).
      const sep = typeof parsed?.model === "string" ? parsed.model.indexOf(":") : -1;
      if (parsed && sep > 0) {
        const route = routes[parsed.model.slice(0, sep)];
        if (route) {
          if (req.url.startsWith("/v1/messages/count_tokens")) {
            res.writeHead(404);
            res.end();
          } else {
            parsed.model = parsed.model.slice(sep + 1);
            // A "@effort" suffix pins reasoning effort for this slot: it is
            // written into output_config.effort, overriding the session's
            // /effort value, and each handler picks it up from there.
            const at = route.effortSuffix ? parsed.model.lastIndexOf("@") : -1;
            if (at > 0) {
              parsed.output_config = { ...parsed.output_config, effort: parsed.model.slice(at + 1) };
              parsed.model = parsed.model.slice(0, at);
            }
            await route.handler(parsed, res);
          }
          return;
        }
      }
    }
    passthrough(req, body, res);
  });

  return listenOnRandomPort(server);
}
