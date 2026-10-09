<script>
  import { palette, formatMoney, niceTicks } from '$lib/charts.js';

  // A column chart in two modes: `stacked` (segments summed per label) and
  // grouped (one bar per series, side by side). Values are signed minor units —
  // negatives draw below the zero rule, which is what makes expenses read as
  // expenses without a second axis.
  let {
    labels = [],
    series = [],
    stacked = false,
    currency = '',
    height = 260,
    valueLabel = (cents) => formatMoney(cents, currency),
  } = $props();

  const pal = $derived(palette());

  let width = $state(720);
  let hover = $state(null); // { x, y, label, rows: [{ name, color, value }] }

  const PAD = { top: 12, right: 8, bottom: 28, left: 64 };
  const GAP = 2; // surface gap between adjacent/stacked marks
  const RADIUS = 4;

  const plotW = $derived(Math.max(width - PAD.left - PAD.right, 40));
  const plotH = $derived(Math.max(height - PAD.top - PAD.bottom, 40));

  // Extent: stacked sums the positive and negative arms separately so a mixed
  // column still fits; grouped just takes the biggest single bar.
  const extent = $derived.by(() => {
    let min = 0;
    let max = 0;
    labels.forEach((_, i) => {
      if (stacked) {
        let up = 0;
        let down = 0;
        for (const s of series) {
          const v = s.values[i] ?? 0;
          if (v >= 0) up += v;
          else down += v;
        }
        max = Math.max(max, up);
        min = Math.min(min, down);
      } else {
        for (const s of series) {
          const v = s.values[i] ?? 0;
          max = Math.max(max, v);
          min = Math.min(min, v);
        }
      }
    });
    return niceTicks(min, max);
  });

  const y = $derived((value) => {
    const { min, max } = extent;
    const span = max - min || 1;
    return PAD.top + plotH - ((value - min) / span) * plotH;
  });

  const band = $derived(plotW / Math.max(labels.length, 1));
  const barSlot = $derived(Math.min(band * 0.62, 48));

  // Show every nth label when months get dense, so ticks never collide.
  const labelStep = $derived(Math.max(1, Math.ceil(labels.length / Math.floor(plotW / 44))));

  function bars(i) {
    const x0 = PAD.left + i * band + (band - barSlot) / 2;
    if (!stacked) {
      const n = Math.max(series.length, 1);
      const w = Math.max((barSlot - GAP * (n - 1)) / n, 1);
      return series.map((s, k) => {
        const v = s.values[i] ?? 0;
        return { series: s, value: v, x: x0 + k * (w + GAP), w, top: Math.min(y(v), y(0)), h: Math.abs(y(v) - y(0)), up: v >= 0, round: true };
      });
    }
    let up = 0;
    let down = 0;
    return series.map((s) => {
      const v = s.values[i] ?? 0;
      const from = v >= 0 ? up : down;
      const to = from + v;
      if (v >= 0) up = to;
      else down = to;
      const top = Math.min(y(from), y(to));
      const h = Math.abs(y(to) - y(from));
      return { series: s, value: v, x: x0, w: barSlot, top, h: Math.max(h - GAP, 0), up: v >= 0, round: false };
    });
  }

  // Rounds only the data end (away from the baseline) — the anchored end stays square.
  function barPath(b) {
    const h = Math.max(b.h, 0);
    const r = Math.min(RADIUS, b.w / 2, h);
    if (h <= 0.5) return '';
    const { x, w } = b;
    const top = b.up ? b.top : b.top + h;
    const dir = b.up ? 1 : -1; // 1 = grows upward from the baseline
    if (!b.round || r <= 0) return `M${x} ${b.top}h${w}v${h}h${-w}Z`;
    return [
      `M${x} ${top + dir * h}`,
      `L${x} ${top + dir * r}`,
      `Q${x} ${top} ${x + r} ${top}`,
      `L${x + w - r} ${top}`,
      `Q${x + w} ${top} ${x + w} ${top + dir * r}`,
      `L${x + w} ${top + dir * h}`,
      'Z',
    ].join('');
  }

  function showTooltip(event, i) {
    const rect = event.currentTarget.closest('.chart-root').getBoundingClientRect();
    const rows = series
      .map((s) => ({ name: s.name, color: s.color, value: s.values[i] ?? 0 }))
      .filter((r) => r.value !== 0);
    hover = { x: event.clientX - rect.left, y: event.clientY - rect.top, label: labels[i], rows };
  }
</script>

<div class="chart-root relative" bind:clientWidth={width}>
  <svg {width} {height} role="img" aria-label="Bar chart">
    <!-- Recessive hairline grid; the zero rule is the only stronger line. -->
    {#each extent.ticks as t (t)}
      <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} stroke={t === 0 ? pal.axis : pal.grid} stroke-width="1" />
      <text x={PAD.left - 8} y={y(t) + 4} text-anchor="end" font-size="11" fill={pal.muted} style="font-variant-numeric: tabular-nums">
        {formatMoney(t, '', { compact: true })}
      </text>
    {/each}

    <!-- Keyed by position, not by label: a column *is* its slot on the axis,
         and month labels repeat the moment a range spans more than a year. -->
    {#each labels as label, i (i)}
      {#each bars(i) as b (b.series.key ?? b.series.name)}
        {#if b.h > 0.5}
          <path d={barPath(b)} fill={b.series.color} />
        {/if}
      {/each}
      <!-- One hit target per column, comfortably bigger than the marks. -->
      <rect
        x={PAD.left + i * band}
        y={PAD.top}
        width={band}
        height={plotH}
        fill="transparent"
        onmousemove={(e) => showTooltip(e, i)}
        onmouseleave={() => (hover = null)}
        role="presentation"
      />
      {#if i % labelStep === 0}
        <text x={PAD.left + i * band + band / 2} y={height - 8} text-anchor="middle" font-size="11" fill={pal.muted}>{label}</text>
      {/if}
    {/each}
  </svg>

  {#if hover && hover.rows.length}
    <div
      class="pointer-events-none absolute z-10 min-w-40 rounded-md border border-border bg-card p-2 text-xs shadow-md"
      style={`left: ${Math.min(hover.x + 12, width - 180)}px; top: ${hover.y + 12}px`}
    >
      <p class="mb-1 font-medium">{hover.label}</p>
      {#each hover.rows as row (row.name)}
        <div class="flex items-center justify-between gap-3">
          <span class="flex items-center gap-1.5 text-muted-foreground">
            <span class="inline-block h-2 w-2 rounded-sm" style={`background:${row.color}`}></span>
            {row.name}
          </span>
          <span class="tabular-nums">{valueLabel(row.value)}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>
