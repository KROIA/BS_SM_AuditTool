<script lang="ts">
  // Saves and servers: what is loaded, what could be read, and what time each source covers.
  // While nothing is loaded it is the start screen. Three tabs: the loaded saves, the transfers between servers
  // (#/saves/transfers) and the world scan (#/saves/scan).
  import type { SaveSource, SaveSummary, SaveTable } from '../../shared/api.ts';
  import { bytes, count, time } from '../../shared/fmt.ts';
  import CsvButton from '../app/CsvButton.svelte';
  import Icon from '../app/Icon.svelte';
  import { ICON } from '../app/nav.ts';
  import { app, browse, drop, folderName, reload, removeSave } from '../app/state.svelte.ts';
  import Transfers from './Transfers.svelte';
  import WorldScan from './WorldScan.svelte';

  let { tab, mark = null }: { tab: string | null; mark?: string | null } = $props();

  const LABEL: Record<SaveSource['id'], string> = {
    bank: 'Bank accounts and log',
    market: 'Market orders and prices',
    bankDiag: 'Bank diagnostics',
    marketDiag: 'Market diagnostics',
    audit: 'Bank audit log',
  };
  const ROLE = { MASTER: 'Master', SLAVE: 'Slave', STANDALONE: 'Single server' };
  /** The mods' tables in words. The engine's progress steps name the table being read. */
  const TABLE: Record<string, string> = {
    TransactionLog: 'bank log',
    BalanceHistory: 'balance snapshots',
    SuspicionFlag: "bank's own warnings",
    OrderHistory: 'market orders',
    MarketPrice: 'market prices',
    TransferJournal: 'transfer journal',
    NoteFlow: 'banknote log',
    OrderOrigin: 'order origins',
    TradeAlert: 'market alerts',
    Meta: 'diagnostics',
    AuditLog: 'audit log',
  };
  const DAY = 86_400_000;
  const date = (ms: number, utc = false) => time(ms, utc).split(',')[0];

  function detail(s: SaveSource): string {
    if (s.status === 'missing') return 'not in this copy';
    const rows = s.tables.reduce((sum, t) => sum + t.rows, 0), lost = s.tables.reduce((sum, t) => sum + t.lostIds, 0);
    const text = (s.id === 'audit' ? `${count(rows)} entries` : `${count(s.tables.length)} ${s.tables.length === 1 ? 'table' : 'tables'}, ${count(rows)} rows`) + (s.note ? ', ' + s.note : '');
    if (s.status !== 'damaged') return text;
    if (!s.tables.length) return 'the file could not be opened';
    const newest = s.tables.filter((t) => t.newestLost).map((t) => TABLE[t.name] ?? t.name);
    return [text, lost ? `${count(lost)} could not be read` : '', newest.length ? `the newest rows of ${newest.join(' and ')} could not be read` : '']
      .filter(Boolean).join(', ');
  }
  /** The sources worth a line: everything except what this kind of save never has. */
  const shown = (save: SaveSummary) => save.sources.filter((s) => s.status !== 'none');
  // An audit export (BS-255) is a consistent copy the server made itself; its time comes from its manifest.
  const taken = (save: SaveSummary) => save.exported
    ? (save.lastPlayedMs === null ? 'Audit export, when it was made is unknown' : 'Audit export made ' + time(save.lastPlayedMs))
    : save.lastPlayedMs === null ? 'When the copy was taken is unknown' : 'Copy taken ' + time(save.lastPlayedMs);
  /** The zip a save was opened from: its path is the zip's, with the folder inside for a zip of several saves. */
  const zipOf = (save: SaveSummary) => save.path.split(/[\\/]/).find((part) => /\.zip$/i.test(part));
  const size = (save: SaveSummary) => bytes(save.sources.filter((s) => s.id !== 'audit').reduce((sum, s) => sum + s.bytes, 0)) + ' of databases';
  function versions(save: SaveSummary): string {
    const mc = save.minecraft ? `Minecraft ${save.minecraft}` : 'Minecraft version unknown';
    if (save.generation === 'legacy') return `Written by BankSystem 2.1.2, before the audit additions. ${mc}.`;
    if (save.role === 'SLAVE') return `${mc}. Slaves keep no bank or market data.`;
    return `${save.bankVersion ? `BankSystem ${save.bankVersion}` : 'BankSystem version unknown'}${save.marketVersion ? ` · StockMarket ${save.marketVersion}` : ''} · ${mc}`;
  }
  const progressStep = (step: string) => (TABLE[step] ? 'Reading the ' + TABLE[step] : step);

  // ---- What each source covers ----
  interface Seg { left: number; width: number; op: number }
  interface Cover { label: string; segs: Seg[]; note: string }

  const tables = $derived(app.saves.flatMap((s) => s.sources.flatMap((x) => x.tables)));
  const allDays = $derived(tables.flatMap((t) => t.days.map((d) => d[0])));
  const axis = $derived.by(() => {
    if (!allDays.length) return null;
    const start = Math.min(...allDays), end = Math.max(...allDays) + DAY; // the last day counts in full
    return { start, end };
  });
  const pct = (ms: number) => (axis ? Math.min(100, Math.max(0, ((ms - axis.start) / (axis.end - axis.start)) * 100)) : 0);

  /** One bar from the first to the last row: event logs, where a quiet day is no gap. */
  function span(from: number | null, to: number | null): Seg[] {
    if (from === null || to === null) return [];
    const left = pct(from);
    return [{ left, width: Math.max(pct(to) - left, 0.6), op: 1 }];
  }
  /** Runs of days with rows, lighter where a day has few rows: snapshots and prices, where a gap means the server was off. */
  function runs(t: SaveTable): Seg[] {
    const top = Math.max(1, ...t.days.map((d) => d[1]));
    const level = (rows: number) => (rows >= top * 0.5 ? 1 : rows >= top * 0.1 ? 0.65 : 0.35);
    const segs: Seg[] = [];
    let last = -Infinity;
    for (const [day, rows] of [...t.days].sort((a, b) => a[0] - b[0])) {
      const op = level(rows), prev = segs.at(-1);
      if (prev && day === last + DAY && prev.op === op) prev.width = pct(day + DAY) - prev.left;
      else segs.push({ left: pct(day), width: pct(day + DAY) - pct(day), op });
      last = day;
    }
    return segs;
  }
  function note(list: SaveTable[]): string {
    if (list.some((t) => t.newestLost)) return 'newest rows lost';
    const lost = list.reduce((sum, t) => sum + t.lostIds, 0);
    if (lost) return `${count(lost)} rows lost`;
    const from = list.flatMap((t) => (t.from === null ? [] : [t.from]));
    return from.length ? 'since ' + date(Math.min(...from)) : 'no rows';
  }

  const cover = $derived.by((): Cover[] => {
    const out: Cover[] = [];
    const ROWS: [SaveSource['id'], string, string, boolean][] = [
      ['bank', 'TransactionLog', 'Bank log', false],
      ['bank', 'BalanceHistory', 'Balance snapshots', true],
      ['market', 'OrderHistory', 'Market orders', false],
      ['market', 'MarketPrice', 'Market prices', true],
      ['audit', 'AuditLog', 'Bank audit log', false],
    ];
    const mains = app.saves.filter((s) => s.sources.some((x) => (x.id === 'bank' || x.id === 'market') && x.status !== 'none'));
    for (const save of mains) {
      const suffix = mains.length > 1 ? ', ' + save.name : '';
      for (const [id, name, label, byDay] of ROWS) {
        const src = save.sources.find((x) => x.id === id);
        if (!src || src.status === 'none') continue;
        const t = src.tables.find((x) => x.name === name);
        if (src.status === 'missing' || !t) out.push({ label: label + suffix, segs: [], note: src.status === 'damaged' ? 'could not be read' : 'missing' });
        else out.push({ label: label + suffix, segs: byDay ? runs(t) : span(t.from, t.to), note: note([t]) });
      }
    }
    for (const save of app.saves) {
      const diag = save.sources.filter((x) => (x.id === 'bankDiag' || x.id === 'marketDiag') && x.status !== 'none');
      if (!diag.length) continue;
      const label = 'Diagnostics, ' + save.name;
      const read = diag.filter((x) => x.status !== 'missing').flatMap((x) => x.tables);
      if (!read.length) {
        out.push({ label, segs: [], note: diag.some((x) => x.status === 'damaged') ? 'could not be read' : 'missing' });
        continue;
      }
      const from = read.flatMap((t) => (t.from === null ? [] : [t.from])), to = read.flatMap((t) => (t.to === null ? [] : [t.to]));
      out.push({ label, segs: from.length ? span(Math.min(...from), Math.max(...to)) : [], note: note(read) });
    }
    return out;
  });

  /** Date labels at the start of their day: the first day, the last day and two in between, none crowding another. */
  const ticks = $derived.by(() => {
    if (!axis) return [];
    const days = Math.round((axis.end - axis.start) / DAY);
    const picks = [0, Math.round(days / 3), Math.round((days * 2) / 3), days - 1].map((d) => axis.start + d * DAY);
    const out: { at: number; text: string }[] = [];
    for (const ms of [...new Set(picks)]) {
      const at = pct(ms);
      if (!out.length || at - out.at(-1)!.at >= 15 || ms === picks[3]) out.push({ at, text: date(ms, true) });
    }
    if (out.length > 2 && out.at(-1)!.at - out.at(-2)!.at < 15) out.splice(-2, 1); // the last day wins over a crowding middle one
    return out;
  });

  // CSV (AT-44): every table of every source, not only the rows the bars show. No folder paths: only the save's name.
  const coverTable = () => ({
    columns: [['Save', 'text'], ['Role', 'text'], ['Source', 'text'], ['Status', 'text'], ['Table', 'text'], ['Rows', 'count'], ['Rows that could not be read', 'count'],
      ['Newest rows lost', 'text'], ['First row', 'time'], ['Last row', 'time']] as const,
    rows: app.saves.flatMap((s) => s.sources.filter((x) => x.status !== 'none').flatMap((x) => (x.tables.length ? x.tables : [null]).map((t) =>
      [s.name, ROLE[s.role], LABEL[x.id], x.status, t ? (TABLE[t.name] ?? t.name) : null, t?.rows, t?.lostIds, t?.newestLost, t?.from, t?.to]))),
  });

  // ---- Drag and drop ----
  let over = $state(false);
  function onDrop(e: DragEvent) {
    e.preventDefault();
    over = false;
    if (e.dataTransfer) drop(e.dataTransfer.files);
  }
  function onOver(e: DragEvent) {
    e.preventDefault();
    over = true;
  }
  const empty = $derived(app.saves.length === 0 && app.queue.length === 0);
