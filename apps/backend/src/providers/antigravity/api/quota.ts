import { getClientHeaders, generateFingerprint } from "@/providers/antigravity/upstream/headers.ts";
import { getAccounts, saveAccounts } from "@/providers/antigravity/auth/manager";
import { refreshAccessToken } from "@/providers/antigravity/auth/oauth";
import { type AntigravityAccount } from "@/providers/antigravity/auth/types";

export async function fetchQuota(account: AntigravityAccount, retry = true): Promise<AntigravityAccount["quota"] | null> {
  if (!account.projectId || !account.accessToken) return null;

  if (!account.fingerprint || !account.fingerprint.clientMetadata?.sqmId) {
    account.fingerprint = generateFingerprint(account.email);
  }

  try {
    const res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", {
      method: "POST",
      headers: {
        ...getClientHeaders(account.accessToken, account.fingerprint),
        "User-Agent": "antigravity",
      },
      body: JSON.stringify({
        project: account.projectId,
      }),
    });

    if (res.status === 401 && retry) {
      console.log(`Quota fetch 401 for ${account.email}, refreshing token...`);
      try {
        const tokens = await refreshAccessToken(account.refreshToken);
        account.accessToken = tokens.access_token;
        account.expiresAt = Date.now() + (tokens.expires_in * 1000);
        await saveAccounts(getAccounts());
        return fetchQuota(account, false);
      } catch (e) {
        console.error(`Failed to refresh token for ${account.email} during quota fetch`, e);
        return null;
      }
    }

    if (!res.ok) {
      console.error(`Quota fetch failed for ${account.email}: ${res.status}`);
      return null;
    }

    return parseQuotaResponse(await res.json());
  } catch (e) {
    console.error(`Error fetching quota for ${account.email}`, e);
  }

  return null;
}

function getNextMidnightPT(): string {
  const now = new Date();
  const ptDateStr = now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
  const ptDate = new Date(ptDateStr);

  const midnightPT = new Date(ptDate);
  midnightPT.setHours(24, 0, 0, 0);

  const diffMs = midnightPT.getTime() - ptDate.getTime();
  return new Date(now.getTime() + diffMs).toISOString();
}

export const supportedModelsCache: Set<string> = new Set();

export function parseQuotaResponse(data: any): AntigravityAccount["quota"] | null {
  let rawModels = data.availableModels || data.models || [];
  let entries: [string, any][] = [];

  if (!Array.isArray(rawModels) && typeof rawModels === "object") {
    entries = Object.entries(rawModels);
  } else {
    entries = rawModels.map((model: any) => [model.model?.name || model.displayName || model.displayMetadata?.label || "Unknown", model]);
  }

  const groups = new Map<string, any>();

  for (const [key, model] of entries) {
    if (!model.quotaInfo) continue;

    const label = model.displayMetadata?.label || model.displayName || model.model?.name || "Unknown";
    const lowerLabel = label.toLowerCase();

    if (label === "Unknown" || lowerLabel === "unknown") continue;

    const modelId = key.replace("models/", "");
    if (modelId && modelId !== "Unknown" && !modelId.includes(" ")) {
      supportedModelsCache.add(modelId);
    } else if (label !== "Unknown") {
      supportedModelsCache.add(label);
    }

    const allowedPatterns = [
      "Claude",
      "Anthropic",
      "GPT",
      "Gemini",
      "chat",
      "tab_flash",
      "MODEL_PLACEHOLDER",
    ];

    const isAllowed = allowedPatterns.some((pattern) => label.includes(pattern));
    if (!isAllowed) continue;

    const remainingFraction = model.quotaInfo.remainingFraction ?? 0;
    const limitName = model.quotaInfo.limitName || label;

    if (groups.has(limitName)) {
      const group = groups.get(limitName);
      if (!group.labels.includes(label)) {
        group.labels.push(label);
        group.labels.sort();
        group.groupName = group.labels.join(" / ");
      }
      if (!group.modelIds.includes(modelId)) {
        group.modelIds.push(modelId);
      }
      // Models sharing a limitName share a bucket, so these figures should
      // already agree. Keeping the lower one means a disagreement is reported
      // conservatively rather than as whichever model happened to be parsed
      // first — the number feeds account ranking and the exhaustion check.
      if (remainingFraction < group.remainingFraction) {
        group.remainingFraction = remainingFraction;
        group.quotaLeft = `${Math.round(remainingFraction * 100)}%`;
      }
    } else {
      let resetTime = model.quotaInfo.quotaResetTime ||
        model.quotaResetTime ||
        model.quotaInfo.resetTime ||
        model.resetTime ||
        model.quotaInfo.nextResetTime ||
        model.nextResetTime ||
        model.quotaInfo.quota_reset_time ||
        model.quota_reset_time;

      if (typeof resetTime === "number") {
        if (resetTime < 10000000000) resetTime *= 1000;
        resetTime = new Date(resetTime).toISOString();
      }

      if (typeof resetTime === "string" && resetTime.endsWith("s") && /^\d+/.test(resetTime)) {
        const seconds = parseInt(resetTime, 10);
        if (!Number.isNaN(seconds)) {
          resetTime = new Date(Date.now() + seconds * 1000).toISOString();
        }
      }

      if (!resetTime || Number.isNaN(new Date(resetTime).getTime())) {
        resetTime = getNextMidnightPT();
      }

      const diffMs = Math.max(0, new Date(resetTime).getTime() - Date.now());
      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      const resetIn = `${hours}h ${minutes}m`;
      const pct = Math.round(remainingFraction * 100);
      const quotaLeft = `${pct}%`;

      groups.set(limitName, {
        groupName: label,
        labels: [label],
        modelIds: [modelId],
        limit: model.quotaInfo.quotaLimit || "Unknown",
        usage: model.quotaInfo.quotaUsage || "Unknown",
        limitName,
        remainingFraction,
        resetTime,
        quotaLeft,
        resetIn,
      });
    }
  }

  const results = Array.from(groups.values()).map((group) => {
    const { labels, ...rest } = group;
    return rest;
  });

  results.sort((a, b) => a.groupName.localeCompare(b.groupName));

  return results.length > 0 ? results : null;
}

export async function refreshAllQuotas() {
  const accounts = getAccounts();

  await Promise.all(accounts.map(async (account) => {
    if (account.projectId) {
      const quota = await fetchQuota(account);
      if (quota) {
        account.quota = quota;
        await saveAccounts(getAccounts());
      }
    }
  }));
}
