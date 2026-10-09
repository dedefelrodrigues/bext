<script>
  import { cn } from '$lib/utils.js';

  let {
    checked = $bindable(false),
    disabled = false,
    class: className = '',
    onCheckedChange,
    ...rest
  } = $props();

  function toggle() {
    if (disabled) return;
    checked = !checked;
    onCheckedChange?.(checked);
  }
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  {disabled}
  onclick={toggle}
  class={cn(
    'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    checked ? 'bg-primary' : 'bg-input',
    className,
  )}
  {...rest}
>
  <span
    class={cn(
      'pointer-events-none block h-4 w-4 rounded-full bg-card shadow-sm ring-0 transition-transform',
      checked ? 'translate-x-4' : 'translate-x-0',
    )}
  ></span>
</button>
