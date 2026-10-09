import { theme } from '$lib/theme.svelte.js';

// --- Chart palette ------------------------------------------------------
//
// Two selected palettes (not an automatic flip): each hue is stepped for the
// surface it renders on. Slot order is fixed and colors follow the entity, so
// filtering a category out never repaints the survivors. Validated against the
// card surfaces (#ffffff / #171717) for lightness band, chroma, CVD separation
// and contrast; the three light slots that fall under 3:1 are always
// accompanied by a legend label and the table view, which is the relief the
// contrast check requires.

const CATEGORICAL_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const CATEGORICAL_DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];

// Money in vs. money out is polarity, so it gets the diverging warm/cool poles
// rather than two arbitrary categorical slots.
const POLAR_LIGHT = { income: '#2a78d6', expense: '#e34948' };
const POLAR_DARK = { income: '#3987e5', expense: '#e66767' };

const CHROME_LIGHT = { grid: '#e1e0d9', axis: '#c3c2b7', muted: '#898781', other: '#9a9891' };
const CHROME_DARK = { grid: '#2c2c2a', axis: '#383835', muted: '#898781', other: '#8a8880' };

// Reactive in a Svelte component ($derived picks up the theme store).
export function palette() {
  const dark = theme.value === 'dark';
  return {
    dark,
    categorical: dark ? CATEGORICAL_DARK : CATEGORICAL_LIGHT,
    polar: dark ? POLAR_DARK : POLAR_LIGHT,
    ...(dark ? CHROME_DARK : CHROME_LIGHT),
  };
}

// A category keeps its hue for the life of a chart set: the color comes from the
// entity's position in a stable key list, never from its current rank. The 9th
// and beyond are never generated — the server already folds the tail into
// "Other", which takes the neutral.
export function colorFor(key, keys, pal) {
  if (key === null || key === undefined) return pal.other;
  const idx = keys.indexOf(key);
  return idx >= 0 && idx < pal.categorical.length ? pal.categorical[idx] : pal.other;
}

// --- Formatting ---------------------------------------------------------

export function formatMoney(cents, currency, { compact = false } = {}) {
  const value = cents / 100;
  const opts = compact
    ? { notation: 'compact', maximumFractionDigits: 1 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  const formatted = new Intl.NumberFormat(undefined, opts).format(value);
  return currency ? `${formatted} ${currency}` : formatted;
}

export function monthLabel(ym, { long = false } = {}) {
  const [y, m] = ym.split('-');
  const date = new Date(Number(y), Number(m) - 1, 1);
  const month = date.toLocaleString(undefined, { month: 'short' });
  return long ? `${month} ${y}` : month;
}

// --- Scales -------------------------------------------------------------

// Axis ticks on 1/2/2.5/5×10ⁿ steps, covering [min, max] and always including
// zero. The step is the smallest candidate that still fits in `count` intervals,
// so the axis doesn't overshoot the data with an empty band at the top.
export function niceTicks(min, max, count = 4) {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  if (hi === lo) return { ticks: [0], min: 0, max: 1 };

  const magnitude = 10 ** Math.floor(Math.log10((hi - lo) / count));
  const candidates = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10, 15, 20].map((m) => m * magnitude);
  // Values are integer minor units, so a sub-unit step would only produce
  // duplicate labels once rounded.
  const step = Math.max(1, candidates.find((s) => Math.ceil(hi / s) - Math.floor(lo / s) <= count) ?? candidates[candidates.length - 1]);

  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let t = start; t <= end + step / 2; t += step) ticks.push(Math.round(t));
  return { ticks, min: start, max: end };
}
