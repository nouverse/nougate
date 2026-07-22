import { expect, test, describe } from "bun:test";
import { TokenExchangeError } from "@/providers/copilot/auth/token-exchange";

describe("TokenExchangeError classification", () => {
  test("5xx server errors are transient (e.g. GitHub 502 Unicorn)", () => {
    expect(new TokenExchangeError("boom", 500).transient).toBe(true);
    expect(new TokenExchangeError("boom", 502).transient).toBe(true);
    expect(new TokenExchangeError("boom", 503).transient).toBe(true);
  });

  test("429 rate limit is transient", () => {
    expect(new TokenExchangeError("boom", 429).transient).toBe(true);
  });

  test("network errors (no status) are transient", () => {
    expect(new TokenExchangeError("network down").transient).toBe(true);
    expect(new TokenExchangeError("network down").status).toBeUndefined();
  });

  test("auth failures 401/403 are NOT transient", () => {
    expect(new TokenExchangeError("bad token", 401).transient).toBe(false);
    expect(new TokenExchangeError("forbidden", 403).transient).toBe(false);
  });

  test("other 4xx are NOT transient", () => {
    expect(new TokenExchangeError("bad request", 400).transient).toBe(false);
    expect(new TokenExchangeError("not found", 404).transient).toBe(false);
  });

  test("preserves status and is an Error instance", () => {
    const err = new TokenExchangeError("boom", 502);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(502);
    expect(err.name).toBe("TokenExchangeError");
  });
});
