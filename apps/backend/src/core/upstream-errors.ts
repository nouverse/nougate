/**
 * One vocabulary for "why did the upstream refuse this", shared by every
 * provider.
 *
 * Providers each speak their own error dialect — Google returns
 * `RESOURCE_EXHAUSTED` in a details array, GitHub returns a bare 429 — but the
 * gateway only ever needs four answers: is it worth retrying, is it worth
 * trying a different account, does it apply to this model alone, and what do we
 * tell the operator. Classifying once means the cooldown, the retry loop and
 * the dashboard cannot disagree about the same failure.
 */

export type UpstreamErrorKind =
  /** The allowance for this window is spent; it comes back on a schedule. */
  | 'quota_exhausted'
  /** Too many requests too quickly; it comes back on its own, usually seconds. */
  | 'rate_limited'
  /** The upstream has no capacity for this model right now. */
  | 'model_capacity'
  /** The upstream does not know this model. */
  | 'model_unsupported'
  /** The credential was rejected — a different account may still work. */
  | 'auth'
  /** The upstream broke. Not our fault, usually transient. */
  | 'server_error'
  /** We gave up waiting. */
  | 'timeout'
  /** The request never reached the upstream. */
  | 'network'
  | 'unknown';

export interface UpstreamErrorClass {
  kind: UpstreamErrorKind;
  /** Whether trying again could plausibly succeed. */
  retryable: boolean;
  /** Whether a *different account* is likely to do better. */
  rotate: boolean;
  /**
   * Whether the refusal is about the requested model rather than the account.
   * Drives cooldown scope: a model-scoped failure must not take the whole
   * account out of rotation.
   */
  modelScoped: boolean;
  /** One sentence, for logs and the dashboard. */
  message: string;
}

/** Body fragments that mean "the window's allowance is gone", not "slow down". */
const QUOTA_MARKERS = [
  'resource_exhausted',
  'quota',
  'rate_limit_exceeded',
  'automated queries',
];

/** Body fragments that mean the upstream itself is saturated for this model. */
const CAPACITY_MARKERS = ['overloaded', 'model_capacity', 'capacity', 'try again later'];

const UNSUPPORTED_MARKERS = ['not found', 'not supported', 'unknown model', 'does not exist'];

