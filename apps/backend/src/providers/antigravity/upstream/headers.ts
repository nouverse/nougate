import { type DeviceFingerprint } from "../auth/types";

export const OAUTH_CONFIG = {
  clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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",
  authUri: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUri: "https://oauth2.googleapis.com/token",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
  get redirectUri(): string {
    return "http://localhost:3000/oauth-callback";
  },
};

const ANTIGRAVITY_VERSION = "2.0.1";

const PLATFORMS = ["darwin/x64", "darwin/arm64"] as const;

const SDK_CLIENTS = [
  "google-cloud-sdk vscode/1.107.0",
  "google-cloud-sdk vscode/1.106.0",
] as const;

const GEMINI_CLI_USER_AGENTS = [
  "google-api-nodejs-client/9.15.1",
  "google-api-nodejs-client/9.14.0",
  "google-api-nodejs-client/9.13.0",
  "google-api-nodejs-client/10.3.0",
] as const;

const GEMINI_CLI_API_CLIENTS = [
  "gl-node/22.17.0",
  "gl-node/22.12.0",
  "gl-node/20.18.0",
  "gl-node/21.7.0",
  "gl-node/22.18.0",
] as const;

/**
 * Memilih nilai acak dari daftar fingerprint yang valid.
 */
function randomFrom<T>(values: readonly T[]): T {
  return values[Math.floor(Math.random() * values.length)];
}

/**
 * Membuat device ID ala UUID untuk metadata upstream.
 */
function generateDeviceId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = Math.random() * 16 | 0;
    const value = char === "x" ? random : (random & 0x3 | 0x8);
    return value.toString(16);
  });
}

/**
 * Membuat token sesi acak untuk meniru sesi IDE upstream.
 */
function generateSessionToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Menurunkan quota user stabil dari email agar fingerprint konsisten.
 */
function generateStableQuotaUser(email: string): string {
  const hash = Buffer.from(new Bun.CryptoHasher("sha256").update(email).digest()).toString("hex");
  return `device-${hash.substring(0, 16)}`;
}

/**
 * Membuat quota user acak untuk sesi tanpa email.
 */
function generateQuotaUser(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `device-${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Menghasilkan fingerprint perangkat yang dipakai untuk request ke upstream.
 */
export function generateFingerprint(email?: string): DeviceFingerprint {
  const platform = randomFrom(PLATFORMS);
  const arch = platform.includes("arm64") ? "arm64" : "x64";
  const ideType = "VSCODE";
  const platformName = "MACOS";
  const osVersions = ["15.1", "15.2", "15.3", "15.4"];
  const osVersion = randomFrom(osVersions);
  const apiClient = randomFrom(SDK_CLIENTS);
  const sqmId = crypto.randomUUID();

  return {
    userAgent: `antigravity/${ANTIGRAVITY_VERSION} ${platform}`,
    quotaUser: email ? generateStableQuotaUser(email) : generateQuotaUser(),
    deviceId: email ? generateStableQuotaUser(email).replace("device-", "") : generateDeviceId(),
    platform,
    apiClient,
    ideType,
    platformName,
    sessionToken: generateSessionToken(),
    cliUserAgent: randomFrom(GEMINI_CLI_USER_AGENTS),
    cliApiClient: randomFrom(GEMINI_CLI_API_CLIENTS),
    clientMetadata: {
      ideType,
      platform: platformName,
      pluginType: "GEMINI",
      osVersion,
      arch,
      sqmId,
    },
    createdAt: Date.now(),
  };
}

/**
 * Menyusun header impersonation untuk endpoint web IDE.
 */
export function getImpersonationHeaders(accessToken: string, fingerprint?: DeviceFingerprint, model?: string): Record<string, string> {
  const activeFingerprint = fingerprint || generateFingerprint();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/${ANTIGRAVITY_VERSION} Chrome/142.0.7444.175 Electron/39.2.3 Safari/537.36`,
    "X-Goog-Api-Client": activeFingerprint.apiClient,
    "X-Goog-QuotaUser": activeFingerprint.quotaUser,
    "X-Client-Device-Id": activeFingerprint.deviceId,
    "Client-Metadata": activeFingerprint.clientMetadata
      ? JSON.stringify({
        ideType: activeFingerprint.clientMetadata.ideType,
        platform: activeFingerprint.clientMetadata.platform,
        pluginType: activeFingerprint.clientMetadata.pluginType,
        osVersion: activeFingerprint.clientMetadata.osVersion,
        arch: activeFingerprint.clientMetadata.arch,
      })
      : "{\"ideType\":\"VSCODE\",\"platform\":\"MACOS\",\"pluginType\":\"GEMINI\",\"osVersion\":\"15.1\",\"arch\":\"arm64\"}",
  };

  if (model?.toLowerCase().includes("claude") || model?.toLowerCase().includes("anthropic")) {
    headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
  }

  return headers;
}

/**
 * Menyusun header untuk endpoint Gemini CLI upstream.
 */
export function getGeminiCliHeaders(accessToken: string, fingerprint?: DeviceFingerprint): Record<string, string> {
  const activeFingerprint = fingerprint || generateFingerprint();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": activeFingerprint.cliUserAgent,
    "X-Goog-Api-Client": activeFingerprint.cliApiClient,
    "X-Goog-QuotaUser": activeFingerprint.quotaUser,
    "X-Client-Device-Id": activeFingerprint.deviceId,
    "Content-Type": "application/json; charset=utf-8",
  };

  if (activeFingerprint.clientMetadata) {
    headers["Client-Metadata"] = Object.entries(activeFingerprint.clientMetadata)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join(",");
  } else {
    headers["Client-Metadata"] = "ideType=VSCODE,platform=MACOS,pluginType=GEMINI,osVersion=14.5,arch=arm64";
  }

  return headers;
}
