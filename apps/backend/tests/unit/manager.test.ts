import { expect, test, describe } from "bun:test";
import { getFamilyName } from "@/providers/antigravity/auth/manager";

describe("Manager Utils", () => {
  test("getFamilyName should correctly classify models", () => {
    expect(getFamilyName("gemini-3-flash")).toBe("Gemini 3 Flash");
    expect(getFamilyName("gemini-3-pro")).toBe("Gemini 3 Pro");
    expect(getFamilyName("claude-opus-4-6")).toBe("Claude/GPT");
    expect(getFamilyName("gpt-oss-120b")).toBe("Claude/GPT");
    expect(getFamilyName("gemini-2.5-flash")).toBe("Gemini 2.5");
    expect(getFamilyName("unknown-model")).toBe("Other");
  });
});
