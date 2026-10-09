<script>
  import { CATEGORY_ICONS } from '$lib/categoryIcons.js';
  import { categoryPalette, categoryColor } from '$lib/categoryColors.js';

  // Renders a curated category glyph by name. Unknown/empty names render
  // nothing — unless a `categoryId` is given, in which case the category's
  // colour swatch stands in, so a category is never left without its colour.
  // Pass a subcategory's PARENT id: a subcategory shares its category's hue.
  let { name, size = 18, class: className = '', categoryId = null } = $props();
  const shapes = $derived(name ? CATEGORY_ICONS[name] : null);
  const color = $derived(categoryColor(categoryId, categoryPalette()));
</script>

{#if shapes}
  <svg
    style={color ? `color: ${color}` : undefined}
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    class={className}
    aria-hidden="true"
  >
    {#each shapes as s}
      {#if s[0] === 'path'}
        <path d={s[1]} />
      {:else if s[0] === 'circle'}
        <circle cx={s[1]} cy={s[2]} r={s[3]} />
      {:else if s[0] === 'line'}
        <line x1={s[1]} y1={s[2]} x2={s[3]} y2={s[4]} />
      {:else if s[0] === 'rect'}
        <rect x={s[1]} y={s[2]} width={s[3]} height={s[4]} rx={s[5] ?? 0} />
      {:else if s[0] === 'polyline'}
        <polyline points={s[1]} />
      {:else if s[0] === 'polygon'}
        <polygon points={s[1]} />
      {/if}
    {/each}
  </svg>
{:else if color}
  <span
    class={'inline-block shrink-0 rounded-sm ' + className}
    style={`background: ${color}; width: ${Math.round(size * 0.62)}px; height: ${Math.round(size * 0.62)}px`}
    aria-hidden="true"
  ></span>
{/if}
