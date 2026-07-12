import { join } from "path";
import { existsSync, mkdirSync } from "fs";

const MIN_SIGNATURE_LENGTH = 50;

// Layer 1: Map<conversation_id + thought_text_hash, signature>
const signatureCache = new Map<string, string>();

// Layer 1.5: Map<tool_call_id, signature>
const signatureByCallIdCache = new Map<string, string>();

// Layer 2: Map<signature, modelFamily> (prevent cross-model signature contamination)
const signatureFamilyCache = new Map<string, string>();

// Layer 3: Map<session_id, { signature: string, messageCount: number }>
const sessionSignatureCache = new Map<string, { signature: string; messageCount: number }>();

// Layer 4: Map<session_id, string[]> (assistant reasoning text per turn)
const sessionReasoningCache = new Map<string, string[]>();

const CACHE_DIR = existsSync("/app/data")
  ? "/app/data"
  : join(process.cwd(), "tmp");
const CACHE_FILE = join(CACHE_DIR, "signatures.json");

// Helper to save cache to disk asynchronously
function saveCacheToDisk() {
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
    const data = {
      signatures: Array.from(signatureCache.entries()),
      callSignatures: Array.from(signatureByCallIdCache.entries()),
      sessionSignatures: Array.from(sessionSignatureCache.entries()),
      signatureFamilies: Array.from(signatureFamilyCache.entries()),
      sessionReasonings: Array.from(sessionReasoningCache.entries()),
    };
    Bun.write(CACHE_FILE, JSON.stringify(data)).catch(err => {
      console.error("[Cache] Failed to write signatures to disk async:", err);
    });
  } catch (e) {
    console.error("[Cache] Failed to save signatures to disk:", e);
  }
}

// Load cache from disk synchronously/immediately at startup
try {
  if (existsSync(CACHE_FILE)) {
    const fileContent = await Bun.file(CACHE_FILE).text();
    const data = JSON.parse(fileContent);
    if (data.signatures) {
      for (const [k, v] of data.signatures) {
        signatureCache.set(k, v);
      }
    }
    if (data.callSignatures) {
      for (const [k, v] of data.callSignatures) {
        signatureByCallIdCache.set(k, v);
      }
    }
    if (data.sessionSignatures) {
      for (const [k, v] of data.sessionSignatures) {
        sessionSignatureCache.set(k, v);
      }
    }
    if (data.signatureFamilies) {
      for (const [k, v] of data.signatureFamilies) {
        signatureFamilyCache.set(k, v);
      }
    }
    if (data.sessionReasonings) {
      for (const [k, v] of data.sessionReasonings) {
        sessionReasoningCache.set(k, v);
      }
    }
    console.log(
      `[Cache] Loaded ${signatureCache.size} signatures, ${signatureByCallIdCache.size} call signatures, ${sessionSignatureCache.size} session signatures, ${signatureFamilyCache.size} signature families, and ${sessionReasoningCache.size} session reasonings from disk.`
    );
  }
} catch (e) {
  console.warn("[Cache] Failed to load signatures from disk:", e);
}

// ─── Layer 1: Tool / Thought Cache ──────────────────────────────────────────

export function cacheSignature(conversationId: string, thought: string, signature: string) {
  if (signature.length < MIN_SIGNATURE_LENGTH) return;
  const key = `${conversationId}:${Bun.hash(thought)}`; 
  signatureCache.set(key, signature);
  
  if (signatureCache.size > 1000) {
    const first = signatureCache.keys().next().value;
    if (first) signatureCache.delete(first);
  }
  saveCacheToDisk();
}

export function getSignature(conversationId: string, thought: string): string | undefined {
  const key = `${conversationId}:${Bun.hash(thought)}`;
  return signatureCache.get(key);
}

