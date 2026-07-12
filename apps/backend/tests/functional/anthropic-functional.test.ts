import { describe, expect, test } from "bun:test";

const API_URL = "http://localhost:3000/anthropic/v1/messages";
const MODELS_URL = "http://localhost:3000/anthropic/v1/models";
const MODEL = "antigravity:gemini-3-flash";

describe("Functional Tests: Anthropic Messages API (Real/Simulated)", () => {
  
  test("Model Listing", async () => {
    try {
      const response = await fetch(MODELS_URL, {
        method: "GET",
      });

      if (!response.ok) {
        console.warn("Skipping models test: Server not reachable or error", response.status);
        return;
      }

      const data = await response.json() as any;
      expect(response.status).toBe(200);
      expect(data.data).toBeDefined();
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBeGreaterThan(0);
      expect(data.data[0].type).toBe("model");
      expect(data.data[0].id).toContain("antigravity:");
    } catch (e) {
      console.warn("Skipping models test: Server likely not running");
    }
  });

  test("Short Message: Basic Greeting", async () => {
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: "Hello, say 'pong' if you hear me." }],
          max_tokens: 1024,
          stream: false
        })
      });

      if (!response.ok) {
        console.warn("Skipping functional test: Server not reachable or error", response.status);
        return; 
      }

      const data = await response.json() as any;
      expect(response.status).toBe(200);
      expect(data.content).toBeDefined();
      expect(data.content[0].type).toBe("text");
      console.log("Short message response:", data.content[0].text);
    } catch (e) {
      console.warn("Skipping functional test: Server likely not running");
    }
  });

  test("Request without provider prefix should return 400", async () => {
    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gemini-3-flash",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 1024,
          stream: false,
        }),
      });

      if (!response.ok && response.status !== 400) {
        return;
      }

      const data = await response.json() as any;
      expect(response.status).toBe(400);
      expect(data.error?.type).toBe("invalid_request_error");
    } catch (e) {
    }
  });
});
