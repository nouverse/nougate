import { join } from "path";

async function performRequest(label: string, body: any) {
  console.log(`\n--- ${label} ---`);
  console.log("🚀 Sending request...");
  
  try {
    const response = await fetch("http://127.0.0.1:3000/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "sk-antigravity"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        console.error(`❌ Error: ${response.status} - ${text}`);
        return { ok: false, status: response.status, text };
    }

    if (body.stream === false) {
      const data = await response.json() as any;
      console.log("✅ Success response:", JSON.stringify(data, null, 2));
      return { ok: true, data };
    }

    console.log("✅ Connected! receiving stream:\n");
    
    const reader = response.body?.getReader();
    if (!reader) return { ok: false };
    
    const decoder = new TextDecoder();
    let fullContent = "";
    let reasoningContent = "";
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value);
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        
        for (const line of lines) {
            if (line.startsWith("data: ")) {
                try {
                    const json = JSON.parse(line.slice(6));
                    if (json.type === "content_block_delta") {
                        const delta = json.delta;
                        if (delta?.type === "text_delta" && delta?.text) {
                            process.stdout.write(delta.text);
                            fullContent += delta.text;
                        }
                        if (delta?.type === "thinking_delta" && delta?.thinking) {
                            reasoningContent += delta.thinking;
                        }
                    }
                } catch (e) {}
            }
        }
    }
    console.log("\n\n✨ Done.");
    return { ok: true, fullContent, reasoningContent };
    
  } catch (e) {
      console.error("❌ Failed to connect.", e);
      return { ok: false, error: e };
  }
}

async function runTests() {
  console.log("🧪 STARTING ANTHROPIC PROTOCOL INTEGRATION TESTS");

  const basicResult = await performRequest("BASIC TEXT NON-STREAMING TEST", {
    model: "antigravity:gemini-3.5-flash-low",
    messages: [{ role: "user", content: "say pong" }],
    max_tokens: 1024,
    stream: false
  });

  if (basicResult.ok && basicResult.data?.content?.[0]?.text?.toLowerCase().includes("pong")) {
    console.log("✅ PASS: Non-streaming greeting succeeded.");
  } else {
    console.error("❌ FAIL: Non-streaming greeting failed.");
  }

  const streamResult = await performRequest("STREAMING TEXT TEST", {
    model: "antigravity:gemini-3.5-flash-low",
    messages: [{ role: "user", content: "Explain gravity in one sentence." }],
    max_tokens: 1024,
    stream: true
  });

  if (streamResult.ok && streamResult.fullContent) {
    console.log("✅ PASS: Streaming text request succeeded.");
  } else {
    console.error("❌ FAIL: Streaming text request failed.");
  }

  console.log("\n🏁 ALL TESTS COMPLETED");
}

runTests();
