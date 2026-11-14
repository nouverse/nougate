import { describe, expect, test } from 'bun:test';

/**
 * A custom provider's extra headers as its form holds them: lines of `Name: value`, read back into what a save sends.
 * A saved value never reaches the page, so its line is the name alone, and a name sent alone keeps the saved value: a
 * line read wrongly here would either drop a key or send a header's name as its value.
 */

const { headersFromText, headersToText } = await import('@/lib/extra-headers');

describe("a provider's headers as lines", () => {
  test('each on its own line as Name: value; a saved one whose value is not shown as its name and a colon', () => {
    expect(headersToText({ 'x-opencode-session': '{session}', 'x-gateway-key': null })).toBe('x-opencode-session: {session}\nx-gateway-key:');
    expect(headersToText({})).toBe('');
    expect(headersToText(undefined)).toBe('');
  });
});

describe('the lines as what a save sends', () => {
  test('a name with its value; a name with nothing after the colon, or no colon at all, as one to keep', () => {
    expect(headersFromText('x-opencode-session: {session}\nx-gateway-key:\nx-bare')).toEqual({ 'x-opencode-session': '{session}', 'x-gateway-key': null, 'x-bare': null });
  });

  test('a value keeps its own colons and inner spaces; what is around the name and the value is trimmed; blank lines are nothing', () => {
    expect(headersFromText('  HTTP-Referer :  https://example.test/a b  \n\n   \nx-time: 10:30')).toEqual({ 'HTTP-Referer': 'https://example.test/a b', 'x-time': '10:30' });
    expect(headersFromText('')).toEqual({});
  });

  test('what the form opened with comes back as it was: a saved value kept, the shown one sent again', () => {
    const saved = { 'x-gateway-key': null, 'x-opencode-session': '{session}' };
    expect(headersFromText(headersToText(saved))).toEqual(saved);
  });
});
