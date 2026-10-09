<script>
  import { formatMoney } from '$lib/charts.js';

  // Every row of a category on one axis of money, out to the left and in to the
  // right, with the flagged rows drawn over the rest. It answers the question
  // the finding asks: a refund sits close to zero among the ordinary rows; a
  // salary misfiled under Restaurants sits far off on the other side.
  //
  // The axis is symmetric-log (sign · log10(1 + |units|)), since one category
  // holds 20-unit coffees and 20,000-unit transfers. Values are minor units in
  // the display currency.
  let { rest = [], flagged = [], currency = '', category = '' } = $props();

  let width = $state(600);
  const H = 64;
  const PAD = 14;
  const MID = 26;

  const f = (cents) => Math.sign(cents) * Math.log10(1 + Math.abs(cents) / 100);
  const domain = $derived.by(() => {
    const all = [...rest, ...flagged.map((x) => x.value)].map(f);
    const lo = Math.min(0, ...all);
    const hi = Math.max(0, ...all);
    const pad = (hi - lo) * 0.04 || 1;
    return [lo - pad, hi + pad];
  });
  const x = (cents) => PAD + ((f(cents) - domain[0]) / (domain[1] - domain[0])) * (width - 2 * PAD);

  // Ticks at powers of ten that fall inside the domain, both ways.
  const ticks = $derived.by(() => {
    const out = [0];
    for (const p of [1, 2, 3, 4, 5, 6, 7]) {
      const v = 10 ** p * 100;
      if (f(v) <= domain[1]) out.push(v);
      if (f(-v) >= domain[0]) out.push(-v);
    }
    // Drop ticks too close to a neighbour at this width.
    const sorted = out.sort((a, b) => a - b);
    const kept = [];
    for (const t of sorted) if (!kept.length || x(t) - x(kept[kept.length - 1]) > 34) kept.push(t);
    return kept;
  });
  const label = (cents) => (cents === 0 ? '0' : formatMoney(cents, '', { compact: true }));

  // A stable vertical jitter so a thousand ordinary rows read as a band.
  const jitter = (i) => (((i * 7919) % 13) - 6) * 1.6;
</script>

<figure class="flex flex-col gap-1.5">
  <div bind:clientWidth={width} class="w-full">
    <svg {width} height={H} role="img" aria-label="Amounts of every row in {category}; the flagged rows are drawn larger">
      <line x1={x(0)} x2={x(0)} y1="6" y2={MID + 14} class="stroke-border" stroke-width="1" stroke-dasharray="3 3" />
      {#each rest as v, i (i)}
        <circle cx={x(v)} cy={MID + jitter(i)} r="2.5" class="fill-muted-foreground" fill-opacity="0.35" />
      {/each}
      {#each flagged as t (t.id)}
        <circle cx={x(t.value)} cy={MID} r="5" class="fill-foreground stroke-card" stroke-width="2">
          <title>{t.date} · {t.description} · {formatMoney(t.value, currency)}</title>
        </circle>
      {/each}
      {#each ticks as t (t)}
        <text x={x(t)} y={H - 4} text-anchor="middle" class="fill-muted-foreground text-[10px] tabular-nums">{label(t)}</text>
      {/each}
    </svg>
  </div>
  <figcaption class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
    <span class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-full bg-muted-foreground/40"></span>rest of {category} ({rest.length})</span>
    <span class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-full bg-foreground"></span>these rows ({flagged.length})</span>
    <span class="ml-auto">← money out · money in →</span>
  </figcaption>
</figure>
