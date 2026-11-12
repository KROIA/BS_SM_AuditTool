<script lang="ts">
  // Saves and servers: what is loaded and what could be read. Coverage, transfers and the world scan follow in M1 and M3.
  import type { SaveSource, SaveSummary } from '../../shared/api.ts';
  import { count } from '../../shared/fmt.ts';
  import Icon from '../app/Icon.svelte';
  import { ICON } from '../app/nav.ts';
  import { app, browse } from '../app/state.svelte.ts';

  const LABEL: Record<SaveSource['id'], string> = {
    bank: 'Bank accounts and log',
    market: 'Market orders and prices',
    bankDiag: 'Bank diagnostics',
    marketDiag: 'Market diagnostics',
  };
  const ROLE = { MASTER: 'Master', SLAVE: 'Slave', STANDALONE: 'Single server' };

  function detail(s: SaveSource): string {
    if (s.status === 'missing') return 'not in this copy';
    const rows = s.tables.reduce((sum, t) => sum + t.rows, 0), lost = s.tables.reduce((sum, t) => sum + t.lostIds, 0);
    const text = `${count(s.tables.length)} ${s.tables.length === 1 ? 'table' : 'tables'}, ${count(rows)} rows`;
    if (s.status !== 'damaged') return text;
    if (!s.tables.length) return 'the file could not be opened';
    const newest = s.tables.filter((t) => t.newestLost).map((t) => t.name);
    return [text, lost ? `${count(lost)} could not be read` : '', newest.length ? `the newest rows of ${newest.join(' and ')} could not be read` : '']
      .filter(Boolean).join(', ');
  }
  /** The sources worth a line: everything except what this kind of save never has. */
  const shown = (save: SaveSummary) => save.sources.filter((s) => s.status !== 'none');
  const format = (save: SaveSummary) =>
    save.generation === 'legacy' ? 'Written by mod version 2.1.2, before the audit additions.' : save.role === 'SLAVE' ? 'Slaves keep no bank or market data.' : 'Written by the current mods.';
</script>

<div>
  <h1 class="h1">Saves and servers</h1>
  <p class="sub">The tool works on copies and never writes to a save.</p>
</div>

<div class="add">
  <span style="color: var(--text3); display: flex"><Icon d={ICON.upload} size={22} /></span>
  <p>Open a world folder to add a save. The master and its slaves are matched by their server ids.</p>
  <button type="button" class="btn" style="border-color: var(--line2); background: transparent; font-weight: 500; padding: 0 14px" onclick={browse}>Browse</button>
</div>

{#if app.error}
  <p class="problem" role="alert">{app.error}</p>
{/if}
{#each app.warnings as w}
  <p class="problem">{w}</p>
{/each}

<div class="grid">
  {#each app.saves as save (save.path)}
    <section class="card save" title={save.path}>
      <div>
        <div style="display: flex; align-items: center; gap: 10px">
          <h2 class="h2" style="flex: 1 1 auto">{save.name}</h2>
          <span class="role" class:master={save.role === 'MASTER'}>{ROLE[save.role]}{save.roleAssumed ? ', assumed' : ''}</span>
        </div>
        <p class="small" style="margin: 4px 0 0">{format(save)}</p>
      </div>
      <div class="list">
        {#each shown(save) as s (s.id)}
          <div class="line">
            <span style="display: flex; margin-top: 2px; color: {s.status === 'read' ? 'var(--up)' : 'var(--high)'}"><Icon d={s.status === 'read' ? ICON.ok : ICON.warn} size={16} stroke={2.25} label={s.status === 'read' ? 'Read' : 'Problem'} /></span>
            <span style="flex: 1 1 0; min-width: 0; display: flex; flex-direction: column"><span style="font-weight: 500">{LABEL[s.id]}</span><span class="small">{detail(s)}</span></span>
          </div>
        {/each}
      </div>
      {#each save.warnings as w}
        <p class="problem">{w}</p>
      {/each}
    </section>
  {/each}
</div>

<style>
  .add { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; padding: 16px 20px; border-radius: 14px; border: 1px dashed var(--line2); }
  .add p { flex: 1 1 320px; min-width: 0; margin: 0; color: var(--text2); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: 16px; }
  .save { display: flex; flex-direction: column; gap: 16px; }
  .role { flex: none; height: 24px; padding: 0 8px; border-radius: 6px; font-size: 12px; line-height: 24px; font-weight: 600; color: var(--text2); background: var(--raised); }
  .role.master { color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .list { display: flex; flex-direction: column; gap: 10px; }
  .line { display: flex; align-items: flex-start; gap: 10px; }
  .problem { margin: 0; padding: 12px; border-radius: 10px; font-size: 13px; background: color-mix(in srgb, var(--high) 12%, transparent); text-wrap: pretty; }
</style>
