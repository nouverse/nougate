import { join } from "path";
import { existsSync, mkdirSync } from "fs";

// Map<conversation_id + thought_text_hash, signature>
const signatureCache = new Map<string, string>();

// Map<tool_call_id, signature>
const signatureByCallIdCache = new Map<string, string>();

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
      callSignatures: Array.from(signatureByCallIdCache.entries())
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
    console.log(`[Cache] Loaded ${signatureCache.size} signatures and ${signatureByCallIdCache.size} call signatures from disk.`);
  }
} catch (e) {
  console.warn("[Cache] Failed to load signatures from disk:", e);
}

export function cacheSignature(conversationId: string, thought: string, signature: string) {
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

