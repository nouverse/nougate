import { describe, expect, test } from "bun:test";
import { parseRetryDelay } from "../../src/providers/antigravity/utils/retry";
import {
  cacheSessionSignature,
  getSessionSignature,
  checkSessionSignatureRewind,
  cacheSignature,
  getSignature,
  cacheThinkingFamily,
  getSignatureFamily,
  cacheSessionReasoning,
  getSessionReasoning,
} from "../../src/providers/antigravity/utils/signature-cache";

describe("Grace Retry & Rewind Cache Unit Tests", () => {

  describe("parseRetryDelay()", () => {
    test("parses structured metadata delay", () => {
      const errorPayload = JSON.stringify({
        error: {
          code: 429,
          message: "Resource exhausted",
          details: [{
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason: "RATE_LIMIT_EXCEEDED",
            metadata: {
              quotaResetDelay: "2.5"
            }
          }]
        }
      });
      expect(parseRetryDelay(errorPayload)).toBe(2500);
    });

    test("parses Google Duration object inside details", () => {
      const errorPayload = JSON.stringify({
        error: {
          code: 429,
          message: "Resource exhausted",
          details: [{
            retryDelay: {
              seconds: 1,
              nanos: 500000000
            }
          }]
        }
      });
      expect(parseRetryDelay(errorPayload)).toBe(1500);
    });

    test("parses textual regex fallback inside message", () => {
      const errorPayload = JSON.stringify({
        error: {
          code: 429,
          message: "Quota exceeded. Please reset after 1.5s"
        }
      });
      expect(parseRetryDelay(errorPayload)).toBe(1500);
    });

    test("parses textual regex fallback direct string", () => {
      const rawError = "Resource has been exhausted. Please retry after 1h16m0.667s.";
      // 1h = 3600000ms, 16m = 960000ms, 0.667s = 667ms -> 4560667ms
      expect(parseRetryDelay(rawError)).toBe(4560667);
    });

    test("returns 0 on unparseable details", () => {
      expect(parseRetryDelay("Something completely different")).toBe(0);
    });
  });

  describe("Session Rewind Detection", () => {
    test("tracks session count and invalidates on rewind", () => {
      const sessionId = `test_session_${Date.now()}`;
      const sig = "sig_abc123xyz".repeat(5); // Must satisfy MIN_SIGNATURE_LENGTH (50)
      const thoughtText = "I will search the codebase";

      // Cache thoughts signature
      cacheSignature(sessionId, thoughtText, sig);
      expect(getSignature(sessionId, thoughtText)).toBe(sig);

      // Cache session signature at msg count 5
      cacheSessionSignature(sessionId, sig, 5);
      expect(getSessionSignature(sessionId)).toBe(sig);

      // Check same or higher msg count (no rewind)
      expect(checkSessionSignatureRewind(sessionId, 5)).toBe(false);
      expect(getSessionSignature(sessionId)).toBe(sig);
      expect(getSignature(sessionId, thoughtText)).toBe(sig);

      // Check rewind (msg count decreases)
      expect(checkSessionSignatureRewind(sessionId, 4)).toBe(true);
      
      // Verification: both session signature and individual thought signature must be cleared!
      expect(getSessionSignature(sessionId)).toBeUndefined();
      expect(getSignature(sessionId, thoughtText)).toBeUndefined();
    });
  });

  describe("Model Family Cache (Layer 2)", () => {
    test("associates and retrieves model family for signatures", () => {
      const sig = "sig_layer2_test_string_satisfying_length_limit".repeat(2);
      cacheThinkingFamily(sig, "claude-sonnet");
      expect(getSignatureFamily(sig)).toBe("claude-sonnet");
    });
  });

  describe("Session Reasoning Cache (Layer 4)", () => {
    test("stores and retrieves turn reasoning index correctly", () => {
      const sessionId = `session_layer4_${Date.now()}`;
      
      cacheSessionReasoning(sessionId, "This is turn 0 thinking", 0);
      cacheSessionReasoning(sessionId, "This is turn 1 thinking", 1);
      
      expect(getSessionReasoning(sessionId, 0)).toBe("This is turn 0 thinking");
      expect(getSessionReasoning(sessionId, 1)).toBe("This is turn 1 thinking");
      expect(getSessionReasoning(sessionId, 2)).toBeUndefined();
      
      // Overwrite with longer thinking
      cacheSessionReasoning(sessionId, "This is turn 0 thinking, upgraded and longer", 0);
      expect(getSessionReasoning(sessionId, 0)).toBe("This is turn 0 thinking, upgraded and longer");

      // Shorter thinking should be ignored
      cacheSessionReasoning(sessionId, "Short", 0);
      expect(getSessionReasoning(sessionId, 0)).toBe("This is turn 0 thinking, upgraded and longer");
    });
  });

});

