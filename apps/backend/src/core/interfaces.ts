import type { JitterConfig } from '@/core/jitter';
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
  /**
   * What this *route* can deliver to the model, not what the model can do in the abstract: Gemini
   * hears audio through Antigravity, but the same weights behind a mapper that has no audio part
   * would not. Omitted means undeclared, and a client should treat an undeclared modality as absent.
   */
  inputModalities?: InputModality[];
  /** `input_audio` formats this route accepts. Omitted when the route carries no audio. */
  inputAudioFormats?: InputAudioFormat[];
}

export type InputModality = 'text' | 'image' | 'audio';

/**
 * `ogg` is outside the OpenAI spec, which only names `mp3` and `wav`. It is declared per route, so a
 * client only sends it where a route says it is accepted and a strict OpenAI upstream never sees it.
 */
export type InputAudioFormat = 'mp3' | 'wav' | 'ogg';

/**
 * One upstream usage limit, in the only shape the dashboard understands.
 *
 * Every provider counts quota differently — a rolling window here, a monthly
 * seat allowance there, credits somewhere else — so the normalisation is the
 * provider's job. Whatever it fetches and however it merges that across its
 * accounts, it reports the result as this.
 */
export interface IProviderQuota {
  /** Stable key within the provider; also the React list key. */
  id: string;
  /** What this limit covers, e.g. "Claude Opus 4.6 (Thinking)". */
  label: string;
  /** Remaining headroom, 0–1. The card's bar and percentage come from this. */
  remainingFraction: number;
  /**
   * True when the plan has no cap. The figures below are then consumption, not
   * headroom, and `remainingFraction` carries no information — the dashboard
   * says so rather than drawing a full bar and implying a limit exists.
   */
  unlimited?: boolean;
  /** Free-form, already formatted by the provider — units are its own. */
  used?: string;
  limit?: string;
  /** What `used`/`limit` are counted in, e.g. "requests", "credits". */
  unit?: string;
  /** When the window rolls over, pre-formatted, e.g. "4h 59m". */
  resetIn?: string;
  /** Models this limit applies to, when the provider can attribute it. */
  modelIds?: string[];
}

/**
 * How a provider acquires an account, which is the only thing the dashboard needs
 * to know to render the right "add account" flow.
 *
 * Declared rather than inferred: the dashboard used to pick its form by provider
 * id, so every provider that was not Copilot got Antigravity's Google OAuth
 * dialog — including custom providers, which only ever wanted an API key.
 */
export type AccountFlow = 'oauth-redirect' | 'device-code' | 'api-key' | 'oauth-token';

/**
 * What a sign-in screen says about a provider, in the provider's own words.
 *
 * `accountFlow` decides what a screen *does*; this decides what it *says*. Both come from the
 * provider, so no screen has to know which provider it is drawing — not this gateway's dashboard,
 * and not a host's setup wizard (Nouride's "Use Nougate LLM Gateway"), which lists every provider
 * with a sign-in flow and knows none of them by name. A provider added next month brings its own
 * words with it.
 *
 * Copy used to sit in the dashboard keyed by provider id, which kept behaviour out of it but put
 * knowledge of every provider into a component that was supposed to be generic — and a host had no
 * way to read it at all.
 */
export interface AccountCopy {
  /** What a person calls it — "Claude", "ChatGPT". `displayName` is often the product's own name. */
  label: string;
  /** One line under the label: which account this takes — "Claude Pro or Max subscription". */
  hint: string;
  /** Where a list of sign-ins puts it, lower first. Ties sort by label. */
  order: number;
  /** The sign-in dialog's title, its opening sentence, and the button that starts it. */
  title?: string;
  intro?: string;
  button?: string;
  /** `oauth-redirect`: what happens after approving — where the tab lands, and what to bring back. */
  consent?: string;
  /** `oauth-redirect`, `oauth-token`: the field the person pastes into, and what goes in it. */
  pasteLabel?: string;
  pastePlaceholder?: string;
}

/**
 * `oauth-token` is the paste-a-token flow, and it is not the same thing as `api-key`.
 *
 * Both render one field, which is why it was tempting to reuse `api-key` — and why doing so was
 * wrong. The form is the only thing an operator sees, so a provider whose entire reason to exist is
 * subscription-backed OAuth, labelled "ADD AN API KEY" with an `sk-…` placeholder, describes itself
 * as the one thing it is not. A custom provider already covers API keys; if that is all this looked
 * like, it should not exist.
 *
 * The distinction is real on the wire too: an API key goes on `x-api-key`, an OAuth token on
 * `Authorization: Bearer` plus a beta header, and sending either on the other's header is a 401.
 */

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

  /**
   * Which credential flow the dashboard should offer. Omitted means the provider
   * has no way to add an account from the UI, and the list renders read-only.
   */
  readonly accountFlow?: AccountFlow;

  /**
   * What sign-in screens say about this provider (`AccountCopy`). Optional: a provider without it is
   * listed under its `displayName` with neutral wording, never another provider's.
   */
  readonly accountCopy?: AccountCopy;

  init(): Promise<void>;

  /**
   * The delay window applied before this provider's requests leave the gateway.
   *
   * Required, not a capability: every upstream is somebody's account being used
   * from one egress IP, and a provider that ships without a considered answer
   * here is a provider that machine-guns its upstream. Returning
   * `DEFAULT_JITTER_CONFIG` is a valid answer — omitting the method is not, and
   * will not compile.
   *
   * The gateway, not the provider, does the waiting: see
   * `executeProviderRequest`, which also applies the `BOTTOM_JITTER` floor.
   */
  getJitterConfig(): JitterConfig;

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

  /**
   * Report upstream usage limits. Optional: a provider with no notion of quota
   * simply does not implement it, and the dashboard hides its Quota tab.
   *
   * Implementing this is the *only* thing a provider needs to do to gain the
   * tab — nothing in the router or the UI is keyed to a provider id.
   */
  getQuotas?(): Promise<IProviderQuota[]>;

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
  /**
   * Accounts are added through `addAccount`. A `device-code` provider answers an empty body with
   * `{ step: 'device_flow', device_code, user_code, verification_uri, … }`, and a body of
   * `{ token }` with the stored account — the pasted-credential path every device-code provider
   * offers beside the login.
   */
  addAccount?(body: any): Promise<any>;
  /**
   * Poll a device login started by `addAccount({})`. Required by `accountFlow: 'device-code'`, and
   * reached through the provider-agnostic `/api/providers/:id/device-status` route.
   */
  completeDeviceFlow?(deviceCode: string): Promise<DeviceFlowPollResult>;
  handleAccountAction?(accountId: string, action: string, payload?: any): Promise<any>;
}

/** What a device-login poll reports back to the dashboard. */
export type DeviceFlowPollResult =
  | { status: 'success'; account: IAccount }
  | { status: 'pending' | 'expired'; error?: string };

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
