import type { IProvider, ProtocolId, ResolvedModel } from './interfaces';

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
}
