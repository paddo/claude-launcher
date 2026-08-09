import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";

const AUTH_PATH = join(homedir(), ".grok", "auth.json");
const VERSION_PATH = join(homedir(), ".grok", "version.json");
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

interface GrokEntry {
  key?: string;
  refresh_token?: string;
  expires_at?: string;
  oidc_client_id?: string;
  oidc_issuer?: string;
  auth_mode?: string;
}

type GrokAuthFile = Record<string, GrokEntry>;

export interface GrokAuth {
  token: string;
  version: string;
}

// Cheap launch-time check for route registration; the real token (with
// refresh) is resolved per request inside the proxy.
export const hasGrokAuth = (): boolean => existsSync(AUTH_PATH);

function readAuthFile(): { file: GrokAuthFile; entryKey: string } {
  if (!existsSync(AUTH_PATH)) {
    throw new Error("No ~/.grok/auth.json found. Sign in first: run `grok` and log in with your X/SuperGrok account.");
  }
  const file = JSON.parse(readFileSync(AUTH_PATH, "utf-8")) as GrokAuthFile;
  const entryKey = Object.keys(file)[0];
  if (!entryKey) throw new Error("~/.grok/auth.json is empty. Re-run `grok` and log in.");
  return { file, entryKey };
}

export function getGrokVersion(): string {
  try {
    const v = JSON.parse(readFileSync(VERSION_PATH, "utf-8")) as { version?: string };
    return v.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function refresh(file: GrokAuthFile, entryKey: string): Promise<GrokAuthFile> {
  const entry = file[entryKey]!;
  if (!entry.refresh_token || !entry.oidc_client_id) {
    throw new Error("~/.grok/auth.json is missing a refresh token. Re-run `grok` and log in.");
  }
  const issuer = entry.oidc_issuer ?? "https://auth.x.ai";
  const res = await fetch(`${issuer}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: entry.refresh_token,
      client_id: entry.oidc_client_id,
    }),
  });
  if (!res.ok) {
    throw new Error(`Grok token refresh failed (${res.status}). Re-run \`grok\` and log in.`);
  }
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("Grok token refresh returned no access token. Re-run `grok` and log in.");
  }
  entry.key = data.access_token;
  if (data.refresh_token) entry.refresh_token = data.refresh_token;
  if (typeof data.expires_in === "number") {
    entry.expires_at = new Date(Date.now() + data.expires_in * 1000).toISOString();
  }
  writeFileSync(AUTH_PATH, JSON.stringify(file, null, 2));
  chmodSync(AUTH_PATH, 0o600);
  return file;
}

// Grok's OIDC access token rotates, so concurrent requests share one refresh.
let refreshInFlight: Promise<GrokAuthFile> | null = null;

// Returns a live session token from the Grok Build login, refreshing through
// xAI's OIDC endpoint when it's near expiry. Pass force=true to refresh on a 401.
export async function getGrokAuth(force = false): Promise<GrokAuth> {
  const { file, entryKey } = readAuthFile();
  let entry = file[entryKey]!;
  const expMs = entry.expires_at ? Date.parse(entry.expires_at) : NaN;
  const stale = force || !entry.key || (!Number.isNaN(expMs) && expMs <= Date.now() + REFRESH_WINDOW_MS);
  if (stale) {
    if (!refreshInFlight) {
      refreshInFlight = refresh(file, entryKey).finally(() => {
        refreshInFlight = null;
      });
    }
    entry = (await refreshInFlight)[entryKey]!;
  }
  if (!entry.key) throw new Error("Grok auth is missing a token. Re-run `grok` and log in.");
  return { token: entry.key, version: getGrokVersion() };
}
