<script>
  import { cn } from '$lib/utils.js';

  let { value = $bindable(''), class: className = '', ...rest } = $props();
</script>

<input
  bind:value
  class={cn(
    'w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring',
    className,
  )}
  {...rest}
/>
