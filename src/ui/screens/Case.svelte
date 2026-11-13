<script lang="ts">
  // Case and report: where the incident's money stands, the evidence, what each player may keep and
  // the command lines for the admins. The engine works the amounts out (query/takeback.ts); nothing here changes a save.
  import type { Answer, CaseChoices, Cutoff, Finding, Incident, ItemRow, Scope, TakeBack, TakeBackRow } from '../../shared/api.ts';
  import { commands, itemList, type BankVersion } from '../../shared/commands.ts';
  import { describe, span } from '../../shared/finding.ts';
  import { count, items as quantity, money, moneyShort, time } from '../../shared/fmt.ts';
  import { incidentTitle } from '../../shared/incident.ts';
  import CsvButton from '../app/CsvButton.svelte';
  import { app, engine, exportReport, setChoices, setMark } from '../app/state.svelte.ts';
  import { LEVEL_COLOR, words } from '../app/words.ts';

  let { selected }: { selected: string | null } = $props();
  const ALL: Scope = { from: null, to: null, server: null };
  const ROWS = 10;

  let list = $state<Incident[] | null>(null);
  let itemRows = $state(new Map<number, ItemRow>());
  let byId = $state(new Map<string, Finding>());
  let tb = $state<TakeBack | null>(null);
  $effect(() => {
    const rules = $state.snapshot(app.rules);
    void app.saves.length;
    let stale = false;
    void Promise.all([engine.incidents(ALL, rules), engine.items(), engine.findings(ALL, rules)]).then(([r, i, f]) => {
      if (stale) return;
      list = r.incidents;
      itemRows = new Map(i.map((x) => [x.id, x]));
      byId = new Map(f.findings.map((x) => [x.id, x]));
    });
    return () => (stale = true);
  });
  const w = $derived(words(itemRows));
  const incidentId = $derived(selected ?? app.incident?.id ?? list?.[0]?.id ?? null);
  // A string, so storing an answer or the evidence order does not ask the engine again.
  const cutKey = $derived(JSON.stringify(app.choices.cutoff));
  $effect(() => {
    const id = incidentId, cut = JSON.parse(cutKey) as Cutoff, rules = $state.snapshot(app.rules);
    void app.saves.length;
    if (id === null) return;
    let stale = false;
    void engine.takeBack(id, cut, rules).then((r) => {
      if (!stale) tb = r;
    });
    return () => (stale = true);
  });
  const ready = $derived(tb && tb.incident?.id === incidentId ? tb : null);
  const rows = $derived(ready?.rows ?? []);
  const when = (ms: number) => time(ms).replace(/ \d{4},/, ',').slice(0, -3); // 4 Nov, 20:02
  const day = (ms: number) => time(ms).split(',')[0]!.replace(/ \d{4}$/, ''); // 3 Nov

  // ---- Where the money stands ----
  const answer = (key: string): Answer => app.choices.answers[key] ?? 'unsure';
  const ANSWER: Record<Answer, { label: string; color: string; note: (v: string) => string }> = {
    yes: { label: 'Removed by an admin already', color: 'var(--up)', note: () => 'Good. That amount is counted as recovered and is not taken a second time.' },
    unsure: { label: 'Left the account, not confirmed', color: 'var(--med)', note: (v) => `Ask before running the commands. If nobody removed it, ${v} is missing and has to be traced.` },
    no: { label: 'Gone, nobody knows where', color: 'var(--crit)', note: (v) => `Then ${v} is missing. The report will list it as an open point and the tool keeps the finding open.` },
  };
  const removals = $derived(rows.flatMap((r) => r.removed.map((g) => ({ ...g, row: r }))).sort((a, b) => Number(b.amount - a.amount)));
  const sum = (v: bigint[]) => v.reduce((s, x) => s + x, 0n);
  const bar = $derived(ready ? [
    { label: 'Taken back by this plan', value: sum(rows.map((r) => r.take)), color: 'var(--accent)', sub: '' },
    ...(['yes', 'unsure', 'no'] as const).map((a) => ({ label: ANSWER[a].label, value: sum(removals.filter((g) => answer(g.key) === a).map((g) => g.amount)), color: ANSWER[a].color, sub: '' })),
    { label: 'Spent on items, removed as items', value: ready.items, color: 'var(--text3)', sub: '' },
    { label: 'Banknotes still to find in the world', value: ready.notes.outside, color: 'var(--high)',
      sub: [[ready.notes.inFiles, 'in their own files'], [ready.notes.elsewhere ?? 0n, 'found elsewhere'], [ready.notes.notFound ?? 0n, 'not found']].filter(([v]) => (v as bigint) > 0n).map(([v, t]) => `${moneyShort(v as bigint)} ${t}`).join(', ') },
  ].filter((g) => g.value > 0n) : []);
  const whole = $derived(sum(bar.map((g) => g.value)));
  const open = $derived([
    ...removals.filter((g) => answer(g.key) === 'unsure').map((g) => `Ask the admins whether they removed ${moneyShort(g.amount)} from account ${g.row.account} (${when(g.from)} to ${when(g.to)}).`),
    ...removals.filter((g) => answer(g.key) === 'no').map((g) => `${moneyShort(g.amount)} left account ${g.row.account} (${when(g.from)} to ${when(g.to)}) and nobody knows where.`),
    ...(ready?.notes.notFound ? [`${moneyShort(ready.notes.notFound)} of banknotes were not found in any file or block the tool read.`] : []),
  ]);

  // ---- Evidence: the pins, in the order the user set ----
  const pinned = $derived.by(() => {
    const ids = Object.keys(app.marks).filter((id) => app.marks[id]!.pinned), order = app.choices.order;
    const pos = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length + ids.indexOf(id));
    return ids.sort((a, b) => pos(a) - pos(b));
  });
  const BASIS: Record<Finding['basis'], string> = { proven: 'Proven', estimate: 'Estimate', hint: 'Hint', 'as raised': 'As the mod raised it' };
  function move(i: number, by: number) {
    const ids = [...pinned];
    [ids[i], ids[i + by]] = [ids[i + by]!, ids[i]!];
    void setChoices({ ...$state.snapshot(app.choices), order: ids });
  }
  const unpin = (id: string) => setMark(id, { ...$state.snapshot(app.marks[id]!), pinned: false });

  // ---- The cutoff and the admin questions ----
  const cuts = $derived(ready ? [
    { kind: 'day' as const, label: `The end of ${day(ready.day + 1 - 86_400_000)}`, sub: 'Recommended. Before any flagged trade, so players keep what normal trading earned them.' },
    { kind: 'first' as const, label: `${when(ready.first + 1)}, right before the incident's first finding`, sub: 'Treats everything before it as normal trading.' },
    { kind: 'custom' as const, label: 'A time you pick', sub: app.choices.cutoff.kind === 'custom' ? `Now ${time(ready.at)}.` : 'Each player keeps the balance of the last snapshot at or before it.' },
  ] : []);
  function pickCut(kind: Cutoff['kind']) {
    const c = $state.snapshot(app.choices);
    void setChoices({ ...c, cutoff: { kind, at: kind === 'custom' ? (c.cutoff.at ?? ready?.at ?? null) : c.cutoff.at } });
  }
  // The input shows and takes the computer's time zone, as every time on the screens.
  const local = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  function pickTime(value: string) {
    const at = new Date(value).getTime();
    if (Number.isFinite(at)) void setChoices({ ...$state.snapshot(app.choices), cutoff: { kind: 'custom', at } });
  }
  const setAnswer = (key: string, a: Answer) => setChoices({ ...$state.snapshot(app.choices), answers: { ...$state.snapshot(app.choices.answers), [key]: a } });

  // ---- Per account, and the commands ----
  let shown = $state<number | null>(null), allItems = $state(false), allQuestions = $state(false);
  const QUESTIONS = 3;
  const nItems = (r: TakeBackRow) => sum(r.items.map((i) => i.remove));
  let version = $state<BankVersion | null>(null);
  const v = $derived(version ?? (ready?.legacy ? '2.1.2' : '2.2.0'));
  const lines = $derived(commands(rows, v));
  const itemLines = $derived(itemList(rows, w.itemName));
  // CSV (AT-44): the table per account and every item of every account, with the ids.
  const takeTable = () => ({
    columns: [['Player', 'text'], ['Player uuid', 'id'], ['Account', 'id'], ['Likely paid in notes of', 'text'], ['Their uuid', 'id'], ['Those notes ($)', 'money'],
      ['Balance at the cutoff ($)', 'money'], ['Snapshot used', 'time'], ['Other markets since ($)', 'money'], ['Has now ($)', 'money'], ['May keep ($)', 'money'], ['Take back ($)', 'money'],
      ['Items to remove', 'quantity'], ['Left without a log row ($)', 'money']] as const,
    rows: rows.map((r) => [r.player.name, r.player.uuid, r.account, r.via?.name, r.via?.uuid, r.via?.notes, r.start, r.from, r.other, r.now, r.keep, r.take, nItems(r), sum(r.removed.map((g) => g.amount))]),
  });
  const itemTable = () => ({
    columns: [['Player', 'text'], ['Player uuid', 'id'], ['Account', 'id'], ['Item', 'text'], ['Item id', 'id'], ['At the cutoff', 'quantity'], ['Bought since', 'quantity'],
      ['Money spent ($)', 'money'], ['Now', 'quantity'], ['Remove', 'quantity']] as const,
    rows: rows.flatMap((r) => r.items.map((i) => [r.player.name, r.player.uuid, r.account, w.itemName(i.item), i.item, i.before, i.bought, i.spent, i.now, i.remove])),
  });
  let copied = $state('');
  async function copy(what: string, text: string[]) {
    await navigator.clipboard.writeText(text.join('\n'));
    copied = what;
  }

  // ---- The report: style and language are stored with the choices ----
  const STYLE_NOTE = {
    admin: 'For admins: about two pages in plain language: what happened, what to take back, the commands, where the banknotes are and what could not be checked.',
    tech: 'Technical: the same, plus every finding with its rule, measured value and record ids, the coverage of each save, the warnings and the versions.',
  };
  const pick = (part: Partial<CaseChoices>) => setChoices({ ...$state.snapshot(app.choices), ...part });
  let saving = $state(false), saved = $state<{ path: string } | { error: string } | null>(null);
  async function save() {
    if (!incidentId) return;
    saving = true;
    try {
      saved = await exportReport(incidentId, { style: app.choices.style, lang: app.choices.lang, version: v });
    } catch (e) {
      saved = { error: `The report could not be exported: ${(e as Error).message}` };
    } finally {
      saving = false;
    }
  }
