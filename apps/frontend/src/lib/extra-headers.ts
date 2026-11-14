/**
 * A custom provider's extra headers as its form holds them: one on each line, `Name: value`.
 *
 * A saved header's value is never sent to the page (it may be a key), so its line has nothing after the colon, and a
 * line sent back that way keeps the value that is saved. The one value shown is `{session}`, which is no secret: it
 * is where the gateway writes the conversation's id on each request, for a service that asks for one.
 */

/** The lines a form opens with: a provider's saved headers, or what a known service asks for. */
export function headersToText(headers: Record<string, string | null> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([name, value]) => (value === null ? `${name}:` : `${name}: ${value}`))
    .join('\n');
}

/** What a save sends: every header the lines name, a line with no value as "keep the saved one". */
export function headersFromText(text: string): Record<string, string | null> {
  const headers: Record<string, string | null> = {};
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const colon = line.indexOf(':');
    const name = (colon < 0 ? line : line.slice(0, colon)).trim();
    const value = colon < 0 ? '' : line.slice(colon + 1).trim();
    headers[name] = value === '' ? null : value;
  }
  return headers;
}
