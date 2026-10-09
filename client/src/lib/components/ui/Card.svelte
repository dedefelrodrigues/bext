<script>
  import { cn } from '$lib/utils.js';

  let { class: className = '', children } = $props();
</script>

<div class={cn('rounded-xl border border-border bg-card text-card-foreground shadow-sm', className)}>
  {@render children?.()}
</div>
