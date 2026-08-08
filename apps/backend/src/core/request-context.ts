import type { IProvider, ProtocolId, ResolvedModel } from '@/core/interfaces';

/**
 * Parsed request data shared between the router and protocol handlers.
 */
export interface RequestContext {
  req: Request;
  url: URL;
  protocol: ProtocolId;
  resolvedModel: ResolvedModel;
  provider: IProvider;
  sessionId: string;
  clientId: string;
  /** ID of the gateway API key that authorized this call, when key auth is on. */
  apiKeyId?: string | null;
}
