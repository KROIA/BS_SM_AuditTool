<script lang="ts">
  // Findings as links to the Findings screen: level dot, title, when. For the Players and Markets screens.
  import type { Finding } from '../../shared/api.ts';
  import { describe, span, type ItemWords } from '../../shared/finding.ts';
  import { count } from '../../shared/fmt.ts';
  import Icon from './Icon.svelte';
  import { LEVEL_COLOR } from './words.ts';

  let { list, w, empty }: { list: Finding[]; w: ItemWords; empty: string } = $props();
  const FIRST = 5;
  let all = $state(false);
</script>

<div class="links">
  {#each all ? list : list.slice(0, FIRST) as f (f.id)}
    <a class="row link-row" href={'#/findings/' + encodeURIComponent(f.id)}>
      <span class="dot" style="background: {LEVEL_COLOR[f.level]}" aria-hidden="true"></span>
      <span class="who">
        <span style="font-weight: 500; text-wrap: pretty">{describe(f, w).title}</span>
        <span class="small">{span(f.start, f.end)}</span>
      </span>
      <span style="color: var(--text3); display: flex"><Icon d="M5 12h14M13 6l6 6-6 6" size={16} stroke={2} /></span>
    </a>
  {:else}
    <p style="margin: 0; padding: 10px; color: var(--text2)">{empty}</p>
  {/each}
  {#if list.length > FIRST}
    <button type="button" class="link" style="align-self: flex-start; margin: 4px 10px 0" onclick={() => (all = !all)}>{all ? 'Show fewer' : `Show all ${count(list.length)}`}</button>
  {/if}
</div>

<style>
  .links { display: flex; flex-direction: column; gap: 2px; margin: 12px -10px 0; }
  .link-row { display: flex; align-items: flex-start; gap: 12px; padding: 10px; border-radius: 10px; }
  .dot { flex: none; width: 8px; height: 8px; margin-top: 7px; border-radius: 50%; }
  .link { padding: 0; border: 0; background: none; font-size: 13px; font-weight: 500; color: var(--accent); }
</style>
