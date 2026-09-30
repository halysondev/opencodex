/**
 * Local token auto-detection — reads existing CLI credentials (~/.grok/auth.json,
 * Claude Code's credential file and OS credential stores). Read-only: never writes
 * to external credential stores.
 * Ported from jawcode packages/ai/src/utils/oauth/local-token-detect.ts (xAI portion);
 * the Claude Code portion follows dario's oauth.ts source plan: credential file AND
 * OS keychain on every platform, freshest expiry wins.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthCredentials } from "./types";

const XAI_AUTH_KEY_PREFIX = "https://auth.x.ai::";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

export function detectGrokCliToken(): OAuthCredentials | null {
  const authPath = join(process.env.HOME ?? homedir(), ".grok", "auth.json");
  if (!existsSync(authPath)) return null;

  try {
    const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, Record<string, unknown>>;

    const entry = Object.entries(raw).find(([key]) => key.startsWith(XAI_AUTH_KEY_PREFIX))?.[1];
    if (!entry?.key || !entry?.refresh_token) return null;

    const accessToken = entry.key as string;
    const refreshToken = entry.refresh_token as string;
    const parsedExpiresAt = entry.expires_at ? new Date(entry.expires_at as string).getTime() : 0;
    // Guard against unparseable/NaN expiries: a non-finite value must never be treated as
    // "valid forever". Unknown → 0, which forces the refresh-validation path downstream.
    const expiresAt = Number.isFinite(parsedExpiresAt) ? parsedExpiresAt : 0;

    return {
      refresh: refreshToken,
      access: accessToken,
      expires: expiresAt,
      accountId: entry.user_id as string | undefined,
      email: entry.email as string | undefined,
      source: "local-cli",
    };
  } catch {
    return null;
  }
}

export function hasComparableGrokIdentity(stored: OAuthCredentials, disk: OAuthCredentials): boolean {
  return Boolean((stored.accountId && disk.accountId) || (stored.email && disk.email));
}

export function isSameGrokIdentity(stored: OAuthCredentials, disk: OAuthCredentials): boolean {
  if (stored.accountId && disk.accountId) return stored.accountId === disk.accountId;
  if (stored.email && disk.email) return stored.email.toLowerCase() === disk.email.toLowerCase();
  return false;
}

export function shouldAdoptGrokGeneration(
  stored: OAuthCredentials,
  disk: OAuthCredentials,
  now = Date.now(),
  refreshSkewMs = 60_000,
): boolean {
  // A non-finite disk expiry means we cannot reason about the generation: the credential is
  // either garbage or unknown. Treat it as requiring refresh validation, never as an upgrade.
  if (!Number.isFinite(disk.expires)) return false;
  if (disk.expires <= now + refreshSkewMs) return false;
  const bothExpiriesExist = stored.expires > 0 && disk.expires > 0;
  if (bothExpiriesExist) return disk.expires >= stored.expires;
  return true;
}

/** Claude Code config dir: `CLAUDE_CONFIG_DIR` override, else `~/.claude`. */
function claudeConfigDir(): string {
  const explicit = process.env.CLAUDE_CONFIG_DIR?.trim();
  return explicit ? explicit : join(homedir(), ".claude");
}