function contains(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

export interface ClassifyInput {
  /** HTTP status, when the request reached the upstream at all. */
  status?: number;
  /** Response body, if read. Only substring-matched, never parsed as trusted. */
  body?: string;
  /** Thrown error, when the request failed before a response. */
  error?: unknown;
}

/**
 * Classify an upstream failure.
 *
 * Deliberately conservative: anything it cannot place becomes `unknown` with
 * `retryable: false`, so a new failure mode surfaces as an error instead of
 * being silently retried forever.
 */
export function classifyUpstreamError({ status, body, error }: ClassifyInput): UpstreamErrorClass {
  if (error !== undefined && status === undefined) {
    const name = (error as { name?: string })?.name ?? '';
    const text = String((error as { message?: string })?.message ?? error).toLowerCase();

    if (name === 'AbortError' || name === 'TimeoutError' || text.includes('timeout')) {
      return {
        kind: 'timeout',
        retryable: true,
        // The account is fine; it was the wait that failed.
        rotate: false,
        modelScoped: false,
        message: 'The upstream did not answer in time.',
      };
    }

    return {
      kind: 'network',
      retryable: true,
      rotate: true,
      modelScoped: false,
      message: 'The request never reached the upstream.',
    };
  }

  const haystack = (body ?? '').toLowerCase();

  if (status === 401 || status === 403) {
    return {
      kind: 'auth',
      retryable: false,
      rotate: true,
      modelScoped: false,
      message: 'The upstream rejected this account’s credentials.',
    };
  }

  if (status === 404 && contains(haystack, UNSUPPORTED_MARKERS)) {
    return {
      kind: 'model_unsupported',
      retryable: false,
      // Every account will say the same thing, so rotating just burns them.
      rotate: false,
      modelScoped: true,
      message: 'The upstream does not offer this model.',
    };
  }

  if (status === 429) {
    if (contains(haystack, QUOTA_MARKERS)) {
      return {
        kind: 'quota_exhausted',
        retryable: true,
        rotate: true,
        modelScoped: true,
        message: 'This account’s allowance for the model is spent.',
      };
    }

    return {
      kind: 'rate_limited',
      retryable: true,
      rotate: true,
      modelScoped: true,
      message: 'Too many requests too quickly.',
    };
  }

  if (status === 503 || status === 529) {
    if (contains(haystack, CAPACITY_MARKERS)) {
      return {
        kind: 'model_capacity',
        retryable: true,
        rotate: true,
        modelScoped: true,
        message: 'The upstream has no capacity for this model right now.',
      };
    }
  }

  if (status !== undefined && status >= 500) {
    return {
      kind: 'server_error',
      retryable: true,
      rotate: true,
      modelScoped: false,
      message: 'The upstream returned a server error.',
    };
  }

  return {
    kind: 'unknown',
    retryable: false,
    rotate: false,
    modelScoped: false,
    message: status ? `The upstream returned ${status}.` : 'The upstream failed for an unknown reason.',
  };
}


/**
 * A provider failure that already knows how the client should be answered.
 *
 * Thrown from a provider's `execute()`. The protocol handlers translate it into
 * each protocol's own error shape instead of the generic 502 that every other
 * failure becomes — a 502 tells a client the gateway is broken, which sends
 * people debugging the wrong thing.
 *
 * Lives in core so no handler has to import a provider-specific error type.
 */
export class ProviderResponseError extends Error {
  readonly status: number;
  /** Machine-readable code for the client, e.g. "model_not_found". */
  readonly clientCode: string;
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    options: { status: number; clientCode: string; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = 'ProviderResponseError';
    this.status = options.status;
    this.clientCode = options.clientCode;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Temporarily out of capacity, and it knows for how long. */
export class ProviderUnavailableError extends ProviderResponseError {
  constructor(message: string, status = 429, retryAfterSeconds?: number) {
    super(message, { status, clientCode: 'rate_limited', retryAfterSeconds });
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * The upstream does not know this model.
 *
 * Distinct from unavailability because no amount of rotating or waiting helps:
 * every account queries the same catalogue, so trying them all just damages
 * their health scores and buries the real cause.
 */
export class ModelUnavailableError extends ProviderResponseError {
  constructor(message: string) {
    super(message, { status: 404, clientCode: 'model_not_found' });
    this.name = 'ModelUnavailableError';
  }
}

/**
 * The request carries a content part this route cannot deliver to its upstream.
 *
 * Raised by a mapper *instead of* dropping the part. A dropped part is the worst failure a gateway
 * can have: the model answers fluently about a voice note it never heard, and nobody finds out. A
 * 400 with a named code lets the caller fall back honestly — transcribe, or tell the user.
 *
 * Being a 400, it also stops `executeWithFailover`: a later candidate that could have carried the
 * part is not tried. That holds for today's routes — a Claude model cannot hear on any of them — but
 * a model served both by a mapper that rejects and by a passthrough that forwards would need the
 * failover to treat this as provider-specific.
 */
export class UnsupportedContentPartError extends ProviderResponseError {
  constructor(partType: string, providerId: string) {
    super(`${partType} is not supported by the ${providerId} provider`, {
      status: 400,
      clientCode: 'unsupported_content_part',
    });
    this.name = 'UnsupportedContentPartError';
  }
}

/**
 * The upstream's own words for a refusal, when it sent JSON.
 *
 * Providers disagree about where the sentence lives — Anthropic uses `error.message`, Codex uses a
 * bare `detail` — and passing the whole envelope on as a message nests one error shape inside
 * another, so the client renders JSON as prose with the actual sentence buried in it. The raw text
 * is the fallback, because a refusal from an edge proxy rather than from the API is not JSON at all.
 */
export function upstreamMessage(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body);
    for (const candidate of [parsed?.error?.message, parsed?.detail, parsed?.message]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate;
    }
  } catch {
    // Not JSON; fall through to the text.
  }
  return body.trim() || fallback;
}
