import { describe, expect, test, beforeAll } from "bun:test";
import { mapOpenAIToGoogle } from "@/providers/antigravity/mappers/openai-in";
import { antigravityModelRegistry } from "@/providers/antigravity/config/model-specs";
import { claudeCodeModelRegistry } from "@/providers/claudecode/config/model-specs";
import { mapOpenAIToAnthropic } from "@/core/mappers/openai-to-anthropic";
import { mapOpenAIToResponses } from "@/providers/codex/mappers/openai-to-responses";
import { UnsupportedContentPartError } from "@/core/upstream-errors";
import { loadProxyConfig } from "@/config/manager";
import type { IModelRegistry, IModelSpec, IProvider } from "@/core/interfaces";
import type { JitterConfig } from "@/core/jitter";
import { resolveModel } from "@/core/model-resolver";
import { OpenAIProtocolHandler } from "@/protocols/openai/handler";
import { AnthropicProtocolHandler } from "@/protocols/anthropic/handler";
import { registerProvider, unregisterProvider } from "@/core/registry";

/**
 * Native audio input (RFC native audio voice notes, §6): Antigravity carries `input_audio` to
 * Gemini, every mapper that cannot carry it refuses by name instead of dropping it, and `/models`
 * says which routes can hear.
 */

const NO_JITTER: JitterConfig = { jitterEnabled: false, jitterMinMs: 0, jitterMaxMs: 0 };

beforeAll(async () => {
  await loadProxyConfig();
});

function buildModelSpec(overrides: Partial<IModelSpec>): IModelSpec {
  return {
    modelId: "fixture-model",
    pool: "sandbox",
    isThinking: false,
    maxOutputTokens: 4096,
    ...overrides,
  };
}

function audioBody(format: unknown, data: unknown = "QUJD") {
  return {
    model: "fixture",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What does this say?" },
          { type: "input_audio", input_audio: { data, format } },
        ],
      },
    ],
  };
}

/** Run `fn` and return what it threw, so the refusal itself can be inspected. */
function thrownBy(fn: () => unknown): any {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

function makeProvider(id: string, registry: IModelRegistry, execute?: IProvider["execute"]): IProvider {
  return {
    id,
    displayName: id,
    init: async () => {},
    getJitterConfig: () => NO_JITTER,
    getBestAccount: async () => null,
    updateAccountUsage: async () => {},
    getAccounts: () => [],
    getModelRegistry: () => registry,
    getSupportedModels: () => registry.listModelIds(),
    execute: execute ?? (async () => new Response("Mock")),
  };
}

describe("Antigravity carries input_audio to Gemini", () => {
  const gemini = buildModelSpec({ modelId: "gemini-3.8-flash-medium" });

  for (const [format, mimeType] of [
    ["mp3", "audio/mpeg"],
    ["wav", "audio/wav"],
    ["ogg", "audio/ogg"],
  ] as const) {
    test(`${format} becomes inlineData ${mimeType}`, () => {
      const result = mapOpenAIToGoogle(audioBody(format), gemini, "session-audio");
      const parts = result.request.contents[0].parts;

      expect(parts).toHaveLength(2);
      expect(parts[0].text).toBe("What does this say?");
      expect(parts[1]).toEqual({ inlineData: { mimeType, data: "QUJD" } });
    });
  }

  test("an unknown format is refused rather than guessed", () => {
    const error = thrownBy(() => mapOpenAIToGoogle(audioBody("flac"), gemini, "session-audio"));

    expect(error).toBeInstanceOf(UnsupportedContentPartError);
    expect(error.status).toBe(400);
    expect(error.clientCode).toBe("unsupported_content_part");
    expect(error.message).toContain("flac");
    expect(error.message).toContain("antigravity");
  });

  test("audio with no data is refused too", () => {
    const error = thrownBy(() => mapOpenAIToGoogle(audioBody("mp3", null), gemini, "session-audio"));
    expect(error).toBeInstanceOf(UnsupportedContentPartError);
  });

  test("a Claude model behind Antigravity refuses audio instead of forwarding it", () => {
    // Same Gemini-shaped request, but Google hands it to Claude, which has no audio block.
    const claude = buildModelSpec({ modelId: "claude-sonnet-4-6" });
    const error = thrownBy(() => mapOpenAIToGoogle(audioBody("mp3"), claude, "session-audio"));

    expect(error).toBeInstanceOf(UnsupportedContentPartError);
    expect(error.message).toBe("input_audio is not supported by the antigravity provider");
  });
});

describe("Mappers that cannot carry input_audio refuse it by name", () => {
  test("OpenAI → Anthropic names the provider it was called for", () => {
    const error = thrownBy(() =>
      mapOpenAIToAnthropic(audioBody("mp3"), "claude-sonnet-4-6", 4096, "claudecode"),
    );

    expect(error).toBeInstanceOf(UnsupportedContentPartError);
    expect(error.status).toBe(400);
    expect(error.clientCode).toBe("unsupported_content_part");
    expect(error.message).toBe("input_audio is not supported by the claudecode provider");
  });

  test("OpenAI → Responses (Codex)", () => {
    const error = thrownBy(() => mapOpenAIToResponses(audioBody("mp3"), "gpt-5"));

    expect(error).toBeInstanceOf(UnsupportedContentPartError);
    expect(error.message).toBe("input_audio is not supported by the codex provider");
  });

  test("other unknown part types keep being skipped", () => {
    const body = {
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "mystery" }] }],
    };

    // Matched rather than equal: the newest message also carries a cache breakpoint, which is not this test's business.
    expect(mapOpenAIToAnthropic(body, "claude", 4096, "claudecode").messages[0].content).toMatchObject([
      { type: "text", text: "hi" },
    ]);
    expect(mapOpenAIToResponses(body, "gpt-5").input[0].content).toEqual([
      { type: "input_text", text: "hi" },
    ]);
  });

  test("the refusal reaches an OpenAI client as a 400 in OpenAI's error shape", async () => {
    const registry: IModelRegistry = {
      getSpec: (modelId) => buildModelSpec({ modelId }),
      listModelIds: () => ["claude-sonnet-4-6"],
    };
    registerProvider(
      makeProvider("claudecode", registry, async ({ body }) => {
        mapOpenAIToAnthropic(body, "claude-sonnet-4-6", 4096, "claudecode");
        return new Response("unreachable");
      }),
    );

    try {
      const req = new Request("http://localhost:3000/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...audioBody("mp3"), model: "claudecode:claude-sonnet-4-6" }),
      });

      const response = await new OpenAIProtocolHandler().handle({
        req,
        url: new URL(req.url),
        protocol: "openai",
        resolvedModel: resolveModel("claudecode:claude-sonnet-4-6"),
        provider: makeProvider("claudecode", registry),
        sessionId: "session-audio",
        clientId: "client-audio",
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          type: "invalid_request_error",
          code: "unsupported_content_part",
          message: "input_audio is not supported by the claudecode provider",
        },
      });
    } finally {
      unregisterProvider("claudecode");
    }
  });
});