/** Read the Claude Code OAuth credential from the macOS Keychain (darwin only). */
function readClaudeKeychain(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    return execSync(`security find-generic-password -s "${CLAUDE_KEYCHAIN_SERVICE}" -w`, {
      encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Read the Claude Code OAuth credential from the Linux Secret Service store via
 * `secret-tool` (libsecret). Modern CC on Linux stores tokens here rather than in
 * ~/.claude/.credentials.json; GNOME Keyring / KWallet both serve the lookup.
 * Null when secret-tool is absent or no entry exists — never throws.
 */
function readClaudeLinuxSecretTool(): string | null {
  if (process.platform !== "linux") return null;
  try {
    return execFileSync("secret-tool", ["lookup", "service", CLAUDE_KEYCHAIN_SERVICE], {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Claude Code on Windows stores OAuth tokens in Windows Credential Manager as
 * Generic credentials whose TargetName is prefixed "Claude Code-credentials"
 * (Node keytar convention). Enumerate matching credentials via PowerShell +
 * Win32 CredEnumerate and return the first blob that parses; null otherwise.
 * The password blob is UTF-16LE (keytar convention on Windows).
 */
const WIN_CLAUDE_CRED_SCRIPT = `
$ErrorActionPreference = 'Stop'
$sig = @"
using System;
using System.Runtime.InteropServices;
public class OcxCM {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CRED {
    public uint Flags; public uint Type; public string TargetName;
    public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LW;
    public uint BlobSize; public IntPtr Blob;
    public uint Persist; public uint AC; public IntPtr Attrs;
    public string Alias; public string UN;
  }
  [DllImport("advapi32.dll", EntryPoint="CredEnumerateW", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredEnumerate(string filter, uint flag, out uint count, out IntPtr pCredentials);
  [DllImport("advapi32.dll", EntryPoint="CredFree")]
  public static extern void CredFree(IntPtr cred);
}
"@
Add-Type -TypeDefinition $sig
$count = 0
$ptr = [IntPtr]::Zero
if ([OcxCM]::CredEnumerate('Claude Code-credentials*', 0, [ref]$count, [ref]$ptr)) {
  try {
    for ($i = 0; $i -lt $count; $i++) {
      $credPtr = [System.Runtime.InteropServices.Marshal]::ReadIntPtr($ptr, $i * [IntPtr]::Size)
      $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($credPtr, [type][OcxCM+CRED])
      if ($cred.BlobSize -gt 0) {
        $bytes = New-Object byte[] $cred.BlobSize
        [System.Runtime.InteropServices.Marshal]::Copy($cred.Blob, $bytes, 0, $cred.BlobSize)
        Write-Output ([System.Text.Encoding]::Unicode.GetString($bytes))
      }
    }
  } finally {
    [OcxCM]::CredFree($ptr)
  }
}
`;

function readClaudeWindowsCredential(): string | null {
  if (process.platform !== "win32") return null;
  try {
    const raw = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WIN_CLAUDE_CRED_SCRIPT],
      { encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    // One JSON blob per matching credential, newline-separated.
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try {
        const parsed = JSON.parse(s) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string } };
        if (parsed?.claudeAiOauth?.accessToken && parsed?.claudeAiOauth?.refreshToken) return s;
      } catch { /* not a credential blob — try next */ }
    }
  } catch { /* Credential Manager unavailable or no entry */ }
  return null;
}

/**
 * Read the Claude Code credential file (`<config-dir>/.credentials.json`).
 * Claude Code writes this on Linux/Windows (and on macOS when the Keychain is
 * unavailable); it carries the same `claudeAiOauth` payload as the Keychain item.
 * Exported for tests.
 */
export function readClaudeCredentialsFile(): string | null {
  const path = join(claudeConfigDir(), ".credentials.json");
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

/** The OS credential-store payload for Claude Code, by platform. */
function readClaudeOsKeychain(): string | null {
  if (process.platform === "darwin") return readClaudeKeychain();
  if (process.platform === "linux") return readClaudeLinuxSecretTool();
  if (process.platform === "win32") return readClaudeWindowsCredential();
  return null;
}

export function parseClaudeOauthPayload(raw: string): OAuthCredentials | null {
  try {
    const data = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number } };
    const o = data.claudeAiOauth;
    if (!o?.accessToken || !o?.refreshToken) return null;
    // Number.isFinite guard: a string/NaN expiresAt must not flow into downstream time
    // comparisons as a "valid forever" value. Unknown → 0 (refresh-validation path).
    const expires = typeof o.expiresAt === "number" && Number.isFinite(o.expiresAt) ? o.expiresAt : 0;
    return { access: o.accessToken, refresh: o.refreshToken, expires, source: "local-cli" };
  } catch {
    return null;
  }
}

/**
 * Every locally-readable Claude Code credential source, freshest first.
 *
 * Source plan mirrors dario's loadCredentials: the credentials file AND the OS
 * keychain are both consulted on every platform, and the freshest `expiresAt`
 * wins — a stale file must not shadow a live keychain entry (and vice versa).
 * An explicit `CLAUDE_CONFIG_DIR` still reads its own file first, but the OS
 * store remains a candidate: some installs keep both, and freshest-wins is the
 * correct pick regardless of which store holds it.
 */
export function detectClaudeCodeToken(): OAuthCredentials | null {
  const candidates: OAuthCredentials[] = [];
  const file = readClaudeCredentialsFile();
  if (file) {
    const parsed = parseClaudeOauthPayload(file);
    if (parsed) candidates.push(parsed);
  }
  const keychain = readClaudeOsKeychain();
  if (keychain) {
    const parsed = parseClaudeOauthPayload(keychain);
    if (parsed) candidates.push(parsed);
  }
  // Freshest expiry wins; stable on ties so the file keeps the tiebreak
  // (canonical order [file, keychain]).
  let best: OAuthCredentials | null = null;
  for (const candidate of candidates) {
    if (!best || (candidate.expires ?? 0) > (best.expires ?? 0)) best = candidate;
  }
  return best;
}

/**
 * The Claude Code device/account identity behind the local install — the pair
 * upstream ties to `metadata.user_id` for subscription billing classification
 * (dario detectClaudeIdentity). Read from `~/.claude.json` (live config) or
 * `<CLAUDE_CONFIG_DIR>/.claude.json`; missing pieces stay empty strings rather
 * than blocking the import — identity is a nicety, the bearer is the grant.
 */
export function detectLocalClaudeIdentity(): { deviceId: string; accountUuid: string } | null {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  const paths = configDir
    ? [join(configDir, ".claude.json"), join(configDir, "claude.json")]
    : [join(homedir(), ".claude.json"), join(homedir(), ".claude", ".claude.json"), join(homedir(), ".claude", "claude.json")];
  for (const p of paths) {
    try {
      const data = JSON.parse(readFileSync(p, "utf8")) as {
        userID?: unknown; installId?: unknown; deviceId?: unknown;
        oauthAccount?: { accountUuid?: unknown }; accountUuid?: unknown;
      };
      const deviceId = typeof data.userID === "string" && data.userID ? data.userID
        : typeof data.installId === "string" && data.installId ? data.installId
        : typeof data.deviceId === "string" ? data.deviceId : "";
      const accountUuid = typeof data.oauthAccount?.accountUuid === "string" && data.oauthAccount.accountUuid
        ? data.oauthAccount.accountUuid
        : typeof data.accountUuid === "string" ? data.accountUuid : "";
      if (deviceId || accountUuid) return { deviceId, accountUuid };
    } catch { /* try next */ }
  }
  return null;
}
