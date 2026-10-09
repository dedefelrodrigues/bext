<script>
  import { palette, formatMoney, niceTicks } from '$lib/charts.js';

  // A single-measure timeline: one 2px line with >=8px markers, a crosshair and
  // a tooltip on hover. One series, so no legend box — the chart title names it.
  let { labels = [], values = [], color = null, currency = '', height = 220 } = $props();

  const pal = $derived(palette());
  const stroke = $derived(color ?? pal.categorical[0]);

  let width = $state(720);
  let hoverIndex = $state(null);

  const PAD = { top: 12, right: 12, bottom: 28, left: 64 };
  const plotW = $derived(Math.max(width - PAD.left - PAD.right, 40));
  const plotH = $derived(Math.max(height - PAD.top - PAD.bottom, 40));
  const extent = $derived(niceTicks(Math.min(0, ...values), Math.max(0, ...values)));

  const x = $derived((i) => PAD.left + (labels.length <= 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW));
  const y = $derived((v) => {
    const span = extent.max - extent.min || 1;
    return PAD.top + plotH - ((v - extent.min) / span) * plotH;
  });
  const path = $derived(values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)} ${y(v)}`).join(' '));
  const labelStep = $derived(Math.max(1, Math.ceil(labels.length / Math.floor(plotW / 44))));

  function nearest(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const rel = event.clientX - rect.left - PAD.left;
    const step = labels.length <= 1 ? plotW : plotW / (labels.length - 1);
    hoverIndex = Math.max(0, Math.min(labels.length - 1, Math.round(rel / step)));
  }
</script>

<div class="chart-root relative" bind:clientWidth={width}>
  <svg
    {width}
    {height}
    role="img"
    aria-label="Timeline"
    onmousemove={nearest}
    onmouseleave={() => (hoverIndex = null)}
  >
    {#each extent.ticks as t (t)}
      <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} stroke={t === 0 ? pal.axis : pal.grid} stroke-width="1" />
      <text x={PAD.left - 8} y={y(t) + 4} text-anchor="end" font-size="11" fill={pal.muted} style="font-variant-numeric: tabular-nums">
        {formatMoney(t, '', { compact: true })}
      </text>
    {/each}

    {#if hoverIndex !== null}
      <line x1={x(hoverIndex)} x2={x(hoverIndex)} y1={PAD.top} y2={PAD.top + plotH} stroke={pal.axis} stroke-width="1" />
    {/if}

    <path d={path} fill="none" stroke={stroke} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    {#each values as v, i (labels[i])}
      <circle cx={x(i)} cy={y(v)} r={hoverIndex === i ? 5 : 4} fill={stroke} stroke="var(--card)" stroke-width="2" />
    {/each}

    {#each labels as label, i (label)}
      {#if i % labelStep === 0}
        <text x={x(i)} y={height - 8} text-anchor="middle" font-size="11" fill={pal.muted}>{label}</text>
      {/if}
    {/each}
  </svg>

  {#if hoverIndex !== null}
    <div
      class="pointer-events-none absolute z-10 rounded-md border border-border bg-card p-2 text-xs shadow-md"
      style={`left: ${Math.min(x(hoverIndex) + 12, width - 150)}px; top: ${Math.max(y(values[hoverIndex]) - 12, 0)}px`}
    >
      <p class="font-medium">{labels[hoverIndex]}</p>
      <p class="tabular-nums text-muted-foreground">{formatMoney(values[hoverIndex], currency)}</p>
    </div>
  {/if}
</div>
