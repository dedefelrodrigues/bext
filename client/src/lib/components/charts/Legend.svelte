<script>
  // Identity is never carried by color alone: every series gets a swatch *and*
  // its name here, and each chart also offers the table view.
  let { items = [], class: className = '' } = $props();
</script>

<ul class={'flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground ' + className}>
  {#each items as item (item.name)}
    <li class="flex items-center gap-1.5">
      <span class="inline-block h-2 w-2 rounded-sm" style={`background:${item.color}`}></span>
      <span>{item.name}</span>
    </li>
  {/each}
</ul>