</script>

<div>
  <h1 class="h1">Saves and servers</h1>
  <p class="sub">The tool works on copies and never writes to a save.</p>
</div>

{#if !empty}
  <div role="tablist" aria-label="Saves and servers" class="tabs">
    <a role="tab" href="#/saves" aria-selected={tab !== 'transfers' && tab !== 'scan'}>Loaded saves</a>
    <a role="tab" href="#/saves/transfers" aria-selected={tab === 'transfers'}>Transfers between servers</a>
    <a role="tab" href="#/saves/scan" aria-selected={tab === 'scan'}>World scan</a>
  </div>
{/if}

{#if empty}
  <div class="start" class:over role="region" aria-label="Drop a save folder here" ondragover={onOver} ondragleave={() => (over = false)} ondrop={onDrop}>
    <span style="color: var(--text3); display: flex"><Icon d={ICON.upload} size={36} /></span>
    <h2 class="h2">Open a save</h2>
    <p>A save is the world folder, or its <code>data</code> folder, of a server that runs BankSystem and StockMarket, or an audit export. Drop one or several here, also as a <code>.zip</code>.</p>
    <p>The tool only reads copies of the files and never writes to a save.</p>
    <div class="opens">
      <button type="button" class="btn primary" onclick={() => browse()}>Open folder</button>
      <button type="button" class="btn ghost" onclick={() => browse(true)}>Open zip</button>
    </div>
  </div>
  <section aria-labelledby="guide">
    <h2 class="h2" id="guide">From a server to a report</h2>
    <ol class="guide">
      <li class="card">
        <span class="step">1</span>
        <h3>Get the saves</h3>
        <p>Run <code>/banksystem backup export</code> on each server. It writes a zip into <code>audit_exports</code> in the world folder. Where the command is missing, copy the world folder while the server is stopped: a copy from a running server is often damaged.</p>
      </li>
      <li class="card">
        <span class="step">2</span>
        <h3>Open them together</h3>
        <p>Open the master's save and those of its slaves, as folders or zips. The tool matches them by their server ids. The first read takes a while, after that a save opens at once.</p>
      </li>
      <li class="card">
        <span class="step">3</span>
        <h3>Follow the answer</h3>
        <p>The Overview says whether something needs attention. Findings, Players and Item flow show what happened and who gained. Case and report works out what to take back and writes the report for the admins.</p>
      </li>
    </ol>
  </section>
{:else if tab !== 'transfers' && tab !== 'scan'}
  <div class="add" class:over role="region" aria-label="Drop a save folder here" ondragover={onOver} ondragleave={() => (over = false)} ondrop={onDrop}>
    <span style="color: var(--text3); display: flex"><Icon d={ICON.upload} size={22} /></span>
    <p>Drop a world folder or a zip here to add another save. The master and its slaves are matched by their server ids.</p>
    <button type="button" class="btn ghost" onclick={() => browse()}>Open folder</button>
    <button type="button" class="btn ghost" onclick={() => browse(true)}>Open zip</button>
    <button type="button" class="btn ghost" disabled={app.busy || app.queue.length > 0} onclick={() => reload()}
      title="Reads the loaded world folders again, for a world that is still being played. A zip stays as it was.">Read again</button>
  </div>
{/if}

{#each app.errors as e}
  <p class="problem" role="alert">{e}</p>
{/each}
{#each app.warnings as w}
  <p class="problem">{w}</p>
{/each}

{#if !empty && tab === 'transfers'}
  <Transfers {mark} />
{:else if !empty && tab === 'scan'}
  <WorldScan />
{:else if !empty}
  <div class="grid">
    {#each app.saves as save (save.path)}
      <section class="card save" title={save.path}>
        <div>
          <div style="display: flex; align-items: center; gap: 10px">
            <h2 class="h2" style="flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere">{save.name}</h2>
            <span class="role" class:master={save.role === 'MASTER'}>{ROLE[save.role]}{save.roleAssumed ? ', assumed' : ''}</span>
          </div>
          <p class="small" style="margin: 4px 0 0">{taken(save)} · {size(save)}{zipOf(save) ? ` · from ${zipOf(save)}` : ''}</p>
          <p class="small" style="margin: 0">{versions(save)}</p>
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
        <button type="button" class="btn ghost remove" disabled={app.queue.length > 0} onclick={() => removeSave(save.path)} aria-label={'Remove ' + save.name}>Remove</button>
      </section>
    {/each}
    {#each app.queue as path, i (path + i)}
      <section class="card save" aria-busy="true">
        <h2 class="h2" style="overflow-wrap: anywhere">{folderName(path)}</h2>
        {#if i === 0}
          {@const p = app.loading}
          <!-- Steps without a count (copying, sorting) get a moving bar instead of one that sits still at 0 -->
          {@const counted = !!p && p.total > 1}
          <div class="bar" class:busy={!counted} role="progressbar" aria-label={'Reading ' + folderName(path)} aria-valuemin={0} aria-valuemax={counted ? p.total : undefined} aria-valuenow={counted ? p.done : undefined}>
            <span style={counted ? `width: ${(p.done / p.total) * 100}%` : ''}></span>
          </div>
          <p class="small" style="margin: 0">{p ? progressStep(p.step) : 'Opening the folder'}</p>
        {:else}
          <p class="small" style="margin: 0">Waiting its turn. Saves are read one after the other.</p>
        {/if}
      </section>
    {/each}
  </div>

  {#if cover.length}
    <section class="card">
      <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 12px">
        <h2 class="h2" style="flex: 1 1 auto; font-size: 17px; line-height: 24px">What each source covers</h2>
        <CsvButton screen="saves" table="coverage" what="what each source covers" make={coverTable} />
      </div>
      <p class="small" style="margin: 2px 0 0">A finding can only be as good as the data behind it. Lighter bars mean coarser data: the bank thins out old balance snapshots. A gap in snapshots or prices means the server was off or data is lost.</p>
      <div class="cover">
        {#each cover as c (c.label)}
          <div class="crow">
            <span class="clabel">{c.label}</span>
            <div class="track">
              {#each c.segs as g}
                <span style="left: {g.left}%; width: {g.width}%; opacity: {g.op}"></span>
              {/each}
            </div>
            <span class="cnote" class:bad={c.note === 'missing' || c.note.includes('lost') || c.note.includes('could not')}>{c.note}</span>
          </div>
        {/each}
        <div class="crow" aria-hidden="true">
          <span class="clabel"></span>
          <div class="ticks">
            {#each ticks as t}
              <!-- shifted by its own position: flush left at the start, centred in the middle, flush right at the end -->
              <span style="left: {t.at}%; transform: translateX(-{t.at}%)">{t.text}</span>
            {/each}
          </div>
          <span class="cnote"></span>
        </div>
      </div>
    </section>
  {/if}
{/if}

<style>
  .tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--line); }
  .tabs a { display: flex; align-items: center; height: 44px; margin-bottom: -1px; padding: 0 14px; border-bottom: 2px solid transparent; font-weight: 500; color: var(--text2); }
  .tabs a[aria-selected='true'] { border-bottom-color: var(--accent); color: var(--text); }
  .add { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; padding: 16px 20px; border-radius: 14px; border: 1px dashed var(--line2); }
  .add p { flex: 1 1 320px; min-width: 0; margin: 0; color: var(--text2); }
  .start { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 72px 32px; border-radius: 16px; border: 2px dashed var(--line2); text-align: center; }
  .start p { max-width: 560px; margin: 0; color: var(--text2); text-wrap: pretty; }
  .start .opens { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; margin-top: 12px; }
  .start code, .guide code { font-family: var(--font-mono); font-size: 13px; padding: 1px 5px; border-radius: 5px; background: var(--raised); }
  .guide { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin: 12px 0 0; padding: 0; list-style: none; }
  .guide li { display: flex; flex-direction: column; gap: 8px; padding: 20px; }
  .guide h3 { margin: 0; font-size: 15px; font-weight: 600; }
  .guide p { margin: 0; color: var(--text2); text-wrap: pretty; }
  .step { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: var(--raised); color: var(--accent); font-size: 13px; font-weight: 600; }
  .over { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .primary { padding: 0 18px; border: 0; background: var(--accent); color: var(--onaccent); font-weight: 600; }
  .primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 85%, var(--text)); }
  .ghost { padding: 0 14px; border-color: var(--line2); background: transparent; font-weight: 500; }
  .remove { align-self: flex-end; height: 32px; margin-top: auto; font-size: 13px; color: var(--text2); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: 16px; }
  .save { display: flex; flex-direction: column; gap: 16px; }
  .role { flex: none; height: 24px; padding: 0 8px; border-radius: 6px; font-size: 12px; line-height: 24px; font-weight: 600; color: var(--text2); background: var(--raised); }
  .role.master { color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, transparent); }
  .list { display: flex; flex-direction: column; gap: 10px; }
  .line { display: flex; align-items: flex-start; gap: 10px; }
  .problem { margin: 0; padding: 12px; border-radius: 10px; font-size: 13px; background: color-mix(in srgb, var(--high) 12%, transparent); text-wrap: pretty; }
  .bar { height: 8px; border-radius: 4px; background: var(--raised); overflow: hidden; }
  .bar span { display: block; height: 100%; border-radius: 4px; background: var(--accent); transition: width 0.2s; }
  .bar.busy span { width: 30%; animation: busy 1.4s ease-in-out infinite; }
  @keyframes busy { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
  @media (prefers-reduced-motion: reduce) { .bar.busy span { animation: none; width: 100%; opacity: 0.4; } }
  .cover { display: flex; flex-direction: column; gap: 12px; margin-top: 20px; }
  .crow { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; }
  .clabel { flex: 0 0 220px; font-weight: 500; }
  .track { position: relative; flex: 1 1 320px; height: 12px; border-radius: 6px; background: var(--raised); }
  .track span { position: absolute; top: 0; height: 12px; border-radius: 6px; background: var(--accent); }
  .cnote { flex: 0 0 150px; font-size: 13px; color: var(--text3); }
  .cnote.bad { color: var(--high); }
  .ticks { position: relative; flex: 1 1 320px; height: 16px; font-size: 12px; line-height: 16px; color: var(--text3); }
  .ticks span { position: absolute; white-space: nowrap; }
</style>
