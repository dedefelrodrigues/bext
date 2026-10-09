<script>
  let { for: htmlFor = undefined, children } = $props();
</script>

<label for={htmlFor} class="text-sm font-medium text-foreground">
  {@render children?.()}
</label>
