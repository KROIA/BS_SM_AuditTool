<script lang="ts">
  // "Export CSV" beside a table's heading: the whole data set behind the table, not only the rows on screen.
  // make() gives the columns and rows; main.ts asks where to save and writes the file, never into a save.
  import { csv, csvName, type Table } from '../../shared/csv.ts';
  import { saveText } from './state.svelte.ts';

  let { screen, table, what, make, text = 'Export CSV' }: { screen: string; table: string; what: string; make: () => Table | Promise<Table>; text?: string } = $props();
  let busy = $state(false), saved = $state<{ path: string } | { error: string } | null>(null);

  async function save() {
    busy = true;
    try {
      saved = await saveText(csvName(screen, table), csv(await make()));
    } catch (e) {
      saved = { error: `The table could not be exported: ${(e as Error).message}` };
    } finally {
      busy = false;
    }
  }
  const base = (p: string) => p.split(/[\\/]/).at(-1);
</script>

<span class="csv">
  <button type="button" class="csvbtn" disabled={busy} aria-label="Export {what} as CSV" onclick={save}>
    <svg width="14" height="14" viewBox="0 0 24 24" class="icon" aria-hidden="true" style="stroke-width: 2"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>{busy ? 'Exporting…' : text}
  </button>
  {#if saved}<span class="small said" role="status" class:bad={'error' in saved} title={'path' in saved ? saved.path : undefined}>{'error' in saved ? saved.error : `Saved as ${base(saved.path)}`}</span>{/if}
</span>

<style>
  .csv { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; min-width: 0; }
  .csvbtn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--line2); background: transparent;
    font-size: 13px; font-weight: 500; color: var(--text2); white-space: nowrap; }
  .csvbtn:hover:not(:disabled) { background: var(--raised); color: var(--text); }
  .said { max-width: 420px; text-wrap: pretty; }
  .bad { color: var(--crit); }
</style>
