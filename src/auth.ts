import { createHash, randomBytes } from "crypto";

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

export async function waitForCallback(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = Bun.serve({
      port: CALLBACK_PORT,
      fetch(req) {
        const url = new URL(req.url);
        const code = url.searchParams.get("code");

        if (code) {
          resolve(code);
          setTimeout(() => server.stop(), 100);
          return new Response(
            `<!DOCTYPE html>
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
</html>`,
            { headers: { "Content-Type": "text/html" } }
          );
        }

        reject(new Error("No code received"));
        setTimeout(() => server.stop(), 100);
        return new Response("No code received", { status: 400 });
      },
    });

    setTimeout(() => {
      server.stop();
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

  const data = await res.json();
  return data.key;
}

export async function login(): Promise<string> {
  const { verifier, challenge } = generatePKCE();
  const authUrl = getAuthUrl(challenge);

  console.log("Opening browser for authentication...");
  Bun.spawn(["open", authUrl]);

  console.log("Waiting for callback...");
  const code = await waitForCallback();

  console.log("Exchanging code for API key...");
  const apiKey = await exchangeCodeForKey(code, verifier);

  return apiKey;
}
