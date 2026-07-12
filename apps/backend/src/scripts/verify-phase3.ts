import { antigravityModelRegistry } from "@/providers/antigravity/config/model-specs";

async function runVerification() {
  console.log("🧪 Running Phase 3.5 Automated Verification Tests...\n");

  let passes = 0;
  let fails = 0;

  function report(name: string, passed: boolean, extra = "") {
    if (passed) {
      console.log(`✅ PASS: ${name} ${extra}`);
      passes++;
    } else {
      console.error(`❌ FAIL: ${name} ${extra}`);
      fails++;
    }
  }

  // Helper for requests
  async function makePost(url: string, headers: any, body: any) {
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    } catch (e: any) {
      return { ok: false, status: 500, statusText: e.message } as any;
    }
  }

  // Test 1: Route antigravity:gemini-3.5-flash-low -> 200
  const t1 = await makePost(
    "http://127.0.0.1:3000/openai/v1/chat/completions",
    { "Authorization": "Bearer sk-antigravity" },
    {
      model: "antigravity:gemini-3.5-flash-low",
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
    }
  );
  if (t1.ok) {
    const json = await t1.json();
    report("Test 1 - OpenAI Route antigravity:gemini-3.5-flash-low", true, `(Response: "${json.choices?.[0]?.message?.content?.substring(0, 30)}...")`);
  } else {
    const text = await t1.text().catch(() => t1.statusText);
    report("Test 1 - OpenAI Route antigravity:gemini-3.5-flash-low", false, `(Status: ${t1.status}, Error: ${text})`);
  }

  // Test 2: Test antigravity:claude-opus-4-6 via /openai/v1/chat/completions -> works
  const t2 = await makePost(
    "http://127.0.0.1:3000/openai/v1/chat/completions",
    { "Authorization": "Bearer sk-antigravity" },
    {
      model: "antigravity:claude-opus-4-6",
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
    }
  );
  if (t2.ok) {
    const json = await t2.json();
    report("Test 2 - OpenAI Route antigravity:claude-opus-4-6", true, `(Response: "${json.choices?.[0]?.message?.content?.substring(0, 30)}...")`);
  } else if (t2.status === 429) {
    const json = await t2.json();
    const isQuota = json.error?.code === "insufficient_quota";
    report("Test 2 - OpenAI Route antigravity:claude-opus-4-6", isQuota, `(Quota Exhausted, Routed OK)`);
  } else {
    const text = await t2.text().catch(() => t2.statusText);
    report("Test 2 - OpenAI Route antigravity:claude-opus-4-6", false, `(Status: ${t2.status}, Error: ${text})`);
  }

  // Test 3: Test antigravity:claude-opus-4-6 via /anthropic/v1/messages -> works
  const t3 = await makePost(
    "http://127.0.0.1:3000/anthropic/v1/messages",
    { "x-api-key": "sk-antigravity" },
    {
      model: "antigravity:claude-opus-4-6",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1024,
      stream: false,
    }
  );
  if (t3.ok) {
    const json = await t3.json();
    report("Test 3 - Anthropic Route antigravity:claude-opus-4-6", true, `(Response: "${json.content?.[0]?.text?.substring(0, 30)}...")`);
  } else if (t3.status === 429) {
    const json = await t3.json();
    const isQuota = json.error?.code === "insufficient_quota";
    report("Test 3 - Anthropic Route antigravity:claude-opus-4-6", isQuota, `(Quota Exhausted, Routed OK)`);
  } else {
    const text = await t3.text().catch(() => t3.statusText);
    report("Test 3 - Anthropic Route antigravity:claude-opus-4-6", false, `(Status: ${t3.status}, Error: ${text})`);
  }

  // Test 4: Test GET /openai/v1/models -> return prefixed IDs, legacy_id, provider, sorted
  try {
    const t4 = await fetch("http://127.0.0.1:3000/openai/v1/models");
    if (t4.ok) {
      const json = await t4.json();
      const models = json.data || [];
      const hasPrefix = models.every((m: any) => m.id.startsWith("antigravity:"));
      const hasLegacyId = models.every((m: any) => m.legacy_id && m.legacy_id.startsWith("antigravity-"));
      const hasProvider = models.every((m: any) => m.provider === "antigravity");
      const isSorted = [...models].sort((a, b) => a.id.localeCompare(b.id)).every((m, i) => m.id === models[i].id);

      const pass = hasPrefix && hasLegacyId && hasProvider && isSorted;
      report("Test 4 - GET /openai/v1/models enhancements", pass, `(Count: ${models.length}, Sorted: ${isSorted}, LegacyIDs: ${hasLegacyId})`);
    } else {
      report("Test 4 - GET /openai/v1/models enhancements", false, `(Status: ${t4.status})`);
    }
  } catch (e: any) {
    report("Test 4 - GET /openai/v1/models enhancements", false, `(Error: ${e.message})`);
  }

  // Test 5: Request without provider prefix -> 400
  const t5 = await makePost(
    "http://127.0.0.1:3000/openai/v1/chat/completions",
    { "Authorization": "Bearer sk-antigravity" },
    {
      model: "gemini-3.5-flash-low",
      messages: [{ role: "user", content: "Hi" }],
      stream: false,
    }
  );
  if (t5.status === 400) {
    const json = await t5.json();
    const isPrefixRequiredCode = json.error?.code === "model_prefix_required";
    report("Test 5 - Reject model without provider prefix", isPrefixRequiredCode, `(Error Code: ${json.error?.code})`);
  } else {
    report("Test 5 - Reject model without provider prefix", false, `(Expected 400, got: ${t5.status})`);
  }

  console.log(`\n🏁 Summary: ${passes} passed, ${fails} failed.`);
  process.exit(fails > 0 ? 1 : 0);
}

runVerification();
