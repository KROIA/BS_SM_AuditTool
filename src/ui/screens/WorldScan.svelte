<script lang="ts">
  // The World scan tab of Saves and servers (DESIGN_SPEC 6.7 and 8.7): how much money in banknotes should be outside the
  // bank, how much was found and where, and where the tool could not look. The region scan is started here and runs in the
  // engine's background; its state lives in the app store (app.scan), so the bar goes on while other screens are open.
  import type { BanknotesResult, WorldItemsResult, WorldPlace } from '../../shared/api.ts';
  import { bytes, count, money, moneyShort } from '../../shared/fmt.ts';
  import { app, engine, startScan, stopScan } from '../app/state.svelte.ts';
  import CsvButton from '../app/CsvButton.svelte';
  import { heldText } from '../app/words.ts';

  const TOP = 5; // places shown until "Show all" (DESIGN_SPEC rule 3)
  /** The count runs to the copy: the world is the state when each copy was taken, so the time range does not apply. */
  const EVER = { from: null, to: null, server: null };

  let notes = $state<BanknotesResult | null>(null);
  let world = $state<WorldItemsResult | null>(null);
  let finding = $state(false);
  let allFound = $state(false);
  let allOffers = $state(false);
  let valuables = $state(false);

  $effect(() => {
    const scope = $state.snapshot(app.scope), rules = $state.snapshot(app.rules);
    void app.saves.length;
    void app.scanRound; // a scan that ended or was stopped changes what was found, and the banknotes rule runs again
    let stale = false;
    void Promise.all([engine.banknotes(EVER), engine.worldItems(), engine.findings(scope, rules)]).then(([b, w, f]) => {
      if (stale) return;
      [notes, world, finding] = [b, w, f.findings.some((x) => x.id === 'banknotes:count')];
    });
    return () => (stale = true);
  });

  const scan = $derived(app.scan ?? world?.scan ?? null);
  const server = $derived(app.scope.server);
  const here = (s: string) => server === null || s === server;
  const sum = (list: bigint[]) => list.reduce((a, v) => a + v, 0n);
  const signed = (raw: bigint) => (raw > 0n ? '+' : '') + money(raw);
  const found = $derived(world && world.reason === null ? world.notes : 0n);
  const diff = $derived(notes ? found - notes.outstanding : 0n);
  /** Money that appeared without a log row, at most what is missing: it could be notes paid back through the converter. */
  const back = $derived.by(() => {
    if (!notes || diff >= 0n) return 0n;
    const a = sum(notes.appeared.map((g) => g.amount));
    return a < -diff ? a : -diff;
  });

  /** The answer, with the figures of the banknotes finding. */
  const lead = $derived.by(() => {
    if (!notes || notes.reason !== null) return '';
    const head = `${money(notes.outstanding)} in banknotes should be outside the bank`;
    if (!world || world.reason !== null) return `${head}. ${world?.reason ?? ''}`;
    if (diff === 0n) return `${head}, and exactly that was found.`;
    if (diff > 0n) return `${head}; ${money(found)} was found, ${money(diff)} more than the bank handed out.`;
    return `${head}; ${money(found)} was found, so ${money(-diff)} was not found.`
      + (back > 0n ? ` ${back === -diff ? 'All' : `Up to ${money(back)}`} of that could be notes paid back through the ATM converter: that much appeared on accounts without a log row.` : '');
  });

  /** The count as the canvas draws it: handed out, paid back, made or destroyed outside, should be outside; found, not found. */
  const tiles = $derived.by(() => {
    if (!notes || notes.reason !== null) return [];
    const made = sum(notes.flow.map((f) => f.created)) - sum(notes.flow.map((f) => f.destroyed));
    // Without a banknote log (BankSystem 2.1.2) nothing made or destroyed outside the bank was recorded: not the same as none.
    const logged = app.saves.some((s) => s.sources.some((x) => x.id === 'bankDiag' && x.tables.some((t) => t.name === 'NoteFlow')));
    return [
      { label: 'Withdrawn as banknotes', raw: notes.ledger.out, value: money(notes.ledger.out), op: '', total: false, bad: false },
      { label: 'Paid back in', raw: -notes.ledger.back, value: signed(-notes.ledger.back), op: '', total: false, bad: false },
      { label: 'Made or destroyed outside the bank', raw: made, value: logged ? signed(made) : 'not logged', op: '', total: false, bad: false },
      { label: 'Should be outside the bank', raw: notes.outstanding, value: money(notes.outstanding), op: '=', total: true, bad: false },
      { label: 'Found', raw: found, value: money(found), op: '', total: true, bad: false },
      diff > 0n ? { label: 'Found beyond the count', raw: diff, value: signed(diff), op: '', total: true, bad: true }
        : { label: 'Not found', raw: -diff, value: money(-diff), op: '', total: true, bad: diff < 0n },
    ];
  });

  // ---- Where notes and valuables were found ----
  interface Row { key: string; label: string; href: string | null; sub: string; notes: bigint; pieces: number; server: string; uuid: string | null; account: number | null; at: WorldPlace | null }
  const pieces = (l: { count: number }[]) => l.reduce((a, s) => a + s.count, 0);
  const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const byNotes = (a: Row, b: Row) => (b.notes > a.notes ? 1 : b.notes < a.notes ? -1 : b.pieces - a.pieces);

  function placeRow(p: WorldPlace): Row {
    const whose = p.player ? `${p.player.name}'s slots` : p.account !== null ? `bound to account ${p.account}` : '';
    return {
      key: `${p.server}|${p.where}|${p.player?.uuid ?? ''}|${p.account ?? ''}`, label: capital(p.where),
      href: p.player ? `#/players/${encodeURIComponent(p.player.uuid)}` : p.account !== null ? `#/accounts/${p.account}` : null,
      sub: [p.server, whose, heldText([...p.stacks, ...p.valuables])].filter(Boolean).join(', '), notes: p.notes, pieces: pieces(p.valuables),
      server: p.server, uuid: p.player?.uuid ?? null, account: p.account, at: p,
    };
  }
  /** Players' inventories and ender chests, one row per server and place, and the places of the region scan. */
  const rows = $derived.by((): Row[] => {
    if (!world || world.reason !== null) return [];
    const out: Row[] = [];
    for (const p of world.players) {
      const held = new Map<string, typeof p.stacks>();
      for (const s of [...p.stacks, ...p.valuables]) if (here(s.server)) held.set(`${s.server}|${s.place}`, [...(held.get(`${s.server}|${s.place}`) ?? []), s]);
      for (const [k, list] of held) {
        const [srv, place] = k.split('|') as [string, string];
        out.push({ key: `${p.player.uuid}|${k}`, label: `${place === 'ender chest' ? 'Ender chest' : 'Inventory'} of ${p.player.name}`, href: `#/players/${encodeURIComponent(p.player.uuid)}`,
          sub: `${srv}, ${heldText(list)}`, notes: sum(list.map((s) => s.value ?? 0n)), pieces: pieces(list.filter((s) => s.value === null)),
          server: srv, uuid: p.player.uuid, account: null, at: null });
      }
    }
    for (const p of world.places) if (p.source !== 'offer' && here(p.server)) out.push(placeRow(p));
    return out.sort(byNotes);
  });
  // Rows with notes are the answer; places with only valuables wait behind one line under them.
  const noteRows = $derived(rows.filter((r) => r.notes > 0n));
  const onlyValuables = $derived(rows.filter((r) => r.notes === 0n));
  const offers = $derived(world && world.reason === null ? world.places.filter((p) => p.source === 'offer' && p.notes > 0n && here(p.server)).map(placeRow).sort(byNotes) : []);

  // CSV (AT-44): every place, also those with valuables only, and the places' coordinates.
  const placeTable = (list: Row[]) => () => ({
    columns: [['Where', 'text'], ['Server', 'text'], ['What', 'text'], ['Banknotes ($)', 'money'], ['Valuables (pieces)', 'count'], ['Player uuid', 'id'], ['Account', 'id'],
      ['Block or entity', 'id'], ['Dimension', 'id'], ['X', 'count'], ['Y', 'count'], ['Z', 'count']] as const,
    rows: list.map((r) => [r.label, r.server, r.sub, r.notes, r.pieces, r.uuid, r.account, r.at?.place, r.at?.dimension, r.at?.x, r.at?.y, r.at?.z]),
  });
  const blindTable = () => ({ columns: [['What', 'text'], ['Why', 'text']] as const, rows: blind.map((b) => [b.label, b.sub]) });

  // ---- Where the tool could not look ----
  const listed = (l: string[]) => (l.length <= 5 ? l.join(', ') : `${l.slice(0, 5).join(', ')} and ${count(l.length - 5)} more`);
  const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;
  const blind = $derived.by(() => {
    const out: { label: string; sub: string }[] = [];
    if (!world || !notes) return out;
    const unread = new Set(world.unreadable.map((p) => p.uuid));
    const lost = world.missing.filter((p) => !unread.has(p.uuid));
    if (lost.length) out.push({ label: listed(lost.map((p) => p.name)), sub: `${lost.length === 1 ? 'Has' : 'Have'} no player file in any loaded save, so what ${lost.length === 1 ? 'this player carries' : 'they carry'} is unknown.` });
    if (world.unreadable.length) out.push({ label: listed(world.unreadable.map((p) => p.name)), sub: `${world.unreadable.length === 1 ? 'The player file' : 'Their player files'} could not be read, so what ${world.unreadable.length === 1 ? 'this player carries' : 'they carry'} is unknown.` });
    if (world.unnamed) out.push({ label: plural(world.unnamed, 'id without a name', 'ids without a name'), sub: 'Placed orders or used the bank, but have no player file and no name in the save; they may never have joined.' });
    for (const s of world.without) out.push({ label: s, sub: 'This save has no player files (the world\'s playerdata folder), so inventories and ender chests there are unknown.' });
    if (world.altered.count) out.push({ label: plural(world.altered.count, 'note with a custom name or other changes', 'notes with a custom name or other changes'), sub: 'The bank refuses them, so they are not counted.' });
    if (scan && scan.state !== 'complete' && scan.state !== 'no region files') {
      out.push({ label: 'Chests, other blocks and entities', sub: scan.state === 'not run' ? 'The region scan has not been run.' : `The region scan read ${count(scan.files)} of ${count(scan.filesTotal)} region files; the rest is not counted.` });
    }
    const u = scan?.unreadable;
    if (u && (u.files || u.damaged || u.lz4 || u.tooLarge)) {
      const parts = [u.files ? plural(u.files, 'region file', 'region files') + ' not at all' : '', u.damaged ? plural(u.damaged, 'chunk damaged', 'chunks damaged') : '',
        u.lz4 ? plural(u.lz4, 'chunk', 'chunks') + ' packed with LZ4, which the tool does not read' : '', u.tooLarge ? plural(u.tooLarge, 'chunk', 'chunks') + ' too large to read safely' : ''];
      out.push({ label: 'Parts of the region files', sub: `Could not be read: ${parts.filter(Boolean).join(', ')}. What they hold is not counted.` });
    }
    if (scan?.dropped) out.push({ label: plural(scan.dropped, 'find', 'finds'), sub: 'Were over the limit of what the tool keeps per save (notes are kept before other items).' });
    if (world.placesCut) out.push({ label: plural(world.placesCut, 'more place', 'more places'), sub: 'The list shows the 2\'000 places with the most notes; the total counts all of them.' });
    return out;
  });

  // ---- The region scan ----
  const pct = (done: number, total: number) => (total ? Math.round((done / total) * 1000) / 10 : 0);
  const scanText = $derived.by(() => {
    if (!scan) return '';
    const size = `${bytes(scan.bytes)} of ${bytes(scan.bytesTotal)}`;
    if (scan.running) return `Reading the region files: ${count(scan.files)} of ${count(scan.filesTotal)}, ${size}. ${money(scan.notes)} in notes found in blocks and entities so far.`;
    return {
      'no region files': 'The loaded saves have no region files (an audit export carries none), so only player files and ender chests were looked at.',
      'not run': `Chests, other blocks and entities have not been looked at yet. The region scan reads the ${count(scan.filesTotal)} region files (${bytes(scan.bytesTotal)}) of the loaded saves in the background; the other screens stay usable meanwhile.`,
      'partial': `The region scan read ${count(scan.files)} of ${count(scan.filesTotal)} region files (${size}); it was stopped, or the world changed since. Notes in the rest of the world are not counted.`,
      'complete': `Every region file was read: ${count(scan.files)} files, ${bytes(scan.bytesTotal)}, ${count(scan.chunks)} chunks.`,
    }[scan.state];
  });
  const perSave = $derived(scan ? scan.saves.filter((s) => s.filesTotal > 0) : []);
