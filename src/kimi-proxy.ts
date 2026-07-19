import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { getKimiAuth, identityHeaders, type KimiAuth, type KimiIdentity } from "./kimi-auth";
import { normalizeAnthropicContent } from "./anthropic-adapter";
import { listenOnRandomPort, pipeFetchResponse, readJsonBody, writeApiError } from "./proxy-shared";

// Subscription (OAuth) traffic goes to api.kimi.com/coding - a different host
// from the API-key endpoint at api.moonshot.ai/anthropic. Don't conflate them.
const KIMI_BASE_URL = "https://api.kimi.com/coding";

export type KimiBody = Parameters<typeof normalizeAnthropicContent>[0];

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

// Kimi's coding backend speaks the Anthropic Messages API natively: no
// translation, just the OAuth token and CLI identity headers the backend
// expects (which Claude Code can't send itself), and a straight
// stream-through of the response.
export async function handleKimiMessages(body: KimiBody, res: ServerResponse, identity: KimiIdentity): Promise<void> {
  try {
    normalizeAnthropicContent(body);
    const payload = JSON.stringify(body);

    let auth = await getKimiAuth();
    let upstream = await forward(payload, auth, identity);
    if (upstream.status === 401) {
      auth = await getKimiAuth(true);
      upstream = await forward(payload, auth, identity);
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

export async function startKimiProxy(identity: KimiIdentity): Promise<{ port: number; close: () => void }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
      res.writeHead(404);
      res.end();
      return;
    }
    const parsed = await readJsonBody<KimiBody>(req, res);
    if (!parsed) return;
    await handleKimiMessages(parsed, res, identity);
  });

  return listenOnRandomPort(server);
}
