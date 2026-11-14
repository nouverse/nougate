import { describe, expect, test } from 'bun:test';

/**
 * The services the add-provider form can start from, and the hint each carries. A wrong address makes a provider that
 * refuses every request with nothing to say why, and a wrong word about cost is a bill somebody did not expect: so
 * what the list holds is held to the form's own rules and to the kind of cost it says, the addresses are written out
 * here a second time as their services' own documentation gives them, and what a press does to the form is held too.
 */

const { COST_LABEL, KNOWN_SERVICES, creationOf, knownServiceAt, startFrom } = await import('@/lib/known-services');

/** The backend's rule for a provider id (`PROVIDER_ID_PATTERN`), which the form's field repeats. */
const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/;

describe('the known services', () => {
  test('are the ones a person is likely to mean, in this order', () => {
    expect(KNOWN_SERVICES.map((service) => service.displayName)).toEqual(['OpenAI', 'Anthropic', 'Google Gemini', 'DeepSeek', 'Z.ai', 'OpenCode Zen', 'OpenCode Go', 'Command Code']);
  });

  test('each holds what the form needs, in the form the backend takes', () => {
    for (const service of KNOWN_SERVICES) {
      expect({ service: service.id, id: PROVIDER_ID.test(service.id) }).toEqual({ service: service.id, id: true });
      // Stored as typed: no slash at its end, for `/models`, `/chat/completions` and `/messages` to be added to.
      expect({ service: service.id, at: new URL(service.baseUrl).protocol, slash: service.baseUrl.endsWith('/') }).toEqual({ service: service.id, at: 'https:', slash: false });
      expect(new URL(service.keyUrl).protocol).toBe('https:');
      expect(['openai', 'anthropic']).toContain(service.apiStyle);
      expect(service.displayName.trim()).toBe(service.displayName);
    }
  });

  test('no two share an id or an address', () => {
    expect(new Set(KNOWN_SERVICES.map((service) => service.id)).size).toBe(KNOWN_SERVICES.length);
    expect(new Set(KNOWN_SERVICES.map((service) => service.baseUrl)).size).toBe(KNOWN_SERVICES.length);
  });

  test("the addresses and key pages, as each service's own documentation gives them", () => {
    expect(Object.fromEntries(KNOWN_SERVICES.map((service) => [service.id, [service.apiStyle, service.baseUrl, service.keyUrl]]))).toEqual({
      openai: ['openai', 'https://api.openai.com/v1', 'https://platform.openai.com/api-keys'],
      anthropic: ['anthropic', 'https://api.anthropic.com/v1', 'https://platform.claude.com/settings/keys'],
      gemini: ['openai', 'https://generativelanguage.googleapis.com/v1beta/openai', 'https://aistudio.google.com/apikey'],
      deepseek: ['openai', 'https://api.deepseek.com/v1', 'https://platform.deepseek.com/api_keys'],
      zai: ['openai', 'https://api.z.ai/api/paas/v4', 'https://z.ai/manage-apikey/apikey-list'],
      'opencode-zen': ['openai', 'https://opencode.ai/inference/openai/v1', 'https://opencode.ai/console'],
      'opencode-go': ['openai', 'https://opencode.ai/inference/go/openai/v1', 'https://opencode.ai/console'],
      commandcode: ['openai', 'https://api.commandcode.ai/provider/v1', 'https://commandcode.ai/settings/keys'],
    });
  });

  test('each says what it costs in its first words, and the words agree with the kind of cost it is marked as', () => {
    for (const service of KNOWN_SERVICES) {
      const said =
        service.cost === 'included'
          ? /^Your .+ plan includes the key\b/.test(service.note)
          : /^(Charged per (use|request)|Free within its limits, then charged per use)\b/.test(service.note);
      expect({ service: service.id, cost: service.cost, said }).toEqual({ service: service.id, cost: service.cost, said: true });
    }
    expect(COST_LABEL).toEqual({ 'per-use': 'Pay per use', included: 'In your plan' });
  });

  test('what is part of a plan says nothing is charged outside it; what is charged by use says which subscription does not cover it', () => {
    const note = Object.fromEntries(KNOWN_SERVICES.map((service) => [service.id, service.note]));
    expect(KNOWN_SERVICES.filter((service) => service.cost === 'included').map((service) => service.id)).toEqual(['opencode-go', 'commandcode']);
    for (const plan of ['opencode-go', 'commandcode']) expect(note[plan]).toContain('nothing is charged outside it');
    // The one way a Go plan does charge outside it, and what OpenCode means the plan for.
    expect(note['opencode-go']).toContain('unless you turn on Extra Usage there');
    expect(note['opencode-go']).toContain('OpenCode means Go for coding agents');
    expect(note['opencode-zen']).toStartWith('Charged per request');
    expect(note.commandcode).toContain('Every plan but Go');
    expect(note.openai).toContain('A ChatGPT subscription does not cover it');
    expect(note.anthropic).toContain('apart from a Claude subscription');
    expect(note.zai).toContain('does not cover use from here');
  });

  test('a service that needs more than a key says what: the one here that asks for a header', () => {
    // OpenCode Go refuses a request with no session header on it.
    expect(Object.fromEntries(KNOWN_SERVICES.filter((service) => service.headers).map((service) => [service.id, service.headers]))).toEqual({
      'opencode-go': { 'x-opencode-session': '{session}' },
    });
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
    expect(knownServiceAt('https://openrouter.ai/api/v1')).toBeUndefined();
    expect(knownServiceAt(`${zen.baseUrl}/extra`)).toBeUndefined();
    expect(knownServiceAt(zen.baseUrl.replace('https://', 'http://'))).toBeUndefined();
    expect(knownServiceAt('')).toBeUndefined();
    expect(knownServiceAt('   ')).toBeUndefined();
  });
});

