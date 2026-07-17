import { homedir, hostname, type as osType, arch, release } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { execFileSync } from "child_process";
import { randomUUID } from "crypto";

// Kimi Code stores OAuth credentials as plain JSON. CLI migration doesn't copy
// credentials, so a valid login can live in either home.
const CLI_HOMES = [join(homedir(), ".kimi-code"), join(homedir(), ".kimi")];
const CRED_FILE = join("credentials", "kimi-code.json");
const OAUTH_HOST = "https://auth.kimi.com";
// Public device-flow client id hardcoded in the open-source kimi-code CLI.
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const REFRESH_WINDOW_MS = 5 * 60 * 1000;

interface KimiCredFile {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number; // unix seconds, not ms
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface KimiAuth {
  token: string;
}

export interface KimiIdentity {
  version: string;
  deviceId: string;
  deviceName: string;
  deviceModel: string;
  osVersion: string;
}

function findCredPath(): { credPath: string; cliHome: string } {
  for (const home of CLI_HOMES) {
    const credPath = join(home, CRED_FILE);
    if (existsSync(credPath)) return { credPath, cliHome: home };
  }
  throw new Error("No Kimi Code login found. Run `kimi` (from ~/.kimi-code/bin) and sign in with your Kimi subscription first.");
}

async function refresh(credPath: string, file: KimiCredFile): Promise<KimiCredFile> {
  if (!file.refresh_token) {
    throw new Error("Kimi credentials are missing a refresh token. Re-run `kimi` and sign in again.");
  }
  const res = await fetch(`${OAUTH_HOST}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: file.refresh_token,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    throw new Error(`Kimi token refresh failed (${res.status}). Re-run \`kimi\` and sign in again.`);
  }
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("Kimi token refresh returned no access token. Re-run `kimi` and sign in again.");
  }
  file.access_token = data.access_token;
  if (data.refresh_token) file.refresh_token = data.refresh_token;
  if (typeof data.expires_in === "number") {
    file.expires_in = data.expires_in;
    file.expires_at = Math.floor(Date.now() / 1000) + data.expires_in;
  } else {
    // Without a fresh lifetime the old expiry is meaningless; dropping it lets
    // the token ride until a 401 forces a refresh instead of refreshing per call.
    delete file.expires_at;
    delete file.expires_in;
  }
  writeFileSync(credPath, JSON.stringify(file, null, 2));
  chmodSync(credPath, 0o600);
  return file;
}

// Kimi's refresh tokens may rotate, so concurrent requests share one refresh.
let refreshInFlight: Promise<KimiCredFile> | null = null;

// Returns a live access token from the Kimi Code CLI login, refreshing through
// Kimi's OAuth endpoint when it's near expiry. Pass force=true to refresh on a 401.
export async function getKimiAuth(force = false): Promise<KimiAuth> {
  const { credPath } = findCredPath();
  let file = JSON.parse(readFileSync(credPath, "utf-8")) as KimiCredFile;
  const expMs = typeof file.expires_at === "number" ? file.expires_at * 1000 : NaN;
  const stale = force || !file.access_token || (!Number.isNaN(expMs) && expMs <= Date.now() + REFRESH_WINDOW_MS);
  if (stale) {
    if (!refreshInFlight) {
      refreshInFlight = refresh(credPath, file).finally(() => {
        refreshInFlight = null;
      });
    }
    file = await refreshInFlight;
  }
  if (!file.access_token) throw new Error("Kimi auth is missing a token. Re-run `kimi` and sign in again.");
  return { token: file.access_token };
}

// The backend expects the CLI's identity headers (X-Msh-*). The device id is a
// per-machine UUID the CLI persists at <cliHome>/device_id; created here if the
// CLI hasn't yet, so both tools share the same identity.
export function getKimiIdentity(): KimiIdentity {
  const { cliHome } = findCredPath();
  const deviceIdPath = join(cliHome, "device_id");
  let deviceId: string;
  if (existsSync(deviceIdPath)) {
    deviceId = readFileSync(deviceIdPath, "utf-8").trim();
  } else {
    deviceId = randomUUID();
    writeFileSync(deviceIdPath, deviceId);
    chmodSync(deviceIdPath, 0o600);
  }

  let version = "0.0.0";
  try {
    version = execFileSync(join(homedir(), ".kimi-code", "bin", "kimi"), ["--version"], { encoding: "utf-8" }).trim();
  } catch {
    // keep fallback
  }

  return {
    version,
    deviceId,
    deviceName: hostname(),
    deviceModel: `${osType()} ${arch()}`,
    osVersion: release(),
  };
}

// The backend expects the CLI's identity headers on every request, model
// discovery included.
export function identityHeaders(identity: KimiIdentity): Record<string, string> {
  return {
    "User-Agent": `kimi-code-cli/${identity.version}`,
    "X-Msh-Platform": "kimi_code_cli",
    "X-Msh-Version": identity.version,
    "X-Msh-Device-Id": identity.deviceId,
    "X-Msh-Device-Name": identity.deviceName,
    "X-Msh-Device-Model": identity.deviceModel,
    "X-Msh-Os-Version": identity.osVersion,
  };
}
