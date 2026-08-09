export interface Provider {
  id: string;
  displayName: string;
  accountCount: number;
  modelCount: number;
  /** True for user-defined providers managed from the Custom Providers page. */
  isCustom?: boolean;
}

// ─── Token usage & cost metrics ──────────────────────────────────────────────

export type Lookback = '24h' | '7d' | '14d' | '30d' | '60d' | '90d';

export interface UsagePoint {
  period: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokensSaved: number;
  totalCost: number;
  costSaved: number;
}

export interface ModelStat {
  fullModelName: string;
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCost: number;
}

export interface UsageSummary {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokensSaved: number;
  totalCost: number;
  costSaved: number;
  originalCost: number;
  savingsPercent: number;
  avgDurationMs: number;
  pendingWrites: number;
}

export interface ApiKeyStat {
  /** Key ID, or 'none' for historical traffic from before keys were required. */
  apiKeyId: string;
  name: string;
  revoked: boolean;
  requests: number;
  totalTokens: number;
  totalCost: number;
}

/** What one compression engine saved over the selected window. */
export interface CompressionEngineStat {
  engine: string;
  requests: number;
  tokensSaved: number;
  sharePercent: number;
}

export interface CompressionBreakdown {
  engines: CompressionEngineStat[];
  tokensSaved: number;
  /** False for windows served from the rollups, which keep only a combined total. */
  available: boolean;
}

export interface TokenUsageResponse {
  lookback: Lookback;
  summary: UsageSummary;
  usageData: UsagePoint[];
  modelStats: ModelStat[];
  providerStats: Array<{ provider: string; requests: number; totalTokens: number; totalCost: number }>;
  clientStats: Array<{ clientId: string; requests: number; totalTokens: number; totalCost: number }>;
  /** Always covers every key, even while one is selected. */
  apiKeyStats: ApiKeyStat[];
  compression: CompressionBreakdown;
  clients: string[];
}

export interface RecentUsageLog {
  id: number;
  timestamp: number;
  clientId: string;
  fullModelName: string;
  provider: string;
  protocol: string;
  streamed: number;
  statusCode: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  tokensSaved: number;
  estimated: number;
  totalCost: number;
  apiKeyId: string | null;
  apiKeyName: string | null;
}

// ─── Gateway API keys ────────────────────────────────────────────────────────

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revoked: boolean;
  requestCount: number;
  allowedProviders: string[];
}

export interface ApiKeysResponse {
  keys: ApiKey[];
}

export interface CreatedApiKey extends ApiKey {
  /** Shown once, immediately after creation. */
  key: string;
}

// ─── Custom providers ────────────────────────────────────────────────────────

export type CustomApiStyle = 'openai' | 'anthropic';

export interface CustomProviderKey {
  id: string;
  providerId: string;
  label: string;
  apiKey: string;
  healthScore: number;
  lastUsed: number;
  cooldownUntil: number;
  consecutiveFailures: number;
  tokenUsage: number;
  createdAt: number;
}

export interface CustomProviderModel {
  providerId: string;
  modelId: string;
  displayName: string | null;
  upstreamModelId: string | null;
  pool: 'cli' | 'sandbox';
  isThinking: boolean;
  thinkingMode: 'budget' | 'level' | null;
  thinkingBudget: number | null;
  maxOutputTokens: number;
  timeoutMs: number;
  inputPricePer1M: number | null;
  outputPricePer1M: number | null;
  enabled: boolean;
  /** Server-computed: false when no rate is known, so cost counts as $0. */
  isPriced?: boolean;
  effectiveInputPricePer1M?: number;
  effectiveOutputPricePer1M?: number;
}

/**
 * The delay window applied before requests leave the gateway. Every provider
 * has one; `BOTTOM_JITTER` on the server can raise it but never lower it.
 */
export interface JitterConfig {
  jitterEnabled: boolean;
  jitterMinMs: number;
  jitterMaxMs: number;
}