export function cacheSignatureByCallId(callId: string, signature: string) {
  if (signature.length < MIN_SIGNATURE_LENGTH) return;
  signatureByCallIdCache.set(callId, signature);
  if (signatureByCallIdCache.size > 10000) {
    const first = signatureByCallIdCache.keys().next().value;
    if (first) signatureByCallIdCache.delete(first);
  }
  saveCacheToDisk();
}

export function getSignatureByCallId(callId: string): string | undefined {
  return signatureByCallIdCache.get(callId);
}

// ─── Layer 2: Model Family Cache ─────────────────────────────────────────────

export function cacheThinkingFamily(signature: string, family: string) {
  if (signature.length < MIN_SIGNATURE_LENGTH) return;
  signatureFamilyCache.set(signature, family);
  if (signatureFamilyCache.size > 1000) {
    const first = signatureFamilyCache.keys().next().value;
    if (first) signatureFamilyCache.delete(first);
  }
  saveCacheToDisk();
}

export function getSignatureFamily(signature: string): string | undefined {
  return signatureFamilyCache.get(signature);
}

// ─── Layer 3: Session Signature & Rewind Detection ──────────────────────────

export function cacheSessionSignature(sessionId: string, signature: string, messageCount: number) {
  if (signature.length < MIN_SIGNATURE_LENGTH) return;
  
  const existing = sessionSignatureCache.get(sessionId);
  let shouldStore = true;

  if (existing) {
    if (messageCount < existing.messageCount) {
      // Force rewrite on rewind
      shouldStore = true;
    } else if (messageCount === existing.messageCount) {
      // Keep longer signature
      shouldStore = signature.length > existing.signature.length;
    }
  }

  if (shouldStore) {
    sessionSignatureCache.set(sessionId, { signature, messageCount });
    if (sessionSignatureCache.size > 1000) {
      const first = sessionSignatureCache.keys().next().value;
      if (first) sessionSignatureCache.delete(first);
    }
    saveCacheToDisk();
  }
}

export function getSessionSignature(sessionId: string): string | undefined {
  return sessionSignatureCache.get(sessionId)?.signature;
}

export function clearSessionCache(sessionId: string) {
  // Clear thought signatures starting with "${sessionId}:"
  const prefix = `${sessionId}:`;
  for (const key of signatureCache.keys()) {
    if (key.startsWith(prefix)) {
      signatureCache.delete(key);
    }
  }
  sessionSignatureCache.delete(sessionId);
  sessionReasoningCache.delete(sessionId);
  saveCacheToDisk();
  console.log(`[Cache] Cleared conversation signature and reasoning cache for session: ${sessionId}`);
}

export function checkSessionSignatureRewind(sessionId: string, currentMessageCount: number): boolean {
  const cached = sessionSignatureCache.get(sessionId);
  if (!cached) return false;

  if (currentMessageCount < cached.messageCount) {
    console.log(
      `[Cache] Rewind detected for session ${sessionId}: current ${currentMessageCount} < cached ${cached.messageCount}. Invalidating session cache.`
    );
    clearSessionCache(sessionId);
    return true;
  }
  return false;
}

// ─── Layer 4: Session Reasoning Cache per turn ──────────────────────────────

export function cacheSessionReasoning(sessionId: string, reasoning: string, turnIndex: number) {
  if (!reasoning || reasoning.trim().length === 0) return;

  const list = sessionReasoningCache.get(sessionId) || [];
  if (turnIndex >= list.length) {
    while (list.length <= turnIndex) {
      list.push("");
    }
  }

  // Only update if the new reasoning is longer to prevent overwriting with partial content
  if (reasoning.length > list[turnIndex].length) {
    list[turnIndex] = reasoning;
    sessionReasoningCache.set(sessionId, list);
    saveCacheToDisk();
  }
}

export function getSessionReasoning(sessionId: string, turnIndex: number): string | undefined {
  const list = sessionReasoningCache.get(sessionId);
  if (list && turnIndex < list.length) {
    const text = list[turnIndex];
    if (text && text.trim().length > 0) {
      return text;
    }
  }
  return undefined;
}


