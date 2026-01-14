import { createHash, randomBytes } from "crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { spawn } from "child_process";

const CALLBACK_PORT = 8787;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}`;

export function generatePKCE() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function getAuthUrl(challenge: string): string {
  const params = new URLSearchParams({
    callback_url: CALLBACK_URL,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://openrouter.ai/auth?${params}`;
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>claude-launcher</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      color: #fff;
    }
    .card {
      text-align: center;
      padding: 3rem 4rem;
      background: rgba(255,255,255,0.05);
      border-radius: 16px;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
    }
    .icon { margin-bottom: 1rem; }
    .icon svg { width: 64px; height: 64px; }
    h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.5rem; }
    p { color: rgba(255,255,255,0.6); }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <path d="M9 12l2 2 4-4"/>
      </svg>
    </div>
    <h1>Authenticated</h1>
    <p>You can close this window</p>
  </div>
</body>
</html>`;

export async function waitForCallback(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      const code = url.searchParams.get("code");

      if (code) {
        resolve(code);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(SUCCESS_HTML);
        setTimeout(() => server.close(), 100);
        return;
      }

      reject(new Error("No code received"));
      res.writeHead(400);
      res.end("No code received");
      setTimeout(() => server.close(), 100);
    });

    server.listen(CALLBACK_PORT);

    setTimeout(() => {
      server.close();
      reject(new Error("Auth timeout"));
    }, 120000);
  });
}

export async function exchangeCodeForKey(code: string, verifier: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: "S256",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Key exchange failed: ${text}`);
  }

  const data = (await res.json()) as { key: string };
  return data.key;
}

function openBrowser(url: string) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

export async function login(): Promise<string> {
  const { verifier, challenge } = generatePKCE();
  const authUrl = getAuthUrl(challenge);

  console.log("Opening browser for authentication...");
  openBrowser(authUrl);

  console.log("Waiting for callback...");
  const code = await waitForCallback();

  console.log("Exchanging code for API key...");
  const apiKey = await exchangeCodeForKey(code, verifier);

  return apiKey;
}
