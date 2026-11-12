<script lang="ts">
  // A line icon from a path, drawn in the current text colour.
  let { d, size = 18, label = '', stroke = 1.75 }: { d: string; size?: number; label?: string; stroke?: number } = $props();
</script>

<svg class="icon" width={size} height={size} viewBox="0 0 24 24" style:stroke-width={stroke} role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : 'true'}><path {d}></path></svg>