</script>

<div class="top">
  <div style="flex: 1 1 320px; min-width: 0">
    <h1 class="h1">{ready ? `Case: ${incidentTitle(ready.incident!, w.itemName)}` : 'Case and report'}</h1>
    <p class="sub">Collect the evidence, decide what each player may keep, then hand the report to the admins.</p>
  </div>
  <div class="controls">
  <div role="group" aria-label="Report style" class="seg">
    {#each [['admin', 'For admins'], ['tech', 'Technical']] as const as [k, label] (k)}<button type="button" aria-pressed={app.choices.style === k} onclick={() => pick({ style: k })}>{label}</button>{/each}
  </div>
  <div role="group" aria-label="Report language" class="seg">
    {#each [['en', 'English'], ['de', 'Deutsch']] as const as [k, label] (k)}<button type="button" aria-pressed={app.choices.lang === k} onclick={() => pick({ lang: k })}>{label}</button>{/each}
  </div>
  <button type="button" class="primary" disabled={!ready || ready.reason !== null || saving} onclick={save}>
    <svg width="18" height="18" viewBox="0 0 24 24" class="icon" aria-hidden="true" style="stroke-width: 2"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>{saving ? 'Exporting…' : 'Export the report'}
  </button>
  </div>
</div>
<div class="note">
  <p class="small">{STYLE_NOTE[app.choices.style]} Saved as a web page (HTML) or as PDF: pick the type in the save dialog.</p>
  {#if saved}<p class="small" role="status" style="color: {'error' in saved ? 'var(--crit)' : 'var(--text2)'}">{'error' in saved ? saved.error : `Saved to ${saved.path}`}</p>{/if}
</div>

{#if list === null}
  <p class="small" aria-busy="true" style="margin: 0">Loading the incidents…</p>
{:else if list.length === 0}
  <p class="empty">No incident with these rule settings, so there is nothing to take back. Findings that belong together form an incident.</p>
{:else}
  {#if list.length > 1}
    <label class="choose"><span class="small">Incident</span>
      <select value={incidentId} onchange={(e) => (location.hash = '#/case/' + encodeURIComponent(e.currentTarget.value))}>
        {#each list as i (i.id)}<option value={i.id}>{incidentTitle(i, w.itemName)}, {time(i.start)}</option>{/each}
      </select>
    </label>
  {/if}
  {#if !ready}
    <p class="small" aria-busy="true" style="margin: 0">Working out what to take back…</p>
  {:else if ready.reason !== null}
    <p class="empty">{ready.reason}</p>
  {:else}
    <section class="card" aria-label="Where the money stands">
      <div class="head">
        <h2 class="h2" style="flex: 1 1 auto">Where the {moneyShort(whole)} stands</h2>
        <a class="more" href={'#/flow/' + encodeURIComponent(ready.incident!.id)}>Open the money flow</a>
      </div>
      <div class="bar" aria-hidden="true">{#each bar as g (g.label)}<span style="flex: {Number((g.value * 1000n) / (whole || 1n)) || 1} 1 0; background: {g.color}"></span>{/each}</div>
      <div class="legend">
        {#each bar as g (g.label)}
          <div class="lg">
            <span class="sw" style="background: {g.color}" aria-hidden="true"></span>
            <span class="lgt"><span class="small" style="color: var(--text2)">{g.label}</span><span class="lgv">{moneyShort(g.value)}</span>{#if g.sub}<span class="small">{g.sub}</span>{/if}</span>
          </div>
        {/each}
      </div>
      {#if open.length}
        <h3 class="label" style="margin-top: 20px">Still open</h3>
        <ul class="open">{#each open as o, i (i)}<li>{o}</li>{/each}</ul>
      {/if}
    </section>

    <div class="cols">
      <section class="card ev" aria-label="Evidence">
        <div class="head"><h2 class="h2" style="flex: 1 1 auto">Evidence</h2><span class="small">{count(pinned.length)} pinned</span></div>
        <div class="pins">
          {#each pinned as id, i (id)}
            {@const m = app.marks[id]!}
            {@const f = byId.get(id)}
            <div class="pin">
              <div class="pintop">
                <span class="dot" style="background: {f ? LEVEL_COLOR[f.level] : 'var(--text3)'}" aria-hidden="true"></span>
                <a class="pinlink" href={'#/findings/' + encodeURIComponent(id)}>
                  <span style="font-weight: 500; text-wrap: pretty">{f ? describe(f, w).title : m.title}</span>
                  <span class="small">{f ? [f.players.map((p) => p.name).join(', '), span(f.start, f.end)].filter(Boolean).join(' · ') : time(m.start)}</span>
                </a>
                <div class="tools">
                  <button type="button" class="tool" aria-label="Move up" disabled={i === 0} onclick={() => move(i, -1)}><svg width="16" height="16" viewBox="0 0 24 24" class="icon" aria-hidden="true" style="stroke-width: 2"><path d="M6 15l6-6 6 6" /></svg></button>
                  <button type="button" class="tool" aria-label="Move down" disabled={i === pinned.length - 1} onclick={() => move(i, 1)}><svg width="16" height="16" viewBox="0 0 24 24" class="icon" aria-hidden="true" style="stroke-width: 2"><path d="M6 9l6 6 6-6" /></svg></button>
                  <button type="button" class="tool" aria-label="Remove from the case" onclick={() => unpin(id)}><svg width="16" height="16" viewBox="0 0 24 24" class="icon" aria-hidden="true" style="stroke-width: 2"><path d="M6 6l12 12M18 6L6 18" /></svg></button>
                </div>
              </div>
              <div class="pinfoot">
                {#if f}<span class="badge" class:est={f.basis !== 'proven'}>{BASIS[f.basis]}</span>{/if}
                <span class="small" style="color: var(--text2); text-wrap: pretty">{m.note.trim() || 'No note yet'}</span>
              </div>
            </div>
          {:else}
            <p class="empty" style="padding: 16px">Nothing pinned yet. Use Pin to case on any finding.</p>
          {/each}
        </div>
      </section>

      <section class="card take" aria-label="What to take back">
        <div>
          <h2 class="h2">What to take back</h2>
          <p class="small" style="margin: 2px 0 0">The tool only works this out. Nothing is changed on the server until an admin runs the commands.</p>
        </div>

        <div>
          <h3 class="step">1. Each player keeps the balance they had at</h3>
          <div role="group" aria-label="Moment to keep" class="cuts">
            {#each cuts as c (c.kind)}
              <button type="button" class="cut" aria-pressed={app.choices.cutoff.kind === c.kind} onclick={() => pickCut(c.kind)}>
                <span style="font-weight: 600">{c.label}</span><span class="small" style="color: var(--text2); text-wrap: pretty">{c.sub}</span>
              </button>
            {/each}
          </div>
          {#if app.choices.cutoff.kind === 'custom'}
            <label class="pickat"><span class="small">The time, in this computer's time zone</span>
              <input type="datetime-local" step="1" value={local(ready.at)} onchange={(e) => pickTime(e.currentTarget.value)} />
            </label>
          {/if}
        </div>

        {#each allQuestions ? removals : removals.slice(0, QUESTIONS) as g, i (g.key)}
          <div>
            <h3 class="step">{removals.length > 1 ? `2.${i + 1}` : '2.'} Did an admin remove {moneyShort(g.amount)} from {g.row.player.name} on {when(g.from)}?</h3>
            <div class="qa">
              <div role="group" aria-label="Answer for account {g.row.account} on {when(g.from)}" class="seg">
                {#each [['yes', 'Yes'], ['unsure', 'Not sure'], ['no', 'No']] as const as [a, label] (a)}
                  <button type="button" aria-pressed={answer(g.key) === a} onclick={() => setAnswer(g.key, a)}>{label}</button>
                {/each}
              </div>
              <p class="small" style="flex: 1 1 260px; min-width: 0; margin: 0; color: var(--text2); text-wrap: pretty">{ANSWER[answer(g.key)].note(moneyShort(g.amount))}</p>
            </div>
          </div>
        {/each}
        {#if removals.length > QUESTIONS}<button type="button" class="link" style="align-self: flex-start; margin-top: -12px" onclick={() => (allQuestions = !allQuestions)}>{allQuestions ? 'Show fewer' : `Show all ${count(removals.length)}`}</button>{/if}

        <div>
          <div class="head" style="margin-bottom: 8px">
            <h3 class="step" style="flex: 1 1 auto; margin: 0">{removals.length ? '3.' : '2.'} Per account</h3>
            {#if rows.length}<CsvButton screen="case" table="take-back" what="what to take back per account" make={takeTable} />{/if}
            {#if rows.some((r) => r.items.length)}<CsvButton screen="case" table="items" what="the items to remove" text="Items as CSV" make={itemTable} />{/if}
          </div>
          <div class="scroll">
            <table>
              <thead><tr><th>Account</th><th class="r">Has now</th><th class="r">May keep</th><th class="r">Take back</th></tr></thead>
              <tbody>
                {#each rows as r (r.account)}
                  <tr>
                    <td><a class="name" href="#/accounts/{r.account}">{r.player.name}</a><span class="small cell">Account {r.account}{r.via ? `, likely paid in ${money(r.via.notes)} of ${r.via.name}'s notes` : ''}</span></td>
                    <td class="r dim">{money(r.now)}</td>
                    <td class="r">{money(r.keep)}{#if !r.via && r.other > 0n && r.keep > r.start}<span class="small cell">{money(r.start)} at the cutoff, {money(r.keep - r.start)} from other markets</span>{/if}{#if !r.via && r.from !== null && r.from > ready.at}<span class="small cell">no snapshot before the cutoff: its first one</span>{/if}</td>
                    <td class="r"><span class="takev">{money(r.take)}</span>
                      {#if !r.via && r.now < r.start}<span class="small cell wrap">Nothing to take back from the bank: it holds less than at the cutoff. The rest is in items or notes.</span>{/if}
                      {#if r.items.length}<button type="button" class="link cell" aria-expanded={shown === r.account} onclick={() => ((shown = shown === r.account ? null : r.account), (allItems = false))}>and {quantity(nItems(r))} items</button>{/if}
                    </td>
                  </tr>
                  {#if shown === r.account}
                    <tr class="items"><td colspan="4">
                      <div class="scroll">
                        <table>
                          <thead><tr><th>Item</th><th class="r">At the cutoff</th><th class="r">Bought since</th><th class="r">Money spent</th><th class="r">Now</th><th class="r">Remove</th></tr></thead>
                          <tbody>
                            {#each allItems ? r.items : r.items.slice(0, ROWS) as i (i.item)}
                              <tr><td>{w.itemName(i.item)}</td><td class="r dim">{quantity(i.before)}</td><td class="r dim">{quantity(i.bought)}</td><td class="r dim">{money(i.spent)}</td><td class="r dim">{quantity(i.now)}</td><td class="r" style="font-weight: 600">{quantity(i.remove)}</td></tr>
                            {/each}
                          </tbody>
                        </table>
                      </div>
                      {#if r.items.length > ROWS}<button type="button" class="link" style="margin-top: 8px" onclick={() => (allItems = !allItems)}>{allItems ? 'Show fewer' : `Show all ${count(r.items.length)}`}</button>{/if}
                      <p class="small" style="margin: 8px 0 0">Per item: what was bought since the cutoff, at most what was added since. What the player put in themselves stays.</p>
                    </td></tr>
                  {/if}
                {/each}
                <tr class="total"><td>Total</td><td></td><td></td><td class="r">{money(sum(rows.map((r) => r.take)))}</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <div class="head" style="margin-bottom: 8px">
            <h3 class="step" style="flex: 1 1 auto; margin: 0">{removals.length ? '4.' : '3.'} Commands for the admins</h3>
            <div role="group" aria-label="BankSystem version on the server" class="seg">
              {#each ['2.1.2', '2.2.0'] as const as x (x)}<button type="button" aria-pressed={v === x} onclick={() => (version = x)}>BankSystem {x}</button>{/each}
            </div>
            <button type="button" class="btn" disabled={!lines.length} onclick={() => copy('commands', lines)}>{copied === 'commands' ? 'Copied' : 'Copy'}</button>
          </div>
          {#if lines.length}
            <pre class="code">{lines.join('\n')}</pre>
            <p class="small" style="margin: 8px 0 0">
              Run them in game as an admin player: BankSystem does not take them from the server console. <code>/money remove</code> takes the player's name and works on their personal account. It reads the amount as a 32-bit number, so a large amount is split into parts it takes exactly; an account that keeps nothing is set to 0 instead, because the last part would be refused.
              {#if v === '2.2.0'}The first lines freeze the accounts so nothing moves while the admins work; the last lines unfreeze them, after the items below.{/if}
            </p>
          {:else}
            <p class="small" style="margin: 0">Nothing to take back from the bank with this cutoff.</p>
          {/if}
          {#if itemLines.length}
            <div class="head" style="margin: 16px 0 8px">
              <h3 class="step" style="flex: 1 1 auto; margin: 0">Items to remove</h3>
              <button type="button" class="btn" onclick={() => copy('items', itemLines)}>{copied === 'items' ? 'Copied' : 'Copy the list'}</button>
            </div>
            <p class="small" style="margin: 0 0 8px">BankSystem has no command that removes items from an account, so they are a list: change each balance in <code>/bank &lt;player&gt; manage</code>.</p>
            <pre class="code list">{itemLines.join('\n')}</pre>
          {/if}
        </div>
      </section>
    </div>

    <div class="notes">
      <p class="small">From the cutoff, {time(ready.at)}, to {ready.to === null ? 'when the copy was taken' : `the copy, ${time(ready.to)}`}. May keep is the balance at the cutoff plus what trading on markets outside the incident earned since, at most what the account holds.</p>
      {#each ready.missing as m}<p class="small">{m}</p>{/each}
    </div>
  {/if}
{/if}

<style>
  .top { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 16px; }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
  .top .seg { background: var(--card); }
  .primary { display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px; border: 0; border-radius: 10px; font-weight: 600; background: var(--accent); color: var(--onaccent); }
  .primary:disabled { opacity: 0.5; }
  .note { display: flex; flex-direction: column; gap: 4px; margin-top: -12px; }
  .note p { margin: 0; overflow-wrap: anywhere; }
  .choose { display: flex; align-items: center; gap: 12px; max-width: 720px; }
  select { flex: 1 1 auto; min-width: 0; height: 40px; padding: 0 10px; border-radius: 10px; border: 1px solid var(--line2); background: var(--card); color: var(--text); font: inherit; }
  .empty { margin: 0; padding: 24px; border-radius: 14px; border: 1px dashed var(--line2); color: var(--text2); }
  .head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .more { font-size: 13px; font-weight: 500; color: var(--accent); }
  .bar { display: flex; gap: 3px; height: 14px; margin-top: 16px; }
  .bar span { border-radius: 4px; min-width: 4px; }
  .legend { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 16px; margin-top: 16px; }
  .lg { display: flex; align-items: flex-start; gap: 10px; }
  .sw { flex: none; width: 10px; height: 10px; margin-top: 5px; border-radius: 3px; }
  .lgt { display: flex; flex-direction: column; min-width: 0; }
  .lgv { font-size: 18px; line-height: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .label { margin: 0 0 4px; font-size: 12px; line-height: 16px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text3); }
  .open { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; color: var(--text2); }
  .cols { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 24px; }
  .ev { flex: 1 1 300px; min-width: 0; }
  .take { flex: 2.4 1 640px; min-width: 0; display: flex; flex-direction: column; gap: 24px; }
  .pins { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
  .pin { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; border-radius: 10px; border: 1px solid var(--line); }
  .pintop { display: flex; align-items: flex-start; gap: 12px; }
  .dot { flex: none; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; }
  .pinlink { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .tools { flex: none; display: flex; margin: -6px -8px 0 0; }
  .tool { width: 32px; height: 32px; padding: 0; border: 0; border-radius: 8px; background: transparent; display: flex; align-items: center; justify-content: center; color: var(--text3); }
  .tool:hover:not(:disabled) { background: var(--raised); color: var(--text); }
  .pinfoot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-left: 20px; }
  .badge { flex: none; height: 24px; padding: 0 8px; box-sizing: border-box; border-radius: 6px; font-size: 12px; line-height: 22px; font-weight: 500; color: var(--text2); border: 1px solid var(--line2); }
  .badge.est { color: var(--high); border: 1px dashed var(--high); }
  .step { margin: 0 0 8px; font-size: 14px; line-height: 20px; font-weight: 600; }
  .cuts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); gap: 12px; }
  .cut { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; border-radius: 10px; text-align: left; border: 1px solid var(--line); background: transparent; }
  .cut:hover { background: var(--raised); }
  .cut[aria-pressed='true'] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .pickat { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 12px; }
  .pickat input { height: 36px; padding: 0 10px; border-radius: 10px; border: 1px solid var(--line2); background: var(--bg); color: var(--text); }
  .qa { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .seg { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px; border-radius: 10px; background: var(--bg); border: 1px solid var(--line); }
  .seg button { height: 32px; padding: 0 14px; border: 0; border-radius: 7px; font-weight: 500; background: transparent; color: var(--text2); }
  .seg button[aria-pressed='true'] { background: var(--raised); color: var(--text); }
  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th { padding: 0 12px 10px; font-size: 12px; font-weight: 600; color: var(--text3); text-align: left; white-space: nowrap; }
  td { padding: 12px; border-top: 1px solid var(--line); vertical-align: top; white-space: nowrap; }
  th:first-child, td:first-child { padding-left: 0; }
  th:last-child, td:last-child { padding-right: 0; }
  .r { text-align: right; }
  .dim { color: var(--text2); }
  .name { font-weight: 500; }
  .cell { display: block; white-space: normal; } /* sub-lines wrap: the amounts set the column widths */
  .wrap { white-space: normal; max-width: 260px; margin-left: auto; }
  .takev { display: block; font-weight: 600; }
  .items > td { padding: 8px 0 16px; white-space: normal; }
  .items .scroll { width: 0; min-width: 100%; } /* scrolls on its own instead of widening the table */
  td:first-child { white-space: normal; min-width: 160px; }
  .items th, .items td { font-size: 13px; padding-top: 8px; padding-bottom: 8px; }
  .total td { border-top: 1px solid var(--line2); font-weight: 600; padding-bottom: 0; }
  .link { padding: 0; border: 0; background: none; font-size: 13px; font-weight: 500; color: var(--accent); }
  td .link { margin-left: auto; white-space: nowrap; }
  .code { margin: 0; padding: 14px 16px; border-radius: 10px; background: var(--bg); border: 1px solid var(--line); font-family: var(--font-mono); font-size: 13px; line-height: 20px; overflow-x: auto; }
  .code.list { max-height: 240px; overflow-y: auto; }
  code { font-family: var(--font-mono); font-size: 12px; }
  .notes { display: flex; flex-direction: column; gap: 4px; }
  .notes p { margin: 0; max-width: 820px; text-wrap: pretty; }
</style>
