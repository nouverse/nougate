import type { RequestContext } from './request-context';

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
