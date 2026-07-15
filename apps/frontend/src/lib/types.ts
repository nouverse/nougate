export interface Provider {
  id: string;
  displayName: string;
  accountCount: number;
  modelCount: number;
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
