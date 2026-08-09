import type { RequestContext } from '@/core/request-context';

/**
 * Supported protocol identifiers for request routing.
 */
export type ProtocolId = 'openai' | 'anthropic' | 'gemini' | 'codex';

/**
 * A provider-owned account that can be used for upstream requests.
 */
export interface IAccount {
  readonly id: string;
  readonly providerId: string;
  healthScore: number;
  lastUsed: number;
  capabilities?: Record<string, boolean>;
  email?: string;
  projectId?: string;
  quota?: any[];
  cooldowns?: Record<string, number | string>;
  tokenUsage?: number;
  challenge?: any;
  consecutiveFailures?: number;
  modelScores?: Record<string, number>;
}

/**
 * Options used when selecting the best account from a provider.
 */
export interface AccountRequestOptions {
  pool?: 'cli' | 'sandbox' | string;
  modelId?: string;
  clientId?: string;
  excludeIds?: string[];
  skipRescue?: boolean;
}

/**
 * Result of parsing the model string sent by the client.
 */
export interface ResolvedModel {
  providerId: string | null;
  modelId: string;
  raw: string;
}

/**
 * Per-model configuration stored inside a provider registry.
 */
export interface IModelSpec {
  modelId: string;
  displayName?: string;
  pool: 'cli' | 'sandbox';
  isThinking: boolean;
  thinkingBudget?: number;
  thinkingMode?: 'budget' | 'level';
  thinkingLevel?: 'low' | 'medium' | 'high';
  maxOutputTokens: number;
  upstreamModelId?: string;
  useCliPool?: boolean;
  timeoutMs?: number;
  /** Upstream list price in USD per 1M input tokens, used for cost estimation. */
  inputPricePer1M?: number;
  /** Upstream list price in USD per 1M output tokens, used for cost estimation. */
  outputPricePer1M?: number;
}

/**
 * One upstream usage limit, in the only shape the dashboard understands.
 *
 * Every provider counts quota differently — a rolling window here, a monthly
 * seat allowance there, credits somewhere else — so the normalisation is the
 * provider's job. Whatever it fetches and however it merges that across its
 * accounts, it reports the result as this.
 */
export interface IProviderQuota {
  /** Stable key within the provider; also the React list key. */
  id: string;
  /** What this limit covers, e.g. "Claude Opus 4.6 (Thinking)". */
  label: string;
  /** Remaining headroom, 0–1. The card's bar and percentage come from this. */
  remainingFraction: number;
  /** Free-form, already formatted by the provider — units are its own. */
  used?: string;
  limit?: string;
  /** When the window rolls over, pre-formatted, e.g. "4h 59m". */
  resetIn?: string;
  /** Models this limit applies to, when the provider can attribute it. */
  modelIds?: string[];
}

/**
 * Registry contract for provider-scoped model lookup.
 */
export interface IModelRegistry {
  getSpec(modelId: string): IModelSpec | null;
  listModelIds(): string[];
}

/**
 * Provider = source of credentials, accounts, and provider-local model registry.
 */
export interface IProvider {
  readonly id: string;
  readonly displayName: string;

  init(): Promise<void>;
  getBestAccount(options: AccountRequestOptions): Promise<IAccount | null>;
  updateAccountUsage(
    accountId: string,
    success: boolean,
    meta: {
      modelId?: string;
      pool?: string;
      clientId?: string;
      statusCode?: number;
    },
  ): Promise<void>;
  getAccounts(): IAccount[];
  getModelRegistry(): IModelRegistry;
  getSupportedModels(): string[];
  execute(params: ProviderExecuteParams): Promise<Response>;

  /**
   * Report upstream usage limits. Optional: a provider with no notion of quota
   * simply does not implement it, and the dashboard hides its Quota tab.
   *
   * Implementing this is the *only* thing a provider needs to do to gain the
   * tab — nothing in the router or the UI is keyed to a provider id.
   */
  getQuotas?(): Promise<IProviderQuota[]>;

  // Optional administrative methods
  getStrategy?(): string;
  setStrategy?(strategy: string): Promise<void>;
  getConfig?(): any;
  updateConfig?(updates: any): Promise<any>;
  resetAllAccounts?(): Promise<void>;
  removeAccount?(accountId: string): Promise<void>;
  resetAccount?(accountId: string): Promise<void>;
  markAccountCooldown?(accountId: string, pool: string, duration?: string): Promise<void>;
  getCooldowns?(): Record<string, number>;
  addAccount?(body: any): Promise<any>;
  handleAccountAction?(accountId: string, action: string, payload?: any): Promise<any>;
}

export interface ProviderExecuteParams {
  protocol: 'openai' | 'anthropic';
  body: any;
  resolvedModel: ResolvedModel;
  modelSpec: IModelSpec;
  ctx: RequestContext;
}


/**
 * Protocol handler contract for a single client-facing API format.
 */
export interface IProtocolHandler {
  readonly protocol: ProtocolId;
  readonly paths: string[];
  readonly methods: string[];
  handle(ctx: RequestContext): Promise<Response>;
}

/**
 * Options passed into provider-specific upstream executors.
 */
export interface UpstreamExecuteOptions {
  googleBody: unknown;
  model: string;
  modelSpec: IModelSpec;
  sessionId: string;
  clientId: string;
  provider: IProvider;
}

/**
 * Result returned by an upstream executor after request completion.
 */
export interface UpstreamResult {
  response: Response;
  accountId: string;
  attempts: number;
}
