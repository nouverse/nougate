import { describe, expect, test } from 'bun:test';

/**
 * The backend buckets hourly usage with `at time zone 'UTC'`, but every other
 * timestamp on the dashboard is printed in the viewer's zone. Reading the digits
 * out of the bucket key made the trend chart claim the last request landed at
 * 11:00 while "Recent requests" showed 6:38 PM — the same seven hours, twice.
 */

process.env.TZ = 'Asia/Jakarta';

const { formatPeriod, formatPeriodLong } = await import('@/lib/format');
const { indexAtScreenX } = await import('@/components/metrics/TrendChart');

describe('bucket labels', () => {
  test('an hourly bucket is the UTC instant, shown locally', () => {
    expect(formatPeriod('2026-08-09T11:00')).toBe('18:00');
    expect(formatPeriodLong('2026-08-09T11:00')).toBe('2026-08-09 18:00');
  });

  test('the local day rolls over when the UTC hour does not', () => {
    // 17:00Z is midnight in Jakarta — the next day, not the same one.
    expect(formatPeriodLong('2026-08-09T17:00')).toBe('2026-08-10 00:00');
  });

  test('a daily bucket keeps its UTC date', () => {
    // A day bucket has no instant to convert; shifting it would relabel the day.
    expect(formatPeriod('2026-08-09')).toBe('09/08');
    expect(formatPeriodLong('2026-08-09')).toBe('2026-08-09');
  });
});

/**
 * The chart is an 800×240 viewBox in an element that is a fixed 240px tall and as
 * wide as the card — so `preserveAspectRatio` draws it at 1:1 and centres it, with
 * dead space either side. Reading the pointer as a fraction of the element width
 * ignored that offset and pushed the end buckets out of reach.
 */
describe('trend chart hover mapping', () => {
  const LEFT = 52; // PADDING.left
  const PLOT = 732; // 800 - 52 - 16
  const BUCKETS = 7; // the 05:00–11:00 window from the report

  // Card 1450px wide at viewport x=20: scale 1, content pushed right by 325px.
  const ctm = { a: 1, e: 20 + (1450 - 800) / 2 };
  const screenX = (userX: number) => ctm.e + userX * ctm.a;
  const pointOf = (index: number) => screenX(LEFT + (index / (BUCKETS - 1)) * PLOT);

  test('every drawn point is hoverable, including the first and the last', () => {
    for (let index = 0; index < BUCKETS; index += 1) {
      expect(indexAtScreenX(ctm, pointOf(index), BUCKETS)).toBe(index);
    }
  });

  test('a point between two buckets snaps to the nearer one', () => {
    expect(indexAtScreenX(ctm, screenX(LEFT + PLOT * 0.51), BUCKETS)).toBe(3);
  });

  test('the dead space either side clamps to an end bucket', () => {
    expect(indexAtScreenX(ctm, 20, BUCKETS)).toBe(0);
    expect(indexAtScreenX(ctm, 1470, BUCKETS)).toBe(BUCKETS - 1);
  });

  test('a single bucket is always index 0, and no transform means no hover', () => {
    expect(indexAtScreenX(ctm, 400, 1)).toBe(0);
    expect(indexAtScreenX(null, 400, BUCKETS)).toBeNull();
  });
});
