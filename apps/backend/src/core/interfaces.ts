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
