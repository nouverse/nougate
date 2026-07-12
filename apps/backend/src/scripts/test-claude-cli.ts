import { getGeminiCliHeaders } from "@/providers/antigravity/upstream/headers";
import { getModelSpec } from "@/providers/antigravity/config/model-specs";
import { mapOpenAIToGoogle } from "@/protocols/openai";
import { getAccounts, initManager } from "@/providers/antigravity/auth/manager";

/**
 * Read a model spec for the manual test script.
 */
function requireModelSpec(modelId: string) {
    const modelSpec = getModelSpec(modelId);
    if (!modelSpec) {
        throw new Error(`Unknown model spec: ${modelId}`);
    }
    return modelSpec;
}

// Manual test to see if Claude works on CLI endpoint
// Usage: bun run src/scripts/test-claude-cli.ts <email>

await initManager();

const email = process.argv[2];
if (!email) {
    console.error("Usage: bun run src/scripts/test-claude-cli.ts <email>");
    process.exit(1);
}

const accounts = getAccounts();
const account = accounts.find(a => a.email === email);

if (!account) {
    console.error(`Account ${email} not found in providers/antigravity/accounts.json`);
    process.exit(1);
}

console.log(`Testing Claude on CLI endpoint with account: ${account.email}`);

const openaiBody = {
    model: "antigravity:claude-opus-4-6-thinking",
    messages: [
        { role: "user", content: "Hello, explain quantum physics in one sentence." }
    ],
    temperature: 0.7,
    max_tokens: 100
};

// Transform for CLI
const googleBody = mapOpenAIToGoogle(
    openaiBody,
    requireModelSpec("claude-opus-4-6-thinking"),
    "claude-cli-session",
    { projectId: account.projectId || "rising-fact-p41fc" },
);
console.log("Transformed Body:", JSON.stringify(googleBody, null, 2));

const GOOGLE_URL = `https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse`;

const headers = getGeminiCliHeaders(account.accessToken!);

try {
    const res = await fetch(GOOGLE_URL, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(googleBody)
    });

    console.log(`Status: ${res.status}`);
    const text = await res.text();
    console.log("Response:", text.substring(0, 500) + "...");
} catch (e) {
    console.error("Error:", e);
}
