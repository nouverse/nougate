import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempDir = mkdtempSync(join(tmpdir(), 'nougate-calib-'));
process.env.CALIBRATION_FILE = join(tempDir, 'calibration.json');

const { calibrate, getCalibration, recordActualTokens, resetCalibration } = await import(
  '@/core/metrics/calibrator'
);

/**
 * The calibrator exists because a fixed ~4-chars-per-token estimate is wrong by
 * a consistent amount for any given workload. When an upstream reports real
 * usage, the gap is a free measurement; the factor is that gap, smoothed.
 *
 * The risk it has to avoid is being *confidently* wrong — moving estimates on
 * three samples, or letting one pathological payload skew everything after it.
 */

afterEach(() => resetCalibration());

/** Feed n samples where the truth is `ratio`× our estimate. */
function train(samples: number, estimate: number, ratio: number) {
  for (let i = 0; i < samples; i += 1) {
    recordActualTokens(estimate, Math.round(estimate * ratio));
  }
}

describe('learning', () => {
  test('does nothing until it has seen enough', () => {
    train(5, 1000, 1.5);

    // Five samples is not evidence. Correcting here would be worse than not
    // correcting at all.
    expect(getCalibration().active).toBe(false);
    expect(calibrate(1000)).toBe(1000);
  });

  test('moves the estimate toward the truth once it has evidence', () => {
    // Our estimate reads 1000 where the upstream reports 1500 every time.
    train(40, 1000, 1.5);

    const state = getCalibration();
    expect(state.active).toBe(true);
    expect(state.factor).toBeGreaterThan(1);

    // Closer to 1500 than the uncorrected 1000 — that is the whole point.
    const corrected = calibrate(1000);
    expect(Math.abs(corrected - 1500)).toBeLessThan(Math.abs(1000 - 1500));
  });

  test('corrects downward too', () => {
    train(40, 1000, 0.7);
    expect(getCalibration().factor).toBeLessThan(1);
    expect(calibrate(1000)).toBeLessThan(1000);
  });
});

describe('refusing to be confidently wrong', () => {
  test('the factor stays inside a sane band', () => {
    // A stream of absurd observations must refine the estimate, never replace
    // it with something 10x out.
    train(200, 1000, 50);
    expect(getCalibration().factor).toBeLessThanOrEqual(3);

    resetCalibration();
    train(200, 1000, 0.001);
    expect(getCalibration().factor).toBeGreaterThanOrEqual(0.5);
  });

  test('one outlier cannot swing a trained factor', () => {
    train(60, 1000, 1.2);
    const before = getCalibration().factor;

    recordActualTokens(1000, 100_000); // a single pathological payload
    const after = getCalibration().factor;

    expect(Math.abs(after - before)).toBeLessThan(0.35);
  });

  test('ignores samples too small to carry signal', () => {
    // A 10-token payload rounds badly enough to be noise, and dividing by it
    // makes the ratio explode.
    for (let i = 0; i < 50; i += 1) {
      recordActualTokens(10, 500);
    }
    expect(getCalibration().samples).toBe(0);
    expect(calibrate(1000)).toBe(1000);
  });

  test('ignores garbage input rather than poisoning the factor', () => {
    recordActualTokens(Number.NaN, 100);
    recordActualTokens(1000, Number.POSITIVE_INFINITY);
    recordActualTokens(1000, 0);
    recordActualTokens(1000, -5);

    expect(getCalibration().samples).toBe(0);
  });
});

describe('the feedback loop stays honest', () => {
  test('a perfectly accurate estimator is left alone', () => {
    train(60, 1000, 1);

    // Nothing to fix, so nothing should move.
    expect(getCalibration().factor).toBeCloseTo(1, 1);
    expect(calibrate(1234)).toBe(1234);
  });
});

rmSync(tempDir, { recursive: true, force: true });
