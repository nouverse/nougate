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
 * key alone, which is what a right address does. A service that needs more than a key (OpenCode Go asks for a session
 * header on every request, which a custom provider does not send) is left out, since the hint would lead to a
 * provider that refuses everything.
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

/**
 * A form started from a known service: its id, name, address and style. What the person already typed that the
 * service does not say (a key, its label, whether to load the models) is kept.
 */
export function startFrom<T extends { id: string; displayName: string; baseUrl: string; apiStyle: CustomApiStyle }>(
  form: T,
  service: KnownService,
): T {
  return { ...form, id: service.id, displayName: service.displayName, baseUrl: service.baseUrl, apiStyle: service.apiStyle };
}
