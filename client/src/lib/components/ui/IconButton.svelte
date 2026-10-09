<script>
  import { cn } from '$lib/utils.js';

  // Square icon-only button. `danger` variant is red to signal destructive actions.
  // Callers must pass an aria-label (and usually a title) for accessibility.
  let { variant = 'default', type = 'button', class: className = '', children, ...rest } = $props();

  const variants = {
    default: 'text-muted-foreground hover:bg-accent hover:text-foreground',
    danger: 'text-destructive hover:bg-destructive/10',
  };
</script>

<button
  {type}
  class={cn(
    'inline-flex h-8 w-8 items-center justify-center rounded-md transition disabled:pointer-events-none disabled:opacity-50',
    variants[variant],
    className,
  )}
  {...rest}
>
  {@render children?.()}
</button>
