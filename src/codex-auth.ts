import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";

const AUTH_PATH = join(homedir(), ".codex", "auth.json");
const VERSION_PATH = join(homedir(), ".codex", "version.json");
const REFRESH_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
// Codex refreshes when the access token is within this window of expiry.
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

export interface CodexTokens {
  accessToken: string;
  accountId: string;
}

function readAuthFile(): CodexAuthFile {
  if (!existsSync(AUTH_PATH)) {
    throw new Error("No ~/.codex/auth.json found. Sign in first: run `codex` and choose 'Sign in with ChatGPT'.");
  }
  return JSON.parse(readFileSync(AUTH_PATH, "utf-8")) as CodexAuthFile;
}

function jwtExpMs(token: string): number | null {
  const payloadPart = token.split(".")[1];
  if (!payloadPart) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString()) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// Refresh tokens rotate, so concurrent requests must never refresh in parallel
// (the second POST reuses an already-invalidated token and kills the session).
// A single in-flight refresh is shared by all callers that race on it.
let refreshInFlight: Promise<CodexAuthFile> | null = null;

async function refresh(file: CodexAuthFile): Promise<CodexAuthFile> {
  const refreshToken = file.tokens?.refresh_token;
  if (!refreshToken) {
    throw new Error("No refresh_token in ~/.codex/auth.json. Re-run `codex` and sign in again.");
  }
  const res = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!res.ok) {
    throw new Error(`Codex token refresh failed (${res.status}). Re-run \`codex\` and sign in again.`);
  }
  const data = (await res.json()) as { id_token?: string; access_token?: string; refresh_token?: string };
  file.tokens = {
    ...file.tokens,
    id_token: data.id_token ?? file.tokens?.id_token,
    access_token: data.access_token ?? file.tokens?.access_token,
    refresh_token: data.refresh_token ?? file.tokens?.refresh_token,
  };
  file.last_refresh = new Date().toISOString();
  writeFileSync(AUTH_PATH, JSON.stringify(file, null, 2));
  chmodSync(AUTH_PATH, 0o600);
  return file;
}

// Returns a live access token + account id from the Codex login, refreshing
// through the same OAuth endpoint Codex uses when the token is near expiry.
// Pass force=true to refresh unconditionally (used to recover from a 401).
export async function getCodexTokens(force = false): Promise<CodexTokens> {
  let file = readAuthFile();
  if (file.auth_mode && file.auth_mode !== "chatgpt") {
    throw new Error(`~/.codex is in "${file.auth_mode}" mode, not "chatgpt". Sign in to Codex with your ChatGPT plan.`);
  }
  const token = file.tokens?.access_token;
  const exp = token ? jwtExpMs(token) : null;
  const stale = force || !token || (exp !== null && exp <= Date.now() + REFRESH_WINDOW_MS);
  if (stale) {
    if (!refreshInFlight) {
      refreshInFlight = refresh(file).finally(() => {
        refreshInFlight = null;
      });
    }
    file = await refreshInFlight;
  }

  const accessToken = file.tokens?.access_token;
  const accountId = file.tokens?.account_id;
  if (!accessToken || !accountId) {
    throw new Error("Codex auth is missing access_token or account_id. Re-run `codex` and sign in again.");
  }
  return { accessToken, accountId };
}

export function getCodexVersion(): string {
  try {
    const v = JSON.parse(readFileSync(VERSION_PATH, "utf-8")) as { version?: string };
    return v.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
