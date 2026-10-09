<script>
  // A description with the keyword's words marked. `ranges` are [start, end)
  // offsets into `text`, computed by the server on the engine's own rules.
  // When the first mark sits deep in a long description (a bank transfer's
  // sender, address and account numbers come first), the text starts shortly
  // before it with "…", so a truncated cell still shows why the row is here.
  let { text = '', ranges = [], lead = 24 } = $props();

  const view = $derived.by(() => {
    const sorted = [...ranges].sort((x, y) => x[0] - y[0]);
    let from = 0;
    if (sorted.length && sorted[0][0] > lead + 12) {
      from = sorted[0][0] - lead;
      const space = text.indexOf(' ', from);
      if (space !== -1 && space < sorted[0][0]) from = space + 1;
    }
    const out = from ? [{ t: '…', m: false }] : [];
    let at = from;
    for (const [a, b] of sorted) {
      if (a < at) continue;
      if (a > at) out.push({ t: text.slice(at, a), m: false });
      out.push({ t: text.slice(a, b), m: true });
      at = b;
    }
    if (at < text.length) out.push({ t: text.slice(at), m: false });
    return out;
  });
</script>

{#each view as p, i (i)}{#if p.m}<mark class="rounded-sm bg-warning px-0.5 text-warning-foreground">{p.t}</mark>{:else}{p.t}{/if}{/each}
