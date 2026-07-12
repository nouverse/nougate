import { TextDecoder } from "util";

function parseArgs() {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--')) {
      const parts = arg.slice(2).split('=');
      const key = parts[0];
      const val = parts[1] !== undefined ? parts[1] : true;
      args[key] = val;
    }
  }
  return args;
}

async function main() {
  const argv = parseArgs();
  const model = (argv.model as string) || "antigravity:gemini-2.5-flash";
  const prompt = (argv.prompt as string) || "Explain quantum entanglement in one sentence.";
  const stream = argv.stream === 'true' || argv.stream === true; // default to false

  console.log(`📡 Protocol: Anthropic-compatible`);
  console.log(`🤖 Model   : ${model}`);
  console.log(`💬 Prompt  : "${prompt}"`);
  console.log(`📡 Stream  : ${stream}`);
  console.log("------------------------------------------");

  const response = await fetch("http://127.0.0.1:3000/anthropic/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "sk-antigravity"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096,
      stream
    })
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`\n❌ Error ${response.status}: ${text}`);
    process.exit(1);
  }

  if (stream) {
    const body = response.body;
    if (!body) {
      console.error("\n❌ Response body is not readable.");
      process.exit(1);
    }

    const decoder = new TextDecoder();
    let buffer = "";

    if (typeof body.getReader === 'function') {
      const reader = body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        handleChunk(decoder.decode(value, { stream: true }));
      }
    } else {
      for await (const chunk of body as any) {
        handleChunk(decoder.decode(chunk, { stream: true }));
      }
    }

    function handleChunk(chunkText: string) {
      buffer += chunkText;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const cleanLine = line.trim();
        if (!cleanLine) continue;

        if (cleanLine.startsWith("data: ")) {
          try {
            const data = JSON.parse(cleanLine.slice(6));
            if (data.type === "content_block_delta") {
              const delta = data.delta;
              if (delta?.type === "text_delta" && delta?.text) {
                process.stdout.write(delta.text);
              }
              if (delta?.type === "thinking_delta" && delta?.thinking) {
                process.stdout.write(delta.thinking);
              }
            }
          } catch (e) {
            // Ignore parse errors on incomplete chunks
          }
        }
      }
    }
    
    if (buffer) {
      handleChunk("");
    }
    console.log("\n");
  } else {
    const data = await response.json() as any;
    
    // Check if there is a thinking/reasoning content block
    const thinkingBlock = data.content?.find((c: any) => c.type === "thinking");
    const textBlock = data.content?.find((c: any) => c.type === "text");

    if (thinkingBlock?.thinking) {
      console.log(`🤔 Thinking:\n${thinkingBlock.thinking}\n`);
    }
    if (textBlock?.text) {
      console.log(`✨ Response:\n${textBlock.text}`);
    } else if (data.content?.[0]?.text) {
      console.log(`✨ Response:\n${data.content[0].text}`);
    } else {
      console.log("✨ Response:", JSON.stringify(data, null, 2));
    }
  }
}

main().catch(console.error);
