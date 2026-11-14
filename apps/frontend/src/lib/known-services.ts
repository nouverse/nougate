import { headersFromText, headersToText } from './extra-headers';
import type { CustomApiStyle } from './types';

/**
 * Services a person is likely to add as a custom provider, with what its form asks for (an id, a name, the base URL
 * and the API style), where its key is made, and what using that key costs.
 *
 * Starting values and a hint, nothing more. The provider that results is a custom one like any other, the form's
 * fields stay the person's to change, and nothing in the gateway reads this list: a service's behaviour is never
 * decided by its name.
 *
 * The question at the key's field is not only "where is the key" but "will this charge me": a chat subscription does
 * not cover the same company's API, and a few services do include the key in a plan. Each says which it is.
 *
 * Each entry was read from the service's own documentation and its address asked without a key: it refused for the
 * key alone, which is what a right address does. A service that needs more than a key says what in `headers`, which
 * a press puts in the form's extra headers, where the person sees them and may change them: OpenCode Go refuses a
 * request that does not say its conversation in `x-opencode-session`, and the gateway writes the conversation's id
 * where a header's value says `{session}`.
 */
export interface KnownService {
  /** The provider id the form starts with: the prefix its models are called by. */
  id: string;
  displayName: string;
  /** With the version path and no slash at its end, as the form stores it. */
  baseUrl: string;
  apiStyle: CustomApiStyle;
  /** The page of the service where a person makes the key. */
  keyUrl: string;
  /** Whether using the key is charged by use, or is part of a plan the person already pays for. */
  cost: 'per-use' | 'included';
  /** What it costs and what to know first, in a sentence or two. */
  note: string;
  /**
   * Headers the service asks for beyond its key, which a press fills the form's extra headers with. `{session}` in a
   * value is where the gateway writes the conversation's id on each request.
   */
  headers?: Record<string, string>;
}

export const KNOWN_SERVICES: KnownService[] = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiStyle: 'openai',
    keyUrl: 'https://platform.openai.com/api-keys',
    cost: 'per-use',
    note: 'Charged per use, from credits you add there. A ChatGPT subscription does not cover it.',
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    apiStyle: 'anthropic',
    keyUrl: 'https://platform.claude.com/settings/keys',
    cost: 'per-use',
    note: 'Charged per use, billed apart from a Claude subscription.',
  },
  {
    id: 'gemini',
    displayName: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiStyle: 'openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    cost: 'per-use',
    note: 'Free within its limits, then charged per use.',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiStyle: 'openai',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    cost: 'per-use',
    note: 'Charged per use, from the balance you top up there.',
  },
  {
    id: 'zai',
    displayName: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    apiStyle: 'openai',
    keyUrl: 'https://z.ai/manage-apikey/apikey-list',
    cost: 'per-use',
    note: 'Charged per use, from your balance there. Its GLM Coding Plan is for the coding tools Z.ai lists, and does not cover use from here.',
  },
  {
    id: 'opencode-zen',
    displayName: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/inference/openai/v1',
    apiStyle: 'openai',
    keyUrl: 'https://opencode.ai/console',
    cost: 'per-use',
    note: 'Charged per request, from credits you add there. Its free models answer only inside OpenCode itself.',
  },
  {
    id: 'opencode-go',
    displayName: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    apiStyle: 'openai',
    keyUrl: 'https://opencode.ai/console',
    cost: 'included',
    note: "Your OpenCode Go plan includes the key: use counts against the plan's limits and stops there, so nothing is charged outside it unless you turn on Extra Usage there. OpenCode means Go for coding agents.",
    headers: { 'x-opencode-session': '{session}' },
  },
  {
    id: 'commandcode',
    displayName: 'Command Code',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    apiStyle: 'openai',
    keyUrl: 'https://commandcode.ai/settings/keys',
    cost: 'included',
    note: "Your Command Code plan includes the key: use draws on the plan's credits and stops when they run out, so nothing is charged outside it. Every plan but Go.",
  },
];

/** What a line's cost is called beside its name. */
export const COST_LABEL: Record<KnownService['cost'], string> = { 'per-use': 'Pay per use', included: 'In your plan' };

/** A base URL as the form stores it: no space around it, no slash at its end. */
const normalized = (baseUrl: string) => baseUrl.trim().replace(/\/+$/, '');

/** The known service a base URL is, whoever typed it; none for any other address. */
export function knownServiceAt(baseUrl: string): KnownService | undefined {
  const at = normalized(baseUrl);
  return KNOWN_SERVICES.find((service) => service.baseUrl === at);
}

/** The add form's fields: what a known service can start, and what the person types beside it. */
export interface ProviderForm {
  id: string;
  displayName: string;
  baseUrl: string;
  apiStyle: CustomApiStyle;
  /** One header on each line, as `Name: value` (`extra-headers.ts`). */
  extraHeaders: string;
  apiKey: string;
  keyLabel: string;
  autoLoadModels: boolean;
}

/**
 * What the add form sends to create a provider: its fields, the extra headers as the lines of their field say them.
 * None are sent for a field left empty, which is what a provider with no extra headers is.
 */
export function creationOf(form: ProviderForm) {
  const headers = headersFromText(form.extraHeaders);
  return {
    id: form.id,
    displayName: form.displayName || form.id,
    baseUrl: form.baseUrl,
    apiStyle: form.apiStyle,
    apiKey: form.apiKey || undefined,
    keyLabel: form.keyLabel || undefined,
    autoLoadModels: form.autoLoadModels,
    ...(Object.keys(headers).length > 0 ? { extraHeaders: headers } : {}),
  };
}

/**
 * A form started from a known service: its id, name, address and style, and the headers it asks for, which replace
 * what the field held so one service's header never stays on a form pointed at another. What the person already typed
 * that the service does not say (a key, its label, whether to load the models) is kept.
 */
export function startFrom(form: ProviderForm, service: KnownService): ProviderForm {
  return { ...form, id: service.id, displayName: service.displayName, baseUrl: service.baseUrl, apiStyle: service.apiStyle, extraHeaders: headersToText(service.headers) };
}
