/**
 * DeepSeek CNY token pricing: the one place the surface turns counted tokens
 * into the RMB figure printed on a finished card's stats line.
 *
 * WHY THIS EXISTS — dsh has no concept of money: `dsh-token-meter` reports
 * context pressure and `dsh-session-stats` reports counts and wall times, and
 * neither carries a price. The off-the-shelf accounting plugin (`dsh-cost-meter`)
 * runs in the DESKTOP deployment's own process and its ledger does not cover
 * this surface (a separate dsh process with its own `DSH_HOME`), so the only
 * way a dsh-feishu card can show an amount is to price the tokens it already
 * counts itself.
 *
 * The table and the tier rules below mirror `dsh-cost-meter`'s
 * `lib/pricing.js` (official DeepSeek CNY page: off-peak / peak tiers, the
 * peak windows, and the weekend-all-off-peak rule), so the figure here reads
 * the same as the desktop ledger's for the same tokens. Keep them in step:
 * an official price change updates this table (and its `checkedAt` note).
 *
 * Amounts are CNY per 1M tokens, exactly like the official page; the surface
 * therefore never converts currency.
 *
 * @module @dsh-feishu/dsh-feishu/cards/pricing
 */

/** One tier's three token buckets, CNY / 1M tokens. Cache writes bill at the
 *  cache-hit price (the official page does not list a separate write rate). */
export interface PriceTier {
  /** Cache-hit input tokens (¥ / 1M). */
  readonly cacheHit: number;
  /** Cache-miss input tokens (¥ / 1M). */
  readonly cacheMiss: number;
  /** Output tokens (¥ / 1M). */
  readonly output: number;
}

/** One model's pricing: a base tier plus the peak/off-peak pair. */
export interface ModelPrice extends PriceTier {
  /** Off-peak tier (the base figures, also the fallback tier). */
  readonly offPeak: PriceTier;
  /** Peak tier (exactly twice the off-peak tier on the official page). */
  readonly peak: PriceTier;
}

/**
 * The shipped DeepSeek CNY price table (¥ / 1M tokens), mirroring the official
 * Chinese pricing page as read on 2026-09-18 and `dsh-cost-meter`'s
 * `DEFAULT_PRICE_TABLE_CNY`. `flash-vision-exp` shares flash's rates.
 */
export const DEEPSEEK_CNY_PRICES: Readonly<Record<string, ModelPrice>> = {
  'deepseek-v4-flash': {
    cacheHit: 0.05,
    cacheMiss: 1.5,
    output: 4.5,
    offPeak: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 },
    peak: { cacheHit: 0.1, cacheMiss: 3, output: 9 },
  },
  'deepseek-v4-pro': {
    cacheHit: 0.15,
    cacheMiss: 4.5,
    output: 13.5,
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  },
  'deepseek-v4-flash-vision-exp': {
    cacheHit: 0.05,
    cacheMiss: 1.5,
    output: 4.5,
    offPeak: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 },
    peak: { cacheHit: 0.1, cacheMiss: 3, output: 9 },
  },
};

/** Fallback tier for a model the table does not name (flash rates — the
 *  deployment's usual model, and the cheapest published DeepSeek tier). */
export const DEFAULT_CNY_TIER: ModelPrice = {
  cacheHit: 0.05,
  cacheMiss: 1.5,
  output: 4.5,
  offPeak: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 },
  peak: { cacheHit: 0.1, cacheMiss: 3, output: 9 },
};

/** Peak-hour windows (UTC hours, half-open `[start, end)`). */
const PEAK_WINDOWS: readonly { readonly start: number; readonly end: number }[] = [
  { start: 1, end: 4 },
  { start: 6, end: 10 },
];

/** Weekend-all-off-peak took effect at 2026-08-23 00:00 Beijing (UTC+8). */
const WEEKEND_OFFPEAK_EFFECTIVE_AT = Date.parse('2026-08-22T16:00:00Z');

/**
 * Whether `atMs` falls in the weekend-off-peak zone (a Beijing-calendar
 * Saturday or Sunday after the rule took effect). `getUTCDay()` is already the
 * Beijing weekday because the civil day is `UTC + 8h`.
 * @param atMs - the billing instant (epoch ms).
 * @returns true when the whole day bills at the off-peak tier.
 */
export function isWeekendOffPeak(atMs: number): boolean {
  if (!Number.isFinite(atMs) || atMs < WEEKEND_OFFPEAK_EFFECTIVE_AT) return false;
  const weekday = new Date(atMs).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/**
 * Whether `atMs` bills at the peak tier: inside a peak window and NOT in the
 * weekend zone (the weekend rule outranks the windows).
 * @param atMs - the billing instant (epoch ms).
 * @returns true for a peak-tier instant.
 */
export function isPeakHour(atMs: number): boolean {
  if (!Number.isFinite(atMs)) return false;
  if (isWeekendOffPeak(atMs)) return false;
  const hour = new Date(atMs).getUTCHours();
  return PEAK_WINDOWS.some((window) => hour >= window.start && hour < window.end);
}

/**
 * Resolve the tier a model bills at for one instant.
 * @param model - the model id the tokens were billed to (may be a bare name).
 * @param atMs - the billing instant (epoch ms).
 * @returns the tier to apply.
 */
export function priceTierFor(model: string | undefined, atMs: number): PriceTier {
  const entry = (model === undefined ? undefined : DEEPSEEK_CNY_PRICES[model]) ?? DEFAULT_CNY_TIER;
  return isPeakHour(atMs) ? entry.peak : entry.offPeak;
}

/** The four counted token buckets one session accumulated. */
export interface UsageBuckets {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

/**
 * Price a session's counted tokens in CNY. Cache writes bill at the cache-hit
 * rate; cache reads likewise. A finite, non-negative result is guaranteed —
 * malformed input prices as 0 rather than poisoning the card with NaN.
 * @param usage - the session's accumulated token buckets.
 * @param model - the model id as reported by the deployment (may be absent).
 * @param atMs - the billing instant (epoch ms).
 * @returns the amount in CNY.
 */
export function rmbCostForUsage(
  usage: UsageBuckets,
  model: string | undefined,
  atMs: number,
): number {
  const tier = priceTierFor(model, atMs);
  const num = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0);
  const cost =
    (num(usage.inputTokens) * tier.cacheMiss +
      num(usage.outputTokens) * tier.output +
      (num(usage.cacheReadTokens) + num(usage.cacheWriteTokens)) * tier.cacheHit) /
    1_000_000;
  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}

/**
 * Format an RMB amount for the card stats line. Two decimals normally; a
 * sub-cent amount widens to four so a cheap turn never renders as `¥0`.
 * @param amount - the amount in CNY.
 * @returns the formatted amount, e.g. `¥0.0123`.
 */
export function formatRmb(amount: number): string {
  const value = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const text = value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2);
  return `¥${text}`;
}
