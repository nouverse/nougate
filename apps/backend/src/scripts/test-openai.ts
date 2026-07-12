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

  console.log(`📡 Protocol: OpenAI-compatible`);
  console.log(`🤖 Model   : ${model}`);
  console.log(`💬 Prompt  : "${prompt}"`);
  console.log(`📡 Stream  : ${stream}`);
  console.log("------------------------------------------");

  const response = await fetch("http://127.0.0.1:3000/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer sk-antigravity"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
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
        if (!cleanLine || cleanLine === "data: [DONE]") continue;

        if (cleanLine.startsWith("data: ")) {
          try {
            const data = JSON.parse(cleanLine.slice(6));
            const delta = data.choices?.[0]?.delta;
            if (delta?.content) {
              process.stdout.write(delta.content);
            }
            if (delta?.reasoning_content) {
              process.stdout.write(delta.reasoning_content);
            }
          } catch (e) {
            // Ignore incomplete chunk errors
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
    const content = data.choices?.[0]?.message?.content;
    const reasoning = data.choices?.[0]?.message?.reasoning_content;
    
    if (reasoning) {
      console.log(`🤔 Thinking:\n${reasoning}\n`);
    }
    console.log(`✨ Response:\n${content}`);
  }
}

main().catch(console.error);