describe("/models declares what each route can deliver", () => {
  async function listModels(handler: OpenAIProtocolHandler | AnthropicProtocolHandler, path: string) {
    const req = new Request(`http://localhost:3000${path}`, { method: "GET" });
    const response = await handler.handle({
      req,
      url: new URL(req.url),
      protocol: handler.protocol,
      resolvedModel: resolveModel(""),
      provider: makeProvider("antigravity", antigravityModelRegistry),
      sessionId: "session-models",
      clientId: "client-models",
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    return new Map<string, any>(body.data.map((entry: any) => [entry.id, entry]));
  }

  for (const [label, handler, path] of [
    ["OpenAI", new OpenAIProtocolHandler(), "/openai/v1/models"],
    ["Anthropic", new AnthropicProtocolHandler(), "/anthropic/v1/models"],
  ] as const) {
    test(`${label}: Gemini via Antigravity hears; Claude via Antigravity and Claude Code do not`, async () => {
      registerProvider(makeProvider("antigravity", antigravityModelRegistry));
      registerProvider(makeProvider("claudecode", claudeCodeModelRegistry));

      try {
        const models = await listModels(handler, path);

        const gemini = models.get("antigravity:gemini-3.8-flash-medium");
        expect(gemini.input_modalities).toEqual(["text", "image", "audio"]);
        expect(gemini.input_audio_formats).toEqual(["mp3", "wav", "ogg"]);

        const claudeViaAntigravity = models.get("antigravity:claude-sonnet-4-6");
        expect(claudeViaAntigravity.input_modalities).not.toContain("audio");
        expect(claudeViaAntigravity).not.toHaveProperty("input_audio_formats");

        const claudeCodeId = claudeCodeModelRegistry.listModelIds()[0]!;
        const claudeCode = models.get(`claudecode:${claudeCodeId}`);
        expect(claudeCode).toBeDefined();
        expect(claudeCode.input_modalities ?? []).not.toContain("audio");
        expect(claudeCode).not.toHaveProperty("input_audio_formats");
      } finally {
        unregisterProvider("antigravity");
        unregisterProvider("claudecode");
      }
    });
  }
});