export interface CustomProviderSummary {
  id: string;
  displayName: string;
  baseUrl: string;
  apiStyle: CustomApiStyle;
  enabled: boolean;
  extraHeaders: Record<string, string>;
  jitter: JitterConfig;
  createdAt: number;
  updatedAt: number;
  keyCount?: number;
  modelCount?: number;
}

export interface CustomProviderDetail extends CustomProviderSummary {
  keys: CustomProviderKey[];
  /** Models are fetched separately — see useCustomProviderModels. */
  modelCount: number;
}

/** One callable model, keyed by the exact `provider:model` string a client sends. */
export interface CatalogModel {
  id: string;
  providerId: string;
  providerName: string;
  modelId: string;
  displayName: string;
  isThinking: boolean;
  maxOutputTokens: number;
  /** Resolved price: the model's own, else the built-in price book. */
  inputPricePer1M: number;
  outputPricePer1M: number;
  /** False when no rate is known, so cost is reported as $0. */
  isPriced: boolean;
  isCustom: boolean;
}

export interface ModelSpec {
  modelId: string;
  displayName?: string;
  pool: 'cli' | 'sandbox';
  isThinking: boolean;
  thinkingBudget?: number;
  thinkingMode?: 'budget' | 'level';
  thinkingLevel?: 'low' | 'medium' | 'high';
  maxOutputTokens: number;
  upstreamModelId?: string;
  timeoutMs?: number;
}

export interface Account {
  id: string;
  email: string;
  projectId?: string;
  healthScore: number;
  lastUsed: number;
  consecutiveFailures?: number;
  tokenUsage?: number;
  capabilities?: Record<string, boolean>;
  cooldowns?: Record<string, number | string>;
  modelScores?: Record<string, number>;
  challenge?: string;
  quota?: any[];
}

/** Which credential flow a provider offers, so the dashboard renders the right form. */
export type AccountFlow = 'oauth-redirect' | 'device-code' | 'api-key';

/**
 * One upstream usage limit, already normalised by the provider that owns it —
 * the dashboard never knows how it was computed.
 */
export interface ProviderQuota {
  id: string;
  label: string;
  remainingFraction: number;
  /** No cap on this plan — `used` is consumption, and the fraction means nothing. */
  unlimited?: boolean;
  used?: string;
  limit?: string;
  /** What `used`/`limit` count, e.g. "requests". Supplied by the provider. */
  unit?: string;
  resetIn?: string;
  modelIds?: string[];
}

export interface ProviderDetail extends Provider {
  config: Record<string, any>;
  models: ModelSpec[];
  accounts: Account[];
  /** What this provider can do, declared by the backend, not inferred by id. */
  capabilities: { quota: boolean; accountFlow: AccountFlow | null };
  /** Empty when the provider supports quotas but has not loaded any yet. */
  quotas: ProviderQuota[];
}

export interface ProxyConfig {
  bypassModelValidation?: boolean;
  rotation: {
    strategy: string;
    [key: string]: any;
  };
  scoring?: Record<string, any>;
  retry?: Record<string, any>;
  tokens?: Record<string, any>;
  logging?: Record<string, any>;
  metrics?: Record<string, any>;
  headroom?: {
    enabled?: boolean;
    url?: string;
    timeoutMs?: number;
  };
  rtk?: {
    enabled?: boolean;
  };
  caveman?: {
    enabled?: boolean;
    level?: number;
  };
  [key: string]: any;
}

export interface SSEEvent {
  type: 'init' | 'update' | 'flash' | 'log' | 'cooldown';
  data?: any;
  // Specific properties based on type
  version?: string;
  accounts?: Account[];
  strategy?: string;
  supportedModels?: string[];
  cooldowns?: Record<string, any>;
  message?: string; // for logs
  email?: string; // for flash
  status?: 'success' | 'error'; // for flash
}
