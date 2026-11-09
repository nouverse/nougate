/**
 * Assembling the `GenerateAssistantResponse` body — the part shared by both client dialects.
 *
 * The OpenAI and Anthropic mappers each turn their own message list into Kiro turns; everything
 * after that is the same: resolve the model's suffixes and the client's thinking request, build the
 * prompt prefix, replay the conversation start for the cache, canonicalise, and wrap.
 *
 * Preparation is split from finalisation because part of the body depends on the account: the
 * profile ARN, and the replay store, which is per credential. The executor calls `forAccount` once
 * per account it tries.
 */

import { ProviderResponseError } from '@/core/upstream-errors';
import { KIRO_AGENTIC_SYSTEM_PROMPT } from '../config/agentic-prompt';
import { getKiroConfig } from '../config/provider-config';
import { kiroModelRegistry, KIRO_MAX_OUTPUT_TOKENS, resolveKiroModelIntent } from '../config/model-specs';
import {
  applyThinkingOverride,
  buildAdditionalModelRequestFields,
  buildThinkingSystemPrefix,
  resolveThinkingBudget,
  usesNativeGptEffort,
} from '../config/reasoning';
import type { KiroAccount } from '../auth/types';
import { resolveProfileArn } from '../upstream/endpoints';
import { applySessionReplay, resolveConversationId, type KiroTurn, type KiroUserTurn } from '../session-replay';
import { canonicalizeConversation, normalizeToolSpecs, reverseToolNames } from './conversation';

export interface KiroConversation {
  history: KiroTurn[];
  currentMessage: KiroUserTurn;
}

export interface KiroRequestInput {
  /** Provider-local model id as requested: may carry `-thinking`, `-agentic`, `(level)`. */
  requestedModel: string;
  /** The client body, read for thinking intent and sampling parameters. */
  body: any;
  headers: Headers | null;
  tools: unknown;
  /** The client's system prompt as text. Empty when the dialect inlined it into the turns. */
  systemText: string;
  maxTokens?: number;
  /** Builds the turns once the upstream model id is known — turns carry it. */
  convert(upstreamModel: string): KiroConversation;
}

export interface PreparedKiroRequest {
  upstreamModel: string;
  /** Reasoning arrives inline as `<thinking>` text and must be split out of the answer. */
  inlineThinking: boolean;
  /** Sanitised tool name → client tool name, for calls coming back. */
  toolNameMap: Map<string, string>;
  contextWindow?: number;
  forAccount(account: Pick<KiroAccount, 'id' | 'authMethod' | 'profileArn'>): Record<string, unknown>;
}

export function prepareKiroRequest(input: KiroRequestInput): PreparedKiroRequest {
  const intent = resolveKiroModelIntent(input.requestedModel);
  // As the registry lists it: Kiro refuses a spelling of its own model it no longer uses.
  const upstreamModel = kiroModelRegistry.upstreamSpelling(intent.upstream);
  const body = applyThinkingOverride(input.body ?? {}, intent.thinkingOverride);

  const thinkingBudget = resolveThinkingBudget(body, input.headers, intent.model);
  const additionalModelRequestFields = buildAdditionalModelRequestFields(body, upstreamModel);
  const nativeGpt = usesNativeGptEffort(body, upstreamModel);
  // GPT with a native effort gets no prompt tag — it would read it as user text. Claude keeps the
  // tag beside its effort fields, as Kiro's own IDE sends it; whichever channel the reasoning then
  // arrives on, inline tags or `reasoningContentEvent`, it is surfaced as reasoning.
  const inlineThinking = thinkingBudget !== null && !nativeGpt;

  const { specs: toolSpecs, nameMap } = normalizeToolSpecs(input.tools);
  const conversation = input.convert(upstreamModel);

  // The system prompt travels inside the first user turn: the CodeWhisperer surface answers a
  // top-level `systemPrompt` with 400 REQUEST_BODY_INVALID. `systemPrompt` is therefore only the
  // replay cache key; `contentPrefix` is what is actually sent.
  const systemParts: string[] = [];
  if (inlineThinking) systemParts.push(buildThinkingSystemPrefix(thinkingBudget!));
  if (intent.agentic) systemParts.push(KIRO_AGENTIC_SYSTEM_PROMPT);
  if (input.systemText) systemParts.push(input.systemText);
  const systemPrompt = systemParts.filter(Boolean).join('\n\n');
  const timeContext = `[Context: Current time is ${new Date().toISOString()}]`;
  const contentPrefix = [systemPrompt, timeContext].filter(Boolean).join('\n\n');

  const { conversationId, ephemeral } = resolveConversationId(input.headers, input.body);
  const replayEnabled = getKiroConfig().features.sessionReplay && !ephemeral;

  const maxTokens = input.maxTokens || KIRO_MAX_OUTPUT_TOKENS;
  const inferenceConfig: Record<string, number> = { maxTokens };
  if (typeof body.temperature === 'number') inferenceConfig.temperature = body.temperature;
  if (typeof body.top_p === 'number') inferenceConfig.topP = body.top_p;

  const built = new Map<string, Record<string, unknown>>();

  return {
    upstreamModel,
    inlineThinking,
    toolNameMap: reverseToolNames(nameMap),
    contextWindow: kiroModelRegistry.describeModel(intent.model)?.contextLength,
    forAccount(account) {
      const cached = built.get(account.id);
      if (cached) return cached;

      const replay = applySessionReplay({
        conversationId,
        accountId: account.id,
        modelId: upstreamModel,
        systemPrompt,
        contentPrefix,
        currentContentPrefix: timeContext,
        history: conversation.history,
        currentMessage: conversation.currentMessage,
        enabled: replayEnabled,
      });
      const canonical = canonicalizeConversation({
        history: replay.history,
        currentMessage: replay.currentMessage,
        modelId: upstreamModel,
        toolSpecs,
        nameMap,
      });
      // The canonicaliser already tried flattening every tool exchange to text. A body that is
      // still invalid cannot be made shippable, and Kiro would answer it with a bare 400, so it is
      // refused here — no upstream call spent, no account penalised.
      if (!canonical.valid) {
        const detail = canonical.errors.join(', ') || 'unknown';
        console.error(`[kiro] refusing invalid conversation: ${detail} | turns=${canonical.history.length + 1}`);
        throw new ProviderResponseError(`Kiro cannot represent this conversation (${detail}).`, {
          status: 400,
          clientCode: 'invalid_request_error',
        });
      }

      const current = canonical.currentMessage.userInputMessage;
      const payload: Record<string, unknown> = {
        conversationState: {
          chatTriggerType: 'MANUAL',
          conversationId,
          currentMessage: {
            userInputMessage: {
              content: current.content || '',
              modelId: upstreamModel,
              origin: 'AI_EDITOR',
              ...(current.images?.length ? { images: current.images } : {}),
              ...(current.userInputMessageContext ? { userInputMessageContext: current.userInputMessageContext } : {}),
            },
          },
          history: canonical.history,
        },
        inferenceConfig,
      };
      const profileArn = resolveProfileArn(account);
      if (profileArn) payload.profileArn = profileArn;
      if (additionalModelRequestFields) payload.additionalModelRequestFields = additionalModelRequestFields;

      built.set(account.id, payload);
      return payload;
    },
  };
}
