import { theme } from '$lib/theme.svelte.js';

// --- Category colours ---------------------------------------------------
//
// A stable hue per category, so a transaction's category is recognizable
// before its label is read. The mapping is `id * 7 % 16`: it never moves.
// Deriving it from the category's position in a sorted list would have looked
// tidier, but deleting one category would then repaint every category after
// it, and a colour you have learned is only useful while it stays put.
//
// The stride is why it is not plain `id % 16`. The palette runs around the hue
// wheel, so consecutive ids would take neighbouring hues, and seeded categories
// have consecutive ids — Income and Food & Drink came out green and teal, which
// is exactly the pair you need to tell apart at a glance. 7 is coprime with 16,
// so multiplying still visits all sixteen slots, but each step jumps halfway
// around the wheel.
//
// Two hand-stepped lists rather than one flipped automatically, for the same
// reason as the chart palette: each hue is stepped for the surface it sits on
// (#ffffff / #171717). These are 13px stroked glyphs and 10px swatches next to
// a text label, so the colour is redundant coding — the name always carries
// the meaning — and the bar is separation between neighbours, not contrast.
//
// Deliberately NOT the chart palette in `charts.js`: that one colours by a
// category's *rank within one chart* (8 slots, the tail folded into "Other"),
// which is a different job and cannot produce a stable per-category hue.

const LIGHT = [
  '#d13b3b', // red
  '#d2621f', // orange
  '#b57500', // amber
  '#8a7a10', // olive gold
  '#5f8010', // lime
  '#1f8a3c', // green
  '#0e8f6a', // emerald
  '#0e8c9a', // teal
  '#1f7fb8', // sky
  '#2a68d6', // blue
  '#4a3aa7', // indigo
  '#6d3fc4', // violet
  '#9333ea', // purple
  '#b8309e', // magenta
  '#c43a72', // pink
  '#8a5a3c', // brown
];

const DARK = [
  '#ef7070',
  '#ef8b4f',
  '#d9a032',
  '#c2b23f',
  '#9fbd4f',
  '#4cc26d',
  '#35c39b',
  '#33bdcd',
  '#4fb0e8',
  '#6f9ff0',
  '#9d92ef',
  '#b48ef5',
  '#c78ef0',
  '#e07cd0',
  '#ea7fa3',
  '#c69a7c',
];

// Reactive in a component ($derived picks up the theme store).
export function categoryPalette() {
  return theme.value === 'dark' ? DARK : LIGHT;
}

// The colour for a category id, or null when there is no category — an
// uncategorized row stays neutral on purpose, so it reads as the gap it is.
export function categoryColor(categoryId, palette) {
  if (categoryId === null || categoryId === undefined || categoryId === '') return null;
  const n = Number(categoryId);
  if (!Number.isFinite(n)) return null;
  const size = palette.length;
  const slot = Math.trunc(n) * 7;
  return palette[((slot % size) + size) % size];
}
