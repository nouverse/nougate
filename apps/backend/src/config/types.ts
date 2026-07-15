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
