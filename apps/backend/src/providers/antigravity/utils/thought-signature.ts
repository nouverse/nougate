import { getSignatureByCallId } from "@/providers/antigravity/utils/signature-cache";

/**
 * Placeholder that tells upstream to skip thought-signature validation.
 *
 * Gemini 3 rejects the whole request when the leading `functionCall` part of a
 * model turn carries no `thought_signature`:
 *
 *   400 INVALID_ARGUMENT — "Function call is missing a thought_signature in
 *   functionCall parts."
 *
 * A signature is only ever produced by upstream, so a call the gateway did not
 * issue itself — a client that regenerates tool call IDs, a history replayed
 * after the cache evicted the entry, a conversation moved from another model —
 * has nothing to replay. Google documents this exact literal as the escape
 * hatch, so an unsignable call keeps its real `functionCall`/`functionResponse`
 * shape instead of being rewritten into something else.
 *
 * Reasoning context is lost either way; structure is not.
 *
 * https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
 */
export const PLACEHOLDER_THOUGHT_SIGNATURE = "context_engineering_is_the_way_to_go";

/**
 * Report whether upstream enforces thought signatures for this model.
 *
 * Only Gemini 3 thinking models validate them. Sending the placeholder to any
 * other upstream would put an invented signature where none is expected.
 */
export function thoughtSignatureRequired(googleModel: string, thinkingEnabled: boolean): boolean {
  return thinkingEnabled && googleModel.includes("gemini-3");
}

/**
 * Resolve the signature for the leading function call of one model turn.
 *
 * Upstream validates the *first* `functionCall` part of each turn and attaches a
 * signature only to that part, so this is the only call in a turn that needs one.
 */
export function resolveLeadThoughtSignature(params: {
  callId: string;
  toolName: string;
  signatureRequired: boolean;
}): string | undefined {
  const cached = getSignatureByCallId(params.callId);
  if (cached) {
    return cached;
  }

  if (!params.signatureRequired) {
    return undefined;
  }

  console.log(
    `[Signature] No cached signature for ${params.toolName} (${params.callId}), sending the validation-skip placeholder`,
  );

  return PLACEHOLDER_THOUGHT_SIGNATURE;
}