describe('a form started from a service', () => {
  const form = { id: 'mine', displayName: 'Mine', baseUrl: 'https://example.test/v1', apiStyle: 'anthropic' as const, extraHeaders: '', apiKey: 'typed-already', keyLabel: 'work', autoLoadModels: false };

  test('takes its id, name, address and style', () => {
    const service = KNOWN_SERVICES.find((one) => one.id === 'commandcode')!;
    expect(startFrom(form, service)).toMatchObject({ id: 'commandcode', displayName: 'Command Code', baseUrl: 'https://api.commandcode.ai/provider/v1', apiStyle: 'openai' });
    // The one that is talked to another way says so.
    expect(startFrom({ ...form, apiStyle: 'openai' as const }, KNOWN_SERVICES.find((one) => one.id === 'anthropic')!).apiStyle).toBe('anthropic');
  });

  test('keeps what the person typed that the service does not say, and leaves the form it was given as it was', () => {
    const service = KNOWN_SERVICES.find((one) => one.id === 'commandcode')!;
    const started = startFrom(form, service);
    expect({ apiKey: started.apiKey, keyLabel: started.keyLabel, autoLoadModels: started.autoLoadModels }).toEqual({ apiKey: 'typed-already', keyLabel: 'work', autoLoadModels: false });
    expect(form.id).toBe('mine');
    // And the address it now holds is the service's: the hint under the key follows from it.
    expect(knownServiceAt(started.baseUrl)).toBe(service);
  });

  test("takes the headers the service asks for into the field a person sees: OpenCode Go's, as a line", () => {
    const go = KNOWN_SERVICES.find((one) => one.id === 'opencode-go')!;
    expect(startFrom(form, go).extraHeaders).toBe('x-opencode-session: {session}');
  });

  test("a service that asks for none empties the field: one service's header does not stay on a form pointed at another", () => {
    const go = KNOWN_SERVICES.find((one) => one.id === 'opencode-go')!;
    const zen = KNOWN_SERVICES.find((one) => one.id === 'opencode-zen')!;
    expect(startFrom(startFrom(form, go), zen).extraHeaders).toBe('');
  });
});

describe('what the add form sends', () => {
  const typed = { id: 'mine', displayName: '', baseUrl: 'https://example.test/v1', apiStyle: 'openai' as const, extraHeaders: '', apiKey: '', keyLabel: '', autoLoadModels: true };
  const go = KNOWN_SERVICES.find((service) => service.id === 'opencode-go')!;

  test('is its fields: a name left empty is the id, and a key, a label or headers left empty are not sent', () => {
    expect(creationOf(typed)).toEqual({ id: 'mine', displayName: 'mine', baseUrl: 'https://example.test/v1', apiStyle: 'openai', apiKey: undefined, keyLabel: undefined, autoLoadModels: true });
    expect(creationOf({ ...typed, displayName: 'Mine', apiKey: 'typed-key', keyLabel: 'work', autoLoadModels: false })).toMatchObject({ displayName: 'Mine', apiKey: 'typed-key', keyLabel: 'work', autoLoadModels: false });
    expect(creationOf({ ...typed, extraHeaders: ' \n\n' })).not.toHaveProperty('extraHeaders');
  });

  test("a provider started from OpenCode Go is created with the header Go refuses a request without", () => {
    expect(creationOf(startFrom(typed, go))).toMatchObject({ id: 'opencode-go', baseUrl: go.baseUrl, extraHeaders: { 'x-opencode-session': '{session}' } });
  });

  test('the headers sent are the lines of the field as the person left them: one added, the filled one changed or removed', () => {
    const started = startFrom(typed, go);
    expect(creationOf({ ...started, extraHeaders: `${started.extraHeaders}\nHTTP-Referer: https://example.test` }).extraHeaders).toEqual({ 'x-opencode-session': '{session}', 'HTTP-Referer': 'https://example.test' });
    expect(creationOf({ ...started, extraHeaders: 'x-opencode-session: fixed-by-hand' }).extraHeaders).toEqual({ 'x-opencode-session': 'fixed-by-hand' });
    expect(creationOf({ ...started, extraHeaders: '' })).not.toHaveProperty('extraHeaders');
    // Typed by hand on any address: the field is what is sent, whatever the address is.
    expect(creationOf({ ...typed, extraHeaders: 'x-team: ops' }).extraHeaders).toEqual({ 'x-team': 'ops' });
  });
});
