<script>
  import { cn } from '$lib/utils.js';

  let {
    variant = 'default',
    type = 'button',
    class: className = '',
    children,
    ...rest
  } = $props();

  const variants = {
    default: 'bg-primary text-primary-foreground hover:opacity-90',
    outline: 'border border-input bg-card text-foreground hover:bg-accent',
    ghost: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
    destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
  };
</script>

<button
  {type}
  class={cn(
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md px-4 py-2 text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50',
    variants[variant],
    className,
  )}
  {...rest}
>
  {@render children?.()}
</button>
