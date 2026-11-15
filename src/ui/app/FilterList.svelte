<script lang="ts">
  // A list of what a chart can show, each entry a button that switches it on and off, with a search over the list and
  // buttons to show or hide every entry the search leaves. off: the ids switched off.
  interface Entry { id: string | number; name: string; color?: string; disabled?: string }
  let { entries, off = $bindable(), label, find, all }: {
    entries: Entry[];
    off: Set<string | number>;
    /** The group's name, for screen readers; find: the search's placeholder; all: the texts of the show and hide buttons. */
    label: string;
    find: string;
    all: [string, string];
  } = $props();

  let search = $state('');
  const listed = $derived(entries.filter((e) => e.name.toLowerCase().includes(search.trim().toLowerCase())));
  function toggle(id: string | number) {
    const next = new Set(off);
    if (!next.delete(id)) next.add(id);
    off = next;
  }
  function every(show: boolean) {
    const next = new Set(off);
    for (const e of listed) show ? next.delete(e.id) : next.add(e.id);
    off = next;
  }
</script>

<div class="filter">
  <input type="search" placeholder={find} aria-label={find} bind:value={search} />
  <div class="all">
    <button type="button" class="link" onclick={() => every(true)}>{all[0]}</button>
    <button type="button" class="link" onclick={() => every(false)}>{all[1]}</button>
  </div>
  <div role="group" aria-label={label} class="entries">
    {#each listed as e (e.id)}
      <button type="button" aria-pressed={!off.has(e.id)} style:--c={e.color ?? 'var(--text3)'} onclick={() => toggle(e.id)} disabled={!!e.disabled} title={e.disabled}>
        <span class="dot" aria-hidden="true"></span><span class="ellipsis">{e.name}</span>
      </button>
    {:else}
      <p class="small" style="margin: 4px 0">Nothing matches.</p>
    {/each}
  </div>
</div>

<style>
  .filter { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .filter input { font: inherit; font-size: 13px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--line2); background: var(--raised); color: var(--text); }
  .all { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 13px; }
  .link { padding: 0; border: 0; background: none; font-size: 13px; font-weight: 500; color: var(--accent); }
  .entries { display: flex; flex-direction: column; gap: 2px; max-height: 360px; overflow-y: auto; }
  .entries button { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 4px 8px; border: 0; border-radius: 6px; background: none; color: var(--text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
  .entries button:hover { background: var(--raised); }
  .entries button[aria-pressed='false'] { color: var(--text3); }
  .entries button[aria-pressed='false'] .dot { background: none; box-shadow: inset 0 0 0 2px var(--c); }
  .entries button:disabled { cursor: default; opacity: 0.5; }
  .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--c); }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
