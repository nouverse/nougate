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
    /**
     * How much remaining upstream quota is worth when ranking accounts.
     *
     * Scored 0–`quota` from the account's worst relevant quota, so a fresh
     * account outranks a nearly-spent one before a request is ever sent.
     * Accounts whose provider reports no quota score 0 here and rank exactly as
     * they did before. Set to 0 to ignore quota entirely.
     */
    quota: number;
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
  /**
   * Optional blanket rate, in USD per 1M tokens, for models that neither the
   * dashboard nor the built-in price book can price. 0 disables it, leaving
   * such models reported as unpriced ($0) instead of estimated.
   */
  defaultInputPricePer1M: number;
  defaultOutputPricePer1M: number;
}


export interface DebugLoggerConfig {
  enabled: boolean;
  /** Directory to write debug payloads */
  outputDir?: string;
  /** Only log requests matching these model patterns (glob-like). Empty = all */
  modelFilter?: string[];
}
