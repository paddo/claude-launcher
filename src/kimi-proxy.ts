import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { getKimiAuth, identityHeaders, type KimiAuth, type KimiIdentity } from "./kimi-auth";
import { normalizeAnthropicContent } from "./anthropic-adapter";

// Subscription (OAuth) traffic goes to api.kimi.com/coding - a different host
// from the API-key endpoint at api.moonshot.ai/anthropic. Don't conflate them.
const KIMI_BASE_URL = "https://api.kimi.com/coding";

function rewriteBody(payload: string): string {
  let body: Parameters<typeof normalizeAnthropicContent>[0];
  try {
    body = JSON.parse(payload);
  } catch {
    return payload;
  }
  normalizeAnthropicContent(body);
  return JSON.stringify(body);
}

async function forward(body: string, auth: KimiAuth, identity: KimiIdentity): Promise<Response> {
  return fetch(`${KIMI_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      ...identityHeaders(identity),
    },
    body,
  });
}

// Kimi's coding backend speaks the Anthropic Messages API natively, so this
// proxy does no translation. It injects the OAuth token and the CLI identity
// headers the backend expects (which Claude Code can't send itself), and
// streams the response straight through.
export async function startKimiProxy(identity: KimiIdentity): Promise<{ port: number; close: () => void }> {
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
        const payload = rewriteBody(Buffer.concat(chunks).toString());

        let auth = await getKimiAuth();
        let upstream = await forward(payload, auth, identity);
        if (upstream.status === 401) {
          auth = await getKimiAuth(true);
          upstream = await forward(payload, auth, identity);
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
