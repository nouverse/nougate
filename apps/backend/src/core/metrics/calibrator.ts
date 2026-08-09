import { dataPath } from '@/core/paths';
import { createStateFileWriter } from '@/core/state-file';

/**
 * Self-correcting token estimation.
 *
 * The character-count estimate is only ever a stand-in for real usage, but it
 * decides real things: what a request without an upstream `usage` block costs,
 * and how much compression is credited with saving. A fixed 4-chars-per-token
 * is wrong by a different amount for prose, code, JSON and CJK, and wrong in a
 * consistent direction for a given workload.
 *
 * So when an upstream *does* report real numbers, the gap between our estimate
 * and the truth is a free measurement. Averaging that gap over time gives a
 * factor that pulls the estimate toward whatever this deployment actually
 * sends.
 */

/** Below this many samples the factor is not trusted and 1.0 is used. */
const MIN_SAMPLES = 20;

/** Recalculate this often; every sample would be churn for no accuracy. */
const RECALIBRATE_EVERY = 10;

/**
 * Clamp range for the factor.
 *
 * A calibrated estimate should refine the guess, never replace it with
 * something wild — a handful of pathological payloads must not send every
 * future estimate 10× out.
 */
const MIN_FACTOR = 0.5;
const MAX_FACTOR = 3;

/** Weight given to the new observation. Low, so the factor moves smoothly. */
const SMOOTHING = 0.3;

interface CalibrationState {
  factor: number;
  samples: number;
  /** Running totals, so the factor survives a restart with its history. */
  totalEstimated: number;
  totalActual: number;
}

const STATE_FILE = process.env.CALIBRATION_FILE || dataPath('calibration.json');

const initial: CalibrationState = { factor: 1, samples: 0, totalEstimated: 0, totalActual: 0 };
let state: CalibrationState = { ...initial };
let sinceRecalibration = 0;

const writer = createStateFileWriter<CalibrationState>(STATE_FILE, {
  label: 'token calibration',
});

/**
 * Load the persisted factor. Safe to call more than once.
 */
export async function initCalibration(): Promise<void> {
  try {
    const file = Bun.file(STATE_FILE);
    if (await file.exists()) {
      const loaded = (await file.json()) as Partial<CalibrationState>;
      const factor = Number(loaded.factor);
      state = {
        factor: Number.isFinite(factor) ? clamp(factor) : 1,
        samples: Number(loaded.samples) || 0,
        totalEstimated: Number(loaded.totalEstimated) || 0,
        totalActual: Number(loaded.totalActual) || 0,
      };
    }
  } catch (error) {
    console.warn('[Calibration] Could not read stored factor, starting fresh:', error);
    state = { ...initial };
  }
}

function clamp(value: number): number {
  return Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, value));
}

/**
 * Record one observation: what we guessed, and what the upstream said.
 *
 * Only call this with real reported usage. Feeding an estimate back in would
 * make the factor converge on its own output.
 */
export function recordActualTokens(estimated: number, actual: number): void {
  if (!Number.isFinite(estimated) || !Number.isFinite(actual)) {
    return;
  }
  // A near-zero estimate makes the ratio explode; it also carries no signal.
  if (estimated < 50 || actual <= 0) {
    return;
  }

  state.totalEstimated += estimated;
  state.totalActual += actual;
  state.samples += 1;
  sinceRecalibration += 1;

  if (state.samples >= MIN_SAMPLES && sinceRecalibration >= RECALIBRATE_EVERY) {
    // Computed from the running totals rather than the last sample, so one
    // unusual payload cannot swing it.
    const observed = state.totalActual / state.totalEstimated;
    state.factor = clamp(state.factor * (1 - SMOOTHING) + observed * SMOOTHING);
    sinceRecalibration = 0;
  }

  writer.schedule(state);
}

/**
 * Apply the learned correction to a raw estimate.
 *
 * Returns the estimate unchanged until enough samples exist to justify moving
 * it — an early guess based on three requests is worse than no correction.
 */
export function calibrate(rawEstimate: number): number {
  if (state.samples < MIN_SAMPLES) {
    return rawEstimate;
  }
  return Math.round(rawEstimate * state.factor);
}

/** Current state, for the dashboard and for tests. */
export function getCalibration(): CalibrationState & { active: boolean } {
  return { ...state, active: state.samples >= MIN_SAMPLES };
}

/** Reset everything. Tests only. */
export function resetCalibration(): void {
  state = { ...initial };
  sinceRecalibration = 0;
}
