import { describe, expect, test } from 'bun:test';

/**
 * The services the add-provider form can start from. Each is a set of starting values a person would otherwise copy
 * out of a service's documentation, and a wrong one makes a provider that refuses every request with nothing to say
 * why: so what the list holds is held to the form's own rules, and what a press does to the form is held too.
 */

const { KNOWN_SERVICES, knownServiceAt, startFrom } = await import('@/lib/known-services');

/** The backend's rule for a provider id (`PROVIDER_ID_PATTERN`), which the form's field repeats. */
const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/;

describe('the known services', () => {
  test('each holds what the form needs, in the form the backend takes', () => {
    expect(KNOWN_SERVICES.length).toBeGreaterThan(0);
    for (const service of KNOWN_SERVICES) {
      expect({ service: service.id, id: PROVIDER_ID.test(service.id) }).toEqual({ service: service.id, id: true });
      // Stored as typed: with its version path, and no slash at its end for `/models` to be added to.
      expect(service.baseUrl).toMatch(/^https:\/\/[a-z0-9.-]+\/.*v1$/);
      expect(['openai', 'anthropic']).toContain(service.apiStyle);
      expect(service.displayName.trim()).toBe(service.displayName);
      expect(service.note.length).toBeGreaterThan(20);
      // The key is made on the service's own site, never somebody else's.
      const site = (url: string) => new URL(url).hostname.split('.').slice(-2).join('.');
      expect(new URL(service.keyUrl).protocol).toBe('https:');
      expect(site(service.keyUrl)).toBe(site(service.baseUrl));
    }
  });

  test('no two share an id or an address', () => {
    expect(new Set(KNOWN_SERVICES.map((service) => service.id)).size).toBe(KNOWN_SERVICES.length);
    expect(new Set(KNOWN_SERVICES.map((service) => service.baseUrl)).size).toBe(KNOWN_SERVICES.length);
  });

  test('the two that were asked for are there, by the addresses their own documentation gives', () => {
    const at = Object.fromEntries(KNOWN_SERVICES.map((service) => [service.id, [service.baseUrl, service.apiStyle, service.keyUrl]]));
    expect(at['opencode-zen']).toEqual(['https://opencode.ai/inference/openai/v1', 'openai', 'https://opencode.ai/console']);
    expect(at.commandcode).toEqual(['https://api.commandcode.ai/provider/v1', 'openai', 'https://commandcode.ai/settings/keys']);
    // OpenCode Go refuses a request with no session header, which a custom provider does not send: not offered.
    expect(KNOWN_SERVICES.some((service) => service.baseUrl.includes('/go/'))).toBe(false);
  });
});

describe('the service an address is', () => {
  test('is found however the address was typed: a slash at its end, a space around it', () => {
    const zen = KNOWN_SERVICES.find((service) => service.id === 'opencode-zen')!;
    expect(knownServiceAt(zen.baseUrl)).toBe(zen);
    expect(knownServiceAt(`  ${zen.baseUrl}/ `)).toBe(zen);
    expect(knownServiceAt(`${zen.baseUrl}//`)).toBe(zen);
  });

  test('is none for any other address, a longer one that begins the same, or nothing typed', () => {
    const zen = KNOWN_SERVICES.find((service) => service.id === 'opencode-zen')!;
    expect(knownServiceAt('https://api.deepseek.com/v1')).toBeUndefined();
    expect(knownServiceAt(`${zen.baseUrl}/extra`)).toBeUndefined();
    expect(knownServiceAt(zen.baseUrl.replace('https://', 'http://'))).toBeUndefined();
    expect(knownServiceAt('')).toBeUndefined();
    expect(knownServiceAt('   ')).toBeUndefined();
  });
});

describe('a form started from a service', () => {
  const form = { id: 'mine', displayName: 'Mine', baseUrl: 'https://example.test/v1', apiStyle: 'anthropic' as const, apiKey: 'typed-already', keyLabel: 'work', autoLoadModels: false };

  test('takes its id, name, address and style', () => {
    const service = KNOWN_SERVICES.find((one) => one.id === 'commandcode')!;
    expect(startFrom(form, service)).toMatchObject({ id: 'commandcode', displayName: 'Command Code', baseUrl: 'https://api.commandcode.ai/provider/v1', apiStyle: 'openai' });
  });

  test('keeps what the person typed that the service does not say, and leaves the form it was given as it was', () => {
    const service = KNOWN_SERVICES.find((one) => one.id === 'commandcode')!;
    const started = startFrom(form, service);
    expect({ apiKey: started.apiKey, keyLabel: started.keyLabel, autoLoadModels: started.autoLoadModels }).toEqual({ apiKey: 'typed-already', keyLabel: 'work', autoLoadModels: false });
    expect(form.id).toBe('mine');
    // And the address it now holds is the service's: the hint under the key follows from it.
    expect(knownServiceAt(started.baseUrl)).toBe(service);
  });
});
