import type { CustomApiStyle } from './types';

/**
 * Services a person is likely to add as a custom provider, with what its form asks for: an id, a name, the base URL
 * and the API style, and where its key is made.
 *
 * Starting values and a hint, nothing more. The provider that results is a custom one like any other, the form's
 * fields stay the person's to change, and nothing in the gateway reads this list: a service's behaviour is never
 * decided by its name.
 *
 * Each entry was read from the service's own documentation and its endpoints asked without a key: the models list
 * answered, and chat completions refused for the key alone. A service that needs more than a key (OpenCode Go asks
 * for a session header on every request, which a custom provider does not send) is left out, since the hint would
 * lead to a provider that refuses everything.
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
  /** What to know before the key is pasted: which plan answers, how it is billed, what is refused. */
  note: string;
}

export const KNOWN_SERVICES: KnownService[] = [
  {
    id: 'opencode-zen',
    displayName: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/inference/openai/v1',
    apiStyle: 'openai',
    keyUrl: 'https://opencode.ai/console',
    note: 'Billed per request, from credits you add in its console. Its free models answer only inside OpenCode itself: route a paid one.',
  },
  {
    id: 'commandcode',
    displayName: 'Command Code',
    baseUrl: 'https://api.commandcode.ai/provider/v1',
    apiStyle: 'openai',
    keyUrl: 'https://commandcode.ai/settings/keys',
    note: "Uses your plan's credits. Every plan but Go has this access: on Go each request is refused.",
  },
];

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
