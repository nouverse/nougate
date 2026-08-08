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

export interface TokenUsageResponse {
  lookback: Lookback;
  summary: UsageSummary;
  usageData: UsagePoint[];
  modelStats: ModelStat[];
  providerStats: Array<{ provider: string; requests: number; totalTokens: number; totalCost: number }>;
  clientStats: Array<{ clientId: string; requests: number; totalTokens: number; totalCost: number }>;
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
  enabled: boolean;
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
}

export interface CustomProviderSummary {
  id: string;
  displayName: string;
  baseUrl: string;
  apiStyle: CustomApiStyle;
  enabled: boolean;
  extraHeaders: Record<string, string>;
  defaultInputPrice: number | null;
  defaultOutputPrice: number | null;
  createdAt: number;
  updatedAt: number;
  keyCount?: number;
  modelCount?: number;
}

export interface CustomProviderDetail extends CustomProviderSummary {
  keys: CustomProviderKey[];
  models: CustomProviderModel[];
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
  /** Resolved price: the spec's own, else the price book, else the config default. */
  inputPricePer1M: number;
  outputPricePer1M: number;
  /** True when the price is the flat config default rather than a known rate. */
  pricingIsFallback: boolean;
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

export interface ProviderDetail extends Provider {
  config: Record<string, any>;
  models: ModelSpec[];
  accounts: Account[];
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
  models?: {
    blacklist?: string[];
    [key: string]: any;
  };
  quota?: Record<string, any>;
  endpoints?: Record<string, any>;
  features?: Record<string, any>;
  scheduling?: Record<string, any>;
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
