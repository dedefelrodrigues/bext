// Curated, lucide-style monochrome icon pool for categories and subcategories.
// Each icon is an array of primitive shapes so it renders reliably inside an SVG
// namespace (see CategoryIcon.svelte). Shapes:
//   ['path', d]
//   ['circle', cx, cy, r]
//   ['line', x1, y1, x2, y2]
//   ['rect', x, y, w, h, rx?]
//   ['polyline', points]
//   ['polygon', points]
// All authored on a 24x24 viewBox, stroked with currentColor so they recolor in
// dark mode. Icon *names* are the strings stored in categories.icon /
// subcategories.icon; the server seeder (server/src/db/seed.js) references the
// same names for its defaults, so keep the two in sync.

export const CATEGORY_ICONS = {
  landmark: [
    ['line', 3, 21, 21, 21],
    ['line', 5, 21, 5, 10],
    ['line', 9, 21, 9, 10],
    ['line', 15, 21, 15, 10],
    ['line', 19, 21, 19, 10],
    ['polygon', '12 3 20 8 4 8'],
  ],
  home: [
    ['path', 'm3 10 9-7 9 7'],
    ['path', 'M5 9v12h14V9'],
    ['path', 'M10 21v-6h4v6'],
  ],
  wrench: [
    ['path', 'M15 4a4 4 0 0 0-3.5 6L4 17.5 6.5 20l7.5-7.5A4 4 0 0 0 20 9l-2.6 2.6-3-3z'],
  ],
  hammer: [
    ['path', 'M14 3 21 10l-3 3-7-7z'],
    ['path', 'M12.5 6.5 3 16v0l5 5 9.5-9.5'],
  ],
  utensils: [
    ['line', 6, 2, 6, 22],
    ['line', 4, 2, 4, 7],
    ['line', 8, 2, 8, 7],
    ['path', 'M4 7a2 2 0 0 0 4 0'],
    ['line', 18, 2, 18, 22],
    ['path', 'M18 2c2.5 1.5 3 5 1 8h-1'],
  ],
  coffee: [
    ['path', 'M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z'],
    ['path', 'M17 9h2a2 2 0 0 1 0 5h-2'],
    ['line', 6, 2, 6, 4],
    ['line', 10, 2, 10, 4],
    ['line', 14, 2, 14, 4],
  ],
  'shopping-cart': [
    ['circle', 9, 20, 1],
    ['circle', 18, 20, 1],
    ['path', 'M2 3h2l2.5 12h11l2-8H6'],
  ],
  'shopping-bag': [
    ['path', 'M5 7h14l-1 13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1z'],
    ['path', 'M9 7V5a3 3 0 0 1 6 0v2'],
  ],
  wallet: [
    ['rect', 3, 6, 18, 13, 2],
    ['path', 'M3 10h18'],
    ['circle', 17, 13, 1],
  ],
  banknote: [
    ['rect', 2, 6, 20, 12, 2],
    ['circle', 12, 12, 2],
    ['path', 'M6 12h.01'],
    ['path', 'M18 12h.01'],
  ],
  'credit-card': [
    ['rect', 2, 5, 20, 14, 2],
    ['line', 2, 10, 22, 10],
  ],
  'piggy-bank': [
    ['path', 'M4 13a6 5 0 0 1 6-5h4a6 5 0 0 1 6 5v2a2 2 0 0 1-2 2v2h-3v-2h-4v2H8v-2a5 5 0 0 1-4-4z'],
    ['circle', 15, 12, 0.6],
    ['path', 'M4 12H3a1 1 0 0 1 0-3h1'],
    ['path', 'M9 8V7'],
  ],
  'arrow-left-right': [
    ['polyline', '8 3 4 7 8 11'],
    ['line', 4, 7, 20, 7],
    ['polyline', '16 13 20 17 16 21'],
    ['line', 20, 17, 4, 17],
  ],
  fuel: [
    ['path', 'M4 22V4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v18'],
    ['line', 3, 22, 15, 22],
    ['line', 4, 10, 14, 10],
    ['path', 'M14 9h2a2 2 0 0 1 2 2v5'],
  ],
  car: [
    ['path', 'M3 13.5 5 8a2 2 0 0 1 1.9-1.3h10.2A2 2 0 0 1 19 8l2 5.5'],
    ['path', 'M3 13.5h18V18h-3a2 2 0 0 1-4 0h-4a2 2 0 0 1-4 0H3z'],
    ['circle', 7, 18, 1],
    ['circle', 17, 18, 1],
  ],
  bus: [
    ['rect', 4, 4, 16, 13, 2],
    ['line', 4, 11, 20, 11],
    ['circle', 8, 18, 1.5],
    ['circle', 16, 18, 1.5],
  ],
  plane: [
    ['path', 'M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z'],
  ],
  bed: [
    ['path', 'M2 4v16'],
    ['path', 'M22 20v-6a2 2 0 0 0-2-2H2'],
    ['line', 2, 16, 22, 16],
    ['path', 'M5 12V9a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3'],
  ],
  briefcase: [
    ['rect', 2, 7, 20, 14, 2],
    ['path', 'M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
    ['line', 2, 13, 22, 13],
  ],
  building: [
    ['rect', 4, 2, 16, 20, 1],
    ['path', 'M9 6h.01'],
    ['path', 'M15 6h.01'],
    ['path', 'M9 10h.01'],
    ['path', 'M15 10h.01'],
    ['path', 'M9 14h.01'],
    ['path', 'M15 14h.01'],
    ['path', 'M10 22v-4h4v4'],
  ],
  activity: [['polyline', '3 12 7 12 10 5 14 19 17 12 21 12']],
  pill: [
    ['path', 'M10.5 20.5 3.5 13.5a5 5 0 0 1 7-7l7 7a5 5 0 0 1-7 7z'],
    ['line', 8.5, 8.5, 15.5, 15.5],
  ],
  dumbbell: [
    ['rect', 2, 9, 3, 6, 1],
    ['rect', 19, 9, 3, 6, 1],
    ['line', 5, 12, 19, 12],
    ['line', 7, 10, 7, 14],
    ['line', 17, 10, 17, 14],
  ],
  'graduation-cap': [
    ['path', 'M2 9l10-4 10 4-10 4z'],
    ['path', 'M6 11v4c0 1 2.7 2.5 6 2.5s6-1.5 6-2.5v-4'],
    ['line', 22, 9, 22, 14],
  ],
  shirt: [
    ['path', 'M15 3l5 3-2.5 3L15 7.5V21H9V7.5L6.5 9 4 6l5-3a3 3 0 0 0 6 0z'],
  ],
  gift: [
    ['rect', 3, 8, 18, 4],
    ['rect', 5, 12, 14, 9],
    ['line', 12, 8, 12, 21],
    ['path', 'M12 8C10 8 8 7 8 5.5A2.5 2.5 0 0 1 12 4a2.5 2.5 0 0 1 4 1.5C16 7 14 8 12 8z'],
  ],
  wifi: [
    ['path', 'M5 12.5a10 10 0 0 1 14 0'],
    ['path', 'M8.5 15.5a5 5 0 0 1 7 0'],
    ['circle', 12, 19, 0.5],
  ],
  droplet: [['path', 'M12 3l5.5 7.5A6.5 6.5 0 1 1 6.5 10.5z']],
  zap: [['polygon', '13 2 4 14 11 14 10 22 20 10 13 10']],
  flame: [
    ['path', 'M12 3c3 4 5 6 5 9a5 5 0 0 1-10 0c0-1.5.5-2.5 1.5-3.5C9 10 9 11 10 11c0-2 0-4 2-8z'],
  ],
  phone: [
    ['path', 'M5 4a1 1 0 0 1 1-1h2.2a1 1 0 0 1 1 .8l.7 3a1 1 0 0 1-.3 1L8 9.5a12 12 0 0 0 6 6l1.7-1.5a1 1 0 0 1 1-.3l3 .7a1 1 0 0 1 .8 1V18a2 2 0 0 1-2 2A16 16 0 0 1 5 6z'],
  ],
  smartphone: [
    ['rect', 7, 2, 10, 20, 2],
    ['line', 11, 18, 13, 18],
  ],
  scissors: [
    ['circle', 6, 6, 3],
    ['circle', 6, 18, 3],
    ['line', 8.1, 8.1, 20, 20],
    ['line', 8.1, 15.9, 20, 4],
  ],
  tree: [
    ['polygon', '12 2 17 10 7 10'],
    ['polygon', '12 7 18 16 6 16'],
    ['line', 12, 16, 12, 21],
    ['line', 9, 21, 15, 21],
  ],
  receipt: [
    ['path', 'M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1z'],
    ['line', 8, 7, 16, 7],
    ['line', 8, 11, 16, 11],
    ['line', 8, 15, 13, 15],
  ],
  tag: [
    ['path', 'M3 3h8l10 10-8 8L3 11z'],
    ['circle', 7.5, 7.5, 1.2],
  ],
  music: [
    ['circle', 6, 18, 2],
    ['circle', 17, 16, 2],
    ['line', 8, 18, 8, 6],
    ['line', 19, 16, 19, 4],
    ['path', 'M8 6l11-2v2L8 8'],
  ],
  film: [
    ['rect', 3, 3, 18, 18, 2],
    ['line', 7, 3, 7, 21],
    ['line', 17, 3, 17, 21],
    ['line', 3, 8, 7, 8],
    ['line', 3, 16, 7, 16],
    ['line', 17, 8, 21, 8],
    ['line', 17, 16, 21, 16],
    ['line', 3, 12, 21, 12],
  ],
  ticket: [
    ['path', 'M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2H5a2 2 0 0 1-2-2 2 2 0 0 0 0-4z'],
    ['line', 12, 6, 12, 7],
    ['line', 12, 11, 12, 13],
    ['line', 12, 17, 12, 18],
  ],
  star: [
    ['polygon', '12 2 15 9 22 9.5 17 14 18.5 21 12 17.5 5.5 21 7 14 2 9.5 9 9'],
  ],
  package: [
    ['path', 'M21 8v8a1 1 0 0 1-.5.9l-8 4.5a1 1 0 0 1-1 0l-8-4.5A1 1 0 0 1 3 16V8'],
    ['path', 'M3.3 7.5 12 12l8.7-4.5'],
    ['line', 12, 12, 12, 21.5],
    ['path', 'm3.3 7.5 8.7-4.9 8.7 4.9'],
  ],
  'map-pin': [
    ['path', 'M12 21c-4-5-7-8-7-11a7 7 0 0 1 14 0c0 3-3 6-7 11z'],
    ['circle', 12, 10, 2.5],
  ],
};

// Stable display order for the picker grid.
export const ICON_NAMES = Object.keys(CATEGORY_ICONS);
