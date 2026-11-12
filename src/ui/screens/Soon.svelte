<script lang="ts">
  // Stands in for a screen that a later milestone builds.
  import type { Screen } from '../app/nav.ts';
  let { screen }: { screen: Screen } = $props();
</script>

<div>
  <h1 class="h1">{screen.label}</h1>
  <p class="sub">{screen.question}</p>
</div>
<p class="card" style="margin: 0; border-style: dashed; background: transparent; color: var(--text2)">This screen is not built yet. It comes with milestone {screen.milestone}.</p>
