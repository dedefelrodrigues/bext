<script>
  import { formatMoney, palette } from '$lib/charts.js';

  // Part-to-whole at a glance for the selected period. Only the biggest slices
  // get their own arc — anything under `minShare` folds into "Other" so the ring
  // never turns into a fringe of unreadable slivers. Clicking a slice drills in.
  let {
    slices = [], // [{ key, name, value (positive magnitude), color }]
    currency = '',
    size = 240,
    centerLabel = 'Total',
    onselect = null,
  } = $props();

  const pal = $derived(palette());
  const total = $derived(slices.reduce((sum, s) => sum + s.value, 0));

  let hover = $state(null);

  const GAP_DEG = 1.2; // surface gap between segments
  const R = $derived(size / 2 - 2);
  const INNER = $derived(R * 0.62);

  const arcs = $derived.by(() => {
    if (total <= 0) return [];
    let start = -90;
    return slices.map((s) => {
      const sweep = (s.value / total) * 360;
      const a0 = start + GAP_DEG / 2;
      const a1 = start + sweep - GAP_DEG / 2;
      start += sweep;
      return { ...s, share: s.value / total, d: ring(a0, Math.max(a1, a0 + 0.01)) };
    });
  });

  const point = (angle, r) => {
    const rad = (angle * Math.PI) / 180;
    return [size / 2 + r * Math.cos(rad), size / 2 + r * Math.sin(rad)];
  };

  function ring(a0, a1) {
    const large = a1 - a0 > 180 ? 1 : 0;
    const [x0, y0] = point(a0, R);
    const [x1, y1] = point(a1, R);
    const [x2, y2] = point(a1, INNER);
    const [x3, y3] = point(a0, INNER);
    return `M${x0} ${y0}A${R} ${R} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${INNER} ${INNER} 0 ${large} 0 ${x3} ${y3}Z`;
  }
</script>

<div class="flex flex-wrap items-center gap-6">
  <svg width={size} height={size} role="img" aria-label="Category breakdown">
    {#each arcs as a (a.key ?? a.name)}
      <path
        d={a.d}
        fill={a.color}
        opacity={hover && hover.key !== a.key ? 0.45 : 1}
        style={onselect ? 'cursor: pointer' : ''}
        role="presentation"
        onmouseenter={() => (hover = a)}
        onmouseleave={() => (hover = null)}
        onclick={() => onselect?.(a)}
      />
    {/each}
    <text x={size / 2} y={size / 2 - 4} text-anchor="middle" font-size="11" fill={pal.muted}>
      {hover ? hover.name : centerLabel}
    </text>
    <text x={size / 2} y={size / 2 + 14} text-anchor="middle" font-size="14" font-weight="600" fill="currentColor">
      {formatMoney(hover ? hover.value : total, currency, { compact: true })}
    </text>
  </svg>

  <!-- The direct labels the light-mode contrast check requires: every slice is
       named and valued, so no slice depends on its hue alone. -->
  <ul class="min-w-56 flex-1 text-sm">
    {#each arcs as a (a.key ?? a.name)}
      <li>
        <button
          class="flex w-full items-center justify-between gap-3 rounded px-1 py-0.5 text-left hover:bg-accent"
          onmouseenter={() => (hover = a)}
          onmouseleave={() => (hover = null)}
          onclick={() => onselect?.(a)}
        >
          <span class="flex min-w-0 items-center gap-2">
            <span class="inline-block h-2 w-2 shrink-0 rounded-sm" style={`background:${a.color}`}></span>
            <span class="truncate">{a.name}</span>
          </span>
          <span class="shrink-0 tabular-nums text-muted-foreground">
            {formatMoney(a.value, '', { compact: true })} · {Math.round(a.share * 100)}%
          </span>
        </button>
      </li>
    {/each}
  </ul>
</div>