</script>

<p class="intro">Banknotes are plain items and carry no owner. The tool counts how many should exist outside the bank, then looks through the player files and, when the region scan has run, every container and entity in the loaded saves to find them.</p>

{#if !notes || !world}
  <p class="small" aria-busy="true">Counting the banknotes…</p>
{:else if notes.reason !== null}
  <p class="empty">{notes.reason}</p>
{:else}
  <div class="answer">
    <p class="lead">{lead}</p>
    {#if finding}<a class="ref small" href="#/findings/{encodeURIComponent('banknotes:count')}">Open the finding</a>{/if}
  </div>
  {#if app.scope.from !== null || app.scope.to !== null}
    <p class="small" style="margin: -12px 0 0">The time range does not apply here: what the world holds is the state when each copy was taken, so the count runs to the copy as well.</p>
  {/if}

  <section class="card" aria-label="Banknote count">
    <h2 class="h2 h3">Banknote count</h2>
    <!-- Two rows: how the count is made, then what was found against it -->
    {#each [tiles.slice(0, 4), tiles.slice(4)] as group, i (i)}
    <div class="tiles">
      {#each group as t (t.label)}
        <div class="step">
          <span class="op" aria-hidden="true">{t.op}</span>
          <div class="tile" class:total={t.total}>
            <span class="tlabel">{t.label}</span>
            <span class="tvalue" style:color={t.bad ? 'var(--high)' : undefined}>{t.value}</span>
          </div>
        </div>
      {/each}
    </div>
    {/each}
    {#each notes.missing as m}
      <p class="small" style="margin: 12px 0 0; text-wrap: pretty">{m}</p>
    {/each}
  </section>

  {#if scan}
    <section class="card" aria-label="Region scan">
      <div class="cardhead">
        <h2 class="h2 h3" style="flex: 1 1 auto">Region scan</h2>
        {#if scan.running}
          <button type="button" class="btn ghost" onclick={stopScan}>Stop</button>
        {:else if scan.state === 'not run'}
          <button type="button" class="btn primary" onclick={startScan}>Start the region scan</button>
        {:else if scan.state === 'partial'}
          <button type="button" class="btn primary" onclick={startScan}>Continue</button>
        {/if}
      </div>
      <p class="scantext" aria-live="polite">{scanText}</p>
      {#if scan.running || scan.state === 'partial'}
        <div class="bar" role="progressbar" aria-label="Region scan" aria-valuemin={0} aria-valuemax={scan.filesTotal} aria-valuenow={scan.files}>
          <span style="width: {pct(scan.files, scan.filesTotal)}%"></span>
        </div>
      {/if}
      {#if perSave.length > 1}
        <div class="saves">
          {#each perSave as s (s.save)}
            <span>{s.save}: {count(s.files)} of {count(s.filesTotal)} region files{s.state === 'complete' ? ', complete' : ''}</span>
          {/each}
        </div>
      {/if}
    </section>
  {/if}

  {#if server !== null}
    <p class="small" style="margin: 0">Only what was found on {server} is listed. The count above is for the whole network: notes move between servers with the players.</p>
  {/if}

  <div class="pair">
    <section class="card wide" aria-label="Where banknotes were found">
      <div class="cardhead">
        <h2 class="h2 h3" style="flex: 1 1 auto">Where banknotes were found</h2>
        {#if rows.length}<CsvButton screen="saves" table="world-found" what="every place notes or valuables were found" make={placeTable(rows)} />{/if}
        {#if noteRows.length > TOP}<button type="button" class="link" onclick={() => (allFound = !allFound)}>{allFound ? 'Show fewer' : `Show all ${count(noteRows.length)}`}</button>{/if}
      </div>
      {#if world.reason !== null}
        <p class="none">{world.reason}</p>
      {:else if rows.length === 0}
        <p class="none">No banknotes or valuables were found{server === null ? '' : ` on ${server}`}.</p>
      {:else}
        {#snippet list(shown: Row[])}
          <div class="list">
            {#each shown as r (r.key)}
              <div class="item">
                <span class="who">
                  {#if r.href}<a class="ref strong" href={r.href}>{r.label}</a>{:else}<span class="strong">{r.label}</span>{/if}
                  <span class="small">{r.sub}</span>
                </span>
                <span class="num" title={money(r.notes)}>{r.notes > 0n ? moneyShort(r.notes) : 'no notes'}</span>
              </div>
            {/each}
          </div>
        {/snippet}
        {#if noteRows.length}
          {@render list(allFound ? noteRows : noteRows.slice(0, TOP))}
        {:else}
          <p class="none">No banknotes were found{server === null ? '' : ` on ${server}`}.</p>
        {/if}
        {#if onlyValuables.length}
          <div class="more">
            <span class="small">{count(onlyValuables.length)} {onlyValuables.length === 1 ? 'more place holds' : 'more places hold'} only valuables</span>
            <button type="button" class="link" aria-expanded={valuables} onclick={() => (valuables = !valuables)}>{valuables ? 'Hide them' : 'Show them'}</button>
          </div>
          {#if valuables}{@render list(onlyValuables)}{/if}
        {/if}
        <p class="small" style="margin: 12px 0 0">Valuables are items with a market. Places come from the region scan, players' items from their player files.</p>
      {/if}
    </section>

    <section class="card" aria-label="Where the tool could not look">
      <div class="cardhead">
        <h2 class="h2 h3" style="flex: 1 1 auto">Where the tool could not look</h2>
        {#if blind.length}<CsvButton screen="saves" table="world-not-checked" what="where the tool could not look" make={blindTable} />{/if}
      </div>
      {#if blind.length === 0}
        <p class="none">Nowhere: every player file and every region file was read.</p>
      {:else}
        <div class="list">
          {#each blind as b, i (i)}
            <div class="item col"><span class="strong">{b.label}</span><span class="small" style="text-wrap: pretty">{b.sub}</span></div>
          {/each}
        </div>
      {/if}
    </section>
  </div>

  {#if offers.length}
    <section class="card" aria-label="Prices in villagers' offers">
      <div class="cardhead">
        <h2 class="h2 h3" style="flex: 1 1 auto">Prices in villagers' offers</h2>
        <CsvButton screen="saves" table="world-offers" what="the villagers' offers" make={placeTable(offers)} />
        {#if offers.length > TOP}<button type="button" class="link" onclick={() => (allOffers = !allOffers)}>{allOffers ? 'Show fewer' : `Show all ${count(offers.length)}`}</button>{/if}
      </div>
      <p class="small" style="margin: 2px 0 0">Villagers trade in notes on these servers. A note in an offer is a price, not a note that exists, so the {money(world.offers)} named here are not counted.</p>
      <div class="list">
        {#each allOffers ? offers : offers.slice(0, TOP) as r (r.key)}
          <div class="item">
            <span class="who"><span class="strong">{r.label}</span><span class="small">{r.sub}</span></span>
            <span class="num dim" title={money(r.notes)}>{moneyShort(r.notes)}</span>
          </div>
        {/each}
      </div>
    </section>
  {/if}
{/if}

<style>
  .intro { margin: 0; max-width: 820px; color: var(--text2); text-wrap: pretty; }
  .answer { display: flex; flex-direction: column; gap: 6px; }
  .lead { margin: 0; max-width: 960px; font-size: 16px; line-height: 24px; text-wrap: pretty; }
  .empty { margin: 0; padding: 24px; border-radius: 14px; border: 1px dashed var(--line2); color: var(--text2); }
  .h3 { font-size: 17px; line-height: 24px; }
  .cardhead { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .tiles { display: flex; flex-wrap: wrap; align-items: stretch; gap: 12px 8px; margin-top: 16px; }
  .step { display: flex; align-items: center; gap: 8px; }
  .op { flex: none; width: 14px; text-align: center; font-size: 18px; color: var(--text3); }
  .tile { display: flex; flex-direction: column; gap: 4px; min-width: 118px; padding: 12px 14px; border-radius: 10px; }
  .tile.total { background: var(--raised); }
  .tlabel { font-size: 12px; line-height: 16px; color: var(--text3); }
  .tvalue { font-size: 17px; line-height: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .scantext { margin: 8px 0 0; color: var(--text2); text-wrap: pretty; }
  .bar { height: 8px; margin-top: 16px; border-radius: 4px; background: var(--raised); overflow: hidden; }
  .bar span { display: block; height: 100%; border-radius: 4px; background: var(--accent); transition: width 0.2s; }
  .saves { display: flex; flex-wrap: wrap; gap: 4px 24px; margin-top: 12px; font-size: 13px; color: var(--text2); }
  .primary { padding: 0 18px; border: 0; background: var(--accent); color: var(--onaccent); font-weight: 600; }
  .primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 85%, var(--text)); }
  .ghost { padding: 0 14px; border-color: var(--line2); background: transparent; font-weight: 500; }
  .pair { display: flex; flex-wrap: wrap; gap: 24px; }
  .pair > .card { flex: 1 1 320px; min-width: 0; box-sizing: border-box; }
  .pair > .wide { flex: 1.5 1 420px; }
  .list { display: flex; flex-direction: column; margin-top: 8px; }
  .item { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--line); }
  .item.col { flex-direction: column; align-items: stretch; gap: 0; }
  .who { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
  .strong { font-weight: 500; }
  .ref { color: var(--accent); }
  .num { flex: none; font-weight: 500; font-variant-numeric: tabular-nums; }
  .dim { color: var(--text2); }
  .none { margin: 12px 0 0; color: var(--text2); }
  .more { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; padding: 12px 0 0; border-top: 1px solid var(--line); }
  .link { padding: 0; border: 0; background: none; font-size: 13px; font-weight: 500; color: var(--accent); }
</style>
