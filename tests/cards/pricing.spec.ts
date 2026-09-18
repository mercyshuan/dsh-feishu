/**
 * Unit tests for the CNY token pricing that feeds the finished card's cost
 * group: the DeepSeek peak/off-peak (and weekend-all-off-peak) tier rules, the
 * per-bucket math, and the display formatting.
 */

import { describe, expect, it } from 'vitest';
import {
  formatRmb,
  isPeakHour,
  isWeekendOffPeak,
  priceTierFor,
  rmbCostForUsage,
} from '../../src/cards/pricing.js';

/** Mon 2026-09-21 02:00 UTC — inside the 01:00-04:00 peak window. */
const MONDAY_PEAK = Date.parse('2026-09-21T02:00:00Z');
/** Mon 2026-09-21 05:00 UTC — between the two peak windows. */
const MONDAY_OFF_PEAK = Date.parse('2026-09-21T05:00:00Z');
/** Sat 2026-09-19 02:00 UTC — a peak window, but the weekend rule wins. */
const SATURDAY_PEAK_WINDOW = Date.parse('2026-09-19T02:00:00Z');

describe('peak / off-peak tiers', () => {
  it('flags the weekday peak windows', () => {
    expect(isPeakHour(MONDAY_PEAK)).toBe(true);
    expect(isPeakHour(MONDAY_OFF_PEAK)).toBe(false);
  });

  it('bills the whole Beijing weekend at the off-peak tier', () => {
    expect(isWeekendOffPeak(SATURDAY_PEAK_WINDOW)).toBe(true);
    expect(isPeakHour(SATURDAY_PEAK_WINDOW)).toBe(false);
  });

  it('prices flash at the peak/off-peak tiers from the DeepSeek CNY table', () => {
    expect(priceTierFor('deepseek-v4-flash', MONDAY_OFF_PEAK)).toEqual({
      cacheHit: 0.05,
      cacheMiss: 1.5,
      output: 4.5,
    });
    expect(priceTierFor('deepseek-v4-flash', MONDAY_PEAK)).toEqual({
      cacheHit: 0.1,
      cacheMiss: 3,
      output: 9,
    });
  });

  it('falls back to the flash tier for an unknown model', () => {
    expect(priceTierFor('some-other-model', MONDAY_OFF_PEAK)).toEqual({
      cacheHit: 0.05,
      cacheMiss: 1.5,
      output: 4.5,
    });
  });
});

describe('rmbCostForUsage', () => {
  it('prices each bucket at its own rate (off-peak)', () => {
    const cost = rmbCostForUsage(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      'deepseek-v4-flash',
      MONDAY_OFF_PEAK,
    );
    // 1M miss (¥1.5) + 1M output (¥4.5).
    expect(cost).toBeCloseTo(6, 6);
  });

  it('bills cache reads and cache writes at the cache-hit rate', () => {
    const cost = rmbCostForUsage(
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 },
      'deepseek-v4-flash',
      MONDAY_OFF_PEAK,
    );
    expect(cost).toBeCloseTo(0.1, 6);
  });

  it('doubles the amount inside a peak window', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const offPeak = rmbCostForUsage(usage, 'deepseek-v4-flash', MONDAY_OFF_PEAK);
    const peak = rmbCostForUsage(usage, 'deepseek-v4-flash', MONDAY_PEAK);
    expect(peak).toBeCloseTo(offPeak * 2, 6);
  });

  it('never returns NaN or a negative amount', () => {
    expect(
      rmbCostForUsage(
        { inputTokens: -5, outputTokens: Number.NaN, cacheReadTokens: 0, cacheWriteTokens: 0 },
        'deepseek-v4-flash',
        MONDAY_OFF_PEAK,
      ),
    ).toBe(0);
  });
});

describe('formatRmb', () => {
  it('renders two decimals for a normal amount', () => {
    expect(formatRmb(1.5)).toBe('¥1.50');
    expect(formatRmb(0.25)).toBe('¥0.25');
  });

  it('widens a sub-cent amount so it never reads as zero', () => {
    expect(formatRmb(0.0012)).toBe('¥0.0012');
    expect(formatRmb(0)).toBe('¥0.00');
  });
});
