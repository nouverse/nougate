/**
 * A custom provider whose service asks which conversation a request is for, in a header of its own.
 *
 * OpenCode Go answers 400 `MissingSessionID` to a request without `x-opencode-session`, and asks its clients to say
 * who they are with a user agent of their own. A custom provider sent its extra headers as stored and nothing else,
 * so one on a Go subscription refused every request. A header's value now says where the conversation's id goes
 * (`{session}`), the request's own id is written there, and the gateway names itself. Nothing reads which service it
 * is: the provider's headers say what it needs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The database path is read when @/core/db is first imported, so it must be set before anything pulls it in.
const tempDir = mkdtempSync(join(tmpdir(), "nougate-session-"));
process.env.NOUGATE_DB_PATH = join(tempDir, "test.db");

const { initDb, closeDb } = await import("@/core/db");
const { loadProxyConfig } = await import("@/config/manager");
const store = await import("@/providers/custom/store");
const { SESSION_PLACEHOLDER } = store;
const { buildHeaders } = await import("@/providers/custom/executor");
const { syncProviderModels } = await import("@/providers/custom/model-sync");
const { handleCustomProvidersRoute } = await import("@/router/custom-providers");
const { CustomProvider } = await import("@/providers/custom");
const { NOUGATE_VERSION } = await import("@/core/version");

const realFetch = globalThis.fetch;
const HEX = /^[0-9a-f]{32}$/;

beforeAll(async () => {
  await loadProxyConfig();
  await initDb();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await closeDb();
  rmSync(tempDir, { recursive: true, force: true });
});

const record = (extraHeaders: Record<string, string>, apiStyle: "openai" | "anthropic" = "openai") =>
  ({ id: "go", displayName: "Go", baseUrl: "https://go.test/v1", apiStyle, enabled: true, extraHeaders, jitter: { jitterEnabled: false, jitterMinMs: 0, jitterMaxMs: 0 }, createdAt: 0, updatedAt: 0 }) as Parameters<typeof buildHeaders>[0];

describe("a custom provider's headers", () => {
  test("the conversation's id goes where an extra header's value asks for it, on either style", () => {
    expect(SESSION_PLACEHOLDER).toBe("{session}");
    expect(buildHeaders(record({ "x-opencode-session": "{session}" }), "sk", "abc123")).toMatchObject({ "x-opencode-session": "abc123", Authorization: "Bearer sk" });
    expect(buildHeaders(record({ "x-opencode-session": "{session}" }, "anthropic"), "sk", "abc123")).toMatchObject({ "x-opencode-session": "abc123", "x-api-key": "sk", "anthropic-version": "2023-06-01" });
    // Inside a longer value, and in every header that asks: the same id, so two that ask agree.
    expect(buildHeaders(record({ "x-session": "nougate-{session}", "x-trace": "{session}/{session}" }), "sk", "abc123")).toMatchObject({ "x-session": "nougate-abc123", "x-trace": "abc123/abc123" });
  });

  test("a call that belongs to no conversation carries an id of its own, never the bare placeholder or nothing", () => {
    const first = buildHeaders(record({ "x-opencode-session": "{session}" }), "sk");
    const second = buildHeaders(record({ "x-opencode-session": "{session}" }), "sk", "");
    expect(first["x-opencode-session"]).toMatch(HEX);
    expect(second["x-opencode-session"]).toMatch(HEX);
    expect(first["x-opencode-session"]).not.toBe(second["x-opencode-session"]);
  });

  test("a header that asks for nothing is sent as stored, and a provider with none gets none added but who is asking", () => {
    expect(buildHeaders(record({ "HTTP-Referer": "https://example.test", "x-title": "{not-session}" }), "sk", "abc123")).toEqual({
      "Content-Type": "application/json",
      "User-Agent": `nougate/${NOUGATE_VERSION}`,
      "HTTP-Referer": "https://example.test",
      "x-title": "{not-session}",
      Authorization: "Bearer sk",
    });
    expect(buildHeaders(record({}), "sk", "abc123")).toEqual({ "Content-Type": "application/json", "User-Agent": `nougate/${NOUGATE_VERSION}`, Authorization: "Bearer sk" });
  });

  test("the gateway says who it is; an extra header named user-agent, in any case, is the operator's and the only one sent", () => {
    expect(NOUGATE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    const own = buildHeaders(record({ "user-agent": "mine/1" }), "sk");
    expect(Object.keys(own).filter((name) => name.toLowerCase() === "user-agent")).toEqual(["user-agent"]);
    expect(own["user-agent"]).toBe("mine/1");
  });
});

describe("a custom provider created with a session header", () => {
  /** Every request the upstream was sent: where, and with which headers. */
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const upstream = (answer: () => Response) => {
    asked.length = 0;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      asked.push({ url: String(url), headers: init.headers as Record<string, string> });
      return answer();
    }) as unknown as typeof fetch;
  };

  test("keeps the header as it was given, and a request through it carries its own conversation's id upstream", async () => {
    await store.createCustomProvider({ id: "opencode-go", baseUrl: "https://go.test/inference/go/openai/v1", extraHeaders: { "x-opencode-session": "{session}" } });
    await store.addProviderKey("opencode-go", "sk-go-test", "primary");
    await store.upsertProviderModels("opencode-go", [{ modelId: "glm-5.3" }]);
    expect((await store.getCustomProvider("opencode-go"))?.extraHeaders).toEqual({ "x-opencode-session": "{session}" });

    const provider = new CustomProvider((await store.getCustomProvider("opencode-go"))!);
    await provider.init();
    const modelSpec = provider.getModelRegistry().getSpec("glm-5.3")!;
    const ask = async (sessionId: string) => {
      upstream(() => Response.json({ id: "c", object: "chat.completion", model: "glm-5.3", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      const response = await provider.execute({
        protocol: "openai",
        body: { model: "opencode-go:glm-5.3", messages: [{ role: "user", content: "hi" }] },
        modelSpec,
        resolvedModel: { providerId: "opencode-go", modelId: "glm-5.3" } as never,
        ctx: { sessionId, clientId: "nouride/nouva" } as never,
      });
      expect(response.status).toBe(200);
      return asked[0]!;
    };

    const first = await ask("conversation-one");
    expect(first.url).toBe("https://go.test/inference/go/openai/v1/chat/completions");
    expect(first.headers).toMatchObject({ "x-opencode-session": "conversation-one", Authorization: "Bearer sk-go-test", "User-Agent": `nougate/${NOUGATE_VERSION}` });
    // Another conversation, another id; the same one again, the same id.
    expect((await ask("conversation-two")).headers["x-opencode-session"]).toBe("conversation-two");
    expect((await ask("conversation-one")).headers["x-opencode-session"]).toBe("conversation-one");
  });

  test("its model list is asked with an id too: the listing is a request like any other to a service that refuses one without", async () => {
    upstream(() => Response.json({ data: [{ id: "glm-5.3" }, { id: "kimi-k3" }] }));
    await syncProviderModels((await store.getCustomProvider("opencode-go"))!);
    expect(asked[0]!.url).toBe("https://go.test/inference/go/openai/v1/models");
    expect(asked[0]!.headers["x-opencode-session"]).toMatch(HEX);
    expect(await store.deleteCustomProvider("opencode-go")).toBe(true);
  });
});

describe("a custom provider's extra headers, as its form sends them", () => {
  const api = async (method: string, path: string, body?: unknown) => {
    const url = new URL(`http://gateway.test/api/custom-providers${path}`);
    const response = (await handleCustomProvidersRoute(new Request(url, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url))!;
    return { status: response.status, body: (await response.json()) as any };
  };

  test("a saved value is never told to the page, but the one that is no secret: {session}", async () => {
    const created = await api("POST", "", { id: "hdr-view", baseUrl: "https://x.test/v1", extraHeaders: { "x-opencode-session": "{session}", "x-gateway-key": "gw-live-secret-value", "x-trace": "nougate-{session}" } });
    expect(created.status).toBe(201);
    // A value that only holds the placeholder among other text could hold a key beside it: not told either.
    const shown = { "x-opencode-session": "{session}", "x-gateway-key": null, "x-trace": null };
    expect(created.body.provider.extraHeaders).toEqual(shown);
    expect((await api("GET", "/hdr-view")).body.extraHeaders).toEqual(shown);
    const listed = (await api("GET", "")).body.find((provider: any) => provider.id === "hdr-view");
    expect(listed.extraHeaders).toEqual(shown);
    expect(JSON.stringify([created.body, listed])).not.toContain("gw-live-secret-value");
    // What is kept is the value itself: the request carries it.
    expect((await store.getCustomProvider("hdr-view"))?.extraHeaders["x-gateway-key"]).toBe("gw-live-secret-value");
  });

  test("a save is the whole set: a name with no value keeps the saved one, in whatever case; a name no longer sent is removed; none sent leaves them", async () => {
    const saved = await api("POST", "/hdr-view", { extraHeaders: { "X-Gateway-Key": null, "x-new": "1" } });
    expect(saved.status).toBe(200);
    expect((await store.getCustomProvider("hdr-view"))?.extraHeaders).toEqual({ "X-Gateway-Key": "gw-live-secret-value", "x-new": "1" });
    // An empty value is the same as none: the form's line for a saved header has nothing after its colon.
    await api("POST", "/hdr-view", { extraHeaders: { "X-Gateway-Key": "  ", "x-new": "1" } });
    expect((await store.getCustomProvider("hdr-view"))?.extraHeaders["X-Gateway-Key"]).toBe("gw-live-secret-value");
    // What is around a name or a value is not part of it.
    expect((await api("POST", "/hdr-view", { extraHeaders: { "X-Gateway-Key": null, " x-new ": "  2  " } })).status).toBe(200);
    expect((await store.getCustomProvider("hdr-view"))?.extraHeaders).toEqual({ "X-Gateway-Key": "gw-live-secret-value", "x-new": "2" });
    // A save of another field, with no headers in it: as they were.
    await api("POST", "/hdr-view", { displayName: "Renamed" });
    expect((await store.getCustomProvider("hdr-view"))?.extraHeaders).toEqual({ "X-Gateway-Key": "gw-live-secret-value", "x-new": "2" });
    // An empty set is a set: none any more.
    await api("POST", "/hdr-view", { extraHeaders: {} });
    expect((await store.getCustomProvider("hdr-view"))?.extraHeaders).toEqual({});
  });

  test("refused with the reason, and nothing changed: a name that is not a header's, the request's own, one given twice, one with no value, a value no header carries, too many, not a set", async () => {
    await api("POST", "/hdr-view", { extraHeaders: { "x-kept": "1" } });
    const refused = async (extraHeaders: unknown) => {
      const answer = await api("POST", "/hdr-view", { extraHeaders });
      expect(answer.status).toBe(400);
      expect((await store.getCustomProvider("hdr-view"))?.extraHeaders).toEqual({ "x-kept": "1" });
      return answer.body.error as string;
    };
    expect(await refused({ "x session": "1" })).toBe('"x session" is not a header\'s name.');
    // A key typed as a header would be kept and shown as text: a key is added as a key.
    for (const own of ["Authorization", "x-api-key", "Content-Type"]) {
      expect(await refused({ [own]: "v" })).toBe(`${own} is a header the request sends itself. Add the key as an API key.`);
    }
    expect(await refused({ "x-team": "ops", "X-Team": "dev" })).toBe("Header X-Team is there twice.");
    expect(await refused({ "x-new": null })).toBe("Header x-new needs a value.");
    expect(await refused({ "x-new": 7 })).toBe("Header x-new needs a value.");
    expect(await refused({ "x-new": "a\nx-injected: 1" })).toBe("Header x-new has a value a header cannot carry.");
    expect(await refused({ "x-new": "v".repeat(1025) })).toBe("Header x-new has a value a header cannot carry.");
    expect(await refused(Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`x-h${index}`, "v"])))).toBe("A provider takes at most 16 extra headers.");
    for (const notASet of ["x-a: 1", ["x-a"], 3, null]) expect(await refused(notASet)).toBe("Extra headers must be a set of names with their values.");
    // At the limits, taken; and a provider may still pin the Anthropic version it speaks.
    expect((await api("POST", "/hdr-view", { extraHeaders: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`x-h${index}`, "v".repeat(1024)])) })).status).toBe(200);
    expect((await api("POST", "/hdr-view", { extraHeaders: { "anthropic-version": "2023-06-01" } })).status).toBe(200);
  });

  test("a provider is not created with headers that would be refused on a save", async () => {
    const answer = await api("POST", "", { id: "hdr-bad", baseUrl: "https://x.test/v1", extraHeaders: { Authorization: "Bearer other" } });
    expect(answer.status).toBe(400);
    expect(await store.getCustomProvider("hdr-bad")).toBeNull();
    expect(await store.deleteCustomProvider("hdr-view")).toBe(true);
  });
});
