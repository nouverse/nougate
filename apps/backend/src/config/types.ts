export interface ProxyConfig {
  baseUrl?: string;
  bypassModelValidation?: boolean;
  rotation: RotationConfig;
  scoring: ScoringConfig;
  retry: RetryConfig;
  tokens: TokensConfig;
  logging: LoggingConfig;
  headroom?: HeadroomConfig;
  caveman?: CavemanConfig;
  rtk?: RtkConfig;
  debugLogger?: DebugLoggerConfig;
  metrics?: MetricsConfig;
  apiKeys?: ApiKeysConfig;
}

export interface RotationConfig {
  strategy: 'hybrid' | 'sticky' | 'round-robin' | 'random' | 'least-used';
  cooldown: {
    defaultDurationMs: number;
    maxDurationMs: number;
  };
}

export interface ScoringConfig {
  healthRange: {
    min: number;
    max: number;
    initial: number;
  };
  penalties: {
    apiError: number;
    refreshError: number;
    fatalError: number;
    systemicError: number;
  };
  rewards: {
    success: number;
  };
  weights: {
    health: number;
    lru: number;
  };
}

export interface RetryConfig {
  maxAttempts: number;
  transientRetryThresholdSeconds: number;
}

export interface TokensConfig {
  expiryBufferMs: number;
}

export interface LoggingConfig {
  maxBufferSize: number;
  enableConsoleCapture: boolean;
}

export interface HeadroomConfig {
  enabled: boolean;
  url?: string;
  timeoutMs?: number;
}

export interface CavemanConfig {
  enabled: boolean;
  /** Intensity level: 1 (mild) to 5 (extreme) */
  level: number;
}

export interface RtkConfig {
  enabled: boolean;
}

export interface MetricsConfig {
  /** Record token usage and cost per request into SQLite. */
  enabled: boolean;
  /** How long detailed per-request rows are kept before pruning. */
  detailRetentionDays: number;
  /** How long daily rollups are kept before pruning. */
  rollupRetentionDays: number;
  /** Price fallback for models without pricing (e.g. bypassModelValidation). */
  defaultInputPricePer1M: number;
  defaultOutputPricePer1M: number;
}

export interface ApiKeysConfig {
  /**
   * When true, /openai/v1/* and /anthropic/v1/* require a gateway key.
   * Kept false by default so existing clients keep working after upgrade.
   */
  enabled: boolean;
}

export interface DebugLoggerConfig {
  enabled: boolean;
  /** Directory to write debug payloads */
  outputDir?: string;
  /** Only log requests matching these model patterns (glob-like). Empty = all */
  modelFilter?: string[];
}
