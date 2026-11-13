<script lang="ts">
  // Findings: what exactly was flagged, and why? The list grouped into incidents on the left, the picked finding on the
  // right, or the detection rules at #/findings/rules. Pins, dismissals and notes are kept in case.json.
  import { DEFAULT_RULES, type Candle, type Finding, type FindingsResult, type IncidentsResult, type ItemRow, type Level, type LedgerRow, type Mark, type OrderRow, type RuleId, type RuleSettings } from '../../shared/api.ts';
  import { about, alertRule, basis, describe, flagRule, ruleText, RULE_NAME, SOURCE, span, times } from '../../shared/finding.ts';
  import { amount as fmtAmount, count, countShort, items as quantity, money, time } from '../../shared/fmt.ts';
  import { incidentSentence, incidentTitle } from '../../shared/incident.ts';
  import Icon from '../app/Icon.svelte';
  import { ICON } from '../app/nav.ts';
  import { app, engine, setMark, setRules } from '../app/state.svelte.ts';
  import { words } from '../app/words.ts';

  let { selected }: { selected: string | null } = $props();

  const FIRST = 5; // findings shown per group until "Show all" (DESIGN_SPEC rule 3)
  const ROWS = 10;
  const ALL = { from: null, to: null, server: null };
  let result = $state<FindingsResult | null>(null);
  let grouped = $state<IncidentsResult | null>(null);
  let itemRows = $state(new Map<number, ItemRow>());
  let filter = $state<'all' | 'critical' | 'high' | 'lower'>('all');
  let showDismissed = $state(false);
  let opened = $state(new Set<string>()); // groups showing all their findings

  const main = $derived(app.saves.find((s) => s.sources.some((x) => (x.id === 'bank' || x.id === 'market') && x.status !== 'none' && x.status !== 'missing')));
  const w = $derived(words(itemRows));

  $effect(() => {
    const scope = $state.snapshot(app.scope), rules = $state.snapshot(app.rules);
    void app.saves.length;
    void app.marks; // orphans change with the marks
    let stale = false;
    void Promise.all([engine.findings(scope, rules), engine.incidents(scope, rules), engine.items()]).then(([f, g, i]) => {
      if (stale) return;
      [result, grouped, itemRows] = [f, g, new Map(i.map((x) => [x.id, x]))];
    });
    return () => (stale = true);
  });

  // ---- The list ----
  const LEVEL: Record<Level, { word: string; color: string }> = {
    critical: { word: 'Critical', color: 'var(--crit)' }, high: { word: 'High', color: 'var(--high)' },
    medium: { word: 'Medium', color: 'var(--med)' }, low: { word: 'Low', color: 'var(--low)' },
  };
  const RANK: Record<Level, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const byId = $derived(new Map((result?.findings ?? []).map((f) => [f.id, f])));
  const dismissed = (id: string) => app.marks[id]?.dismissed === true;
  const hidden = $derived((result?.findings ?? []).filter((f) => dismissed(f.id)).length);
  const visible = $derived((result?.findings ?? []).filter((f) => showDismissed || !dismissed(f.id)));
  const keep = (f: Finding) => filter === 'all' || (filter === 'lower' ? RANK[f.level] >= 2 : f.level === filter);
  const CHIPS = [['all', 'All'], ['critical', 'Critical'], ['high', 'High'], ['lower', 'Medium and low']] as const;
  const chipCount = (c: (typeof CHIPS)[number][0]) => visible.filter((f) => c === 'all' || (c === 'lower' ? RANK[f.level] >= 2 : f.level === c)).length;

  const groups = $derived.by(() => {
    if (!grouped) return [];
    const sorted = (ids: string[]) => ids.flatMap((id) => byId.get(id) ?? []).filter((f) => (showDismissed || !dismissed(f.id)) && keep(f))
      .sort((a, b) => RANK[a.level] - RANK[b.level] || a.start - b.start);
    const out = grouped.incidents.map((i) => ({ key: i.id, title: 'Incident: ' + incidentTitle(i, w.itemName), sentence: incidentSentence(i, w.itemName), list: sorted(i.findings) }));
    out.push({ key: 'others', title: 'Not part of an incident', sentence: '', list: sorted(grouped.others.map((f) => f.id)) });
    return out.filter((g) => g.list.length);
  });
  const inIncidents = $derived(grouped ? grouped.incidents.reduce((n, i) => n + i.findings.filter((id) => byId.has(id) && !dismissed(id)).length, 0) : 0);
  const orphans = $derived((grouped?.orphans ?? []).flatMap((id) => (app.marks[id] ? [{ id, mark: app.marks[id]! }] : [])));

  const answer = $derived.by(() => {
    if (!result) return '';
    const open = result.findings.length - hidden;
    if (open === 0) return result.findings.length ? `Every finding in this time range is marked as not a problem.` : 'Nothing unusual was found in this time range.';
    const n = grouped?.incidents.filter((i) => i.findings.some((id) => byId.has(id) && !dismissed(id))).length ?? 0;
    return `${count(open)} ${open === 1 ? 'finding' : 'findings'} in this time range.` + (n ? ` ${count(inIncidents)} of them belong to ${n === 1 ? 'one incident' : `${count(n)} incidents`}.` : ' None of them belong together.');
  });

  // ---- The picked finding ----
  const rulesOpen = $derived(selected === 'rules');
  const firstId = $derived(groups[0]?.list[0]?.id ?? orphans[0]?.id ?? null);
  const pickedId = $derived(rulesOpen ? null : (selected ?? firstId));
  const picked = $derived(pickedId === null ? null : (byId.get(pickedId) ?? null));
  const text = $derived(picked ? describe(picked, w) : null);
  const markOf = (id: string) => app.marks[id];

  let records = $state<{ for: string; orders: OrderRow[]; ledger: LedgerRow[]; candles: Candle[] } | null>(null);
  let allRows = $state(false);
  $effect(() => {
    const f = picked;
    if (!f) return;
    let stale = false;
    const r = $state.snapshot(f.records), market = f.markets[0];
    const minutes = new Set(r.candles.map((c) => c.time));
    void Promise.all([
      r.orders.length ? engine.orders({ ids: r.orders }, ALL) : [],
      r.ledger.length ? engine.ledger({ ids: r.ledger }, ALL) : [],
      r.candles.length && market !== undefined ? engine.candles(market, 1, { from: f.start, to: f.end, server: null }).then((c) => c.candles.filter((x) => minutes.has(x.time))) : [],
    ]).then(([o, l, c]) => {
      if (!stale) [records, allRows] = [{ for: f.id, orders: o.reverse(), ledger: l.reverse(), candles: c }, false];
    });
    return () => (stale = true);
  });
  const rec = $derived(records && picked && records.for === picked.id ? records : null);
  const nameOf = $derived(new Map((picked?.players ?? []).map((p) => [p.uuid, p.name])));
  const rows = <T,>(list: T[]) => (allRows ? list : list.slice(0, ROWS));
  const day = (ms: number) => time(ms).split(', ')[0];
  /** The clock only, when the finding lies within one day: the date is in its heading. */
  const clock = (ms: number, millis = false) => (picked && day(picked.start) === day(picked.end) && day(ms) === day(picked.start) ? time(ms, false, millis).split(', ')[1]! : time(ms, false, millis));
  const recordCount =$derived(rec ? rec.orders.length + rec.ledger.length + rec.candles.length : 0);

  // ---- Actions ----
  let form = $state<'dismiss' | 'note' | null>(null);
  let draft = $state('');
  $effect(() => {
    void pickedId;
    form = null;
  });
  function base(id: string): Mark {
    const m = markOf(id) ?? { title: '', start: 0, pinned: false, dismissed: false, reason: '', note: '' };
    return picked && text && picked.id === id ? { ...m, title: text.title, start: picked.start } : { ...m };
  }
  const change = (id: string, part: Partial<Mark>) => setMark(id, { ...base(id), ...part });
  function open(kind: 'dismiss' | 'note', id: string) {
    form = kind;
    draft = kind === 'note' ? (markOf(id)?.note ?? '') : '';
  }
  async function save(e: SubmitEvent, id: string) {
    e.preventDefault();
    await change(id, form === 'dismiss' ? { dismissed: true, reason: draft.trim() } : { note: draft.trim() });
    form = null;
  }

  // ---- Detection rules ----
  type Field = [key: string, label: string, kind: 'number' | 'money' | 'items'];
  const FIELDS: Partial<Record<RuleId, Field[]>> = {
    'round-trip': [['times', 'Price factor, more than', 'number'], ['seconds', 'Within seconds', 'number']],
    'order-rate': [['orders', 'Orders in one second, more than', 'number']],
    'hour-profit': [['money', 'Profit in one hour, above $', 'money']],
    'far-price': [['times', 'Times from the usual price, more than', 'number']],
    'price-spike': [['times', 'High to low within a minute, more than', 'number']],
    'balance': [['money', 'Money, above $', 'money'], ['items', 'Other items, above', 'items']],
    'banknotes': [['money', 'Off by more than $', 'money']],
  };
  let problems = $state<Record<string, string>>({});
  const shownValue = (v: unknown, kind: Field[2]) => (kind === 'number' ? times(v as number) : kind === 'money' ? fmtAmount(v as bigint) : quantity(v as bigint));
  /** "1'000'000.50" -> 100000050n for money and items, 2.5 for a number; null when it is not a positive number. */
  function parse(input: string, kind: Field[2]): number | bigint | null {
    const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(input.replace(/['\s]/g, ''));
    if (!m) return null;
    if (kind === 'number') return Number(m[0]) > 0 ? Number(m[0]) : null;
    const raw = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
    return raw > 0n ? raw : null;
  }
  function setField(rule: keyof RuleSettings, [key, , kind]: Field, input: HTMLInputElement) {
    const v = parse(input.value, kind);
    if (v === null) return void (problems = { ...problems, [rule + key]: 'Enter a number above 0, with at most two decimals.' });
    problems = { ...problems, [rule + key]: '' };
    void setRules({ ...$state.snapshot(app.rules), [rule]: { ...app.rules[rule], [key]: v } } as RuleSettings);
  }
  const toggle = (rule: keyof RuleSettings) => setRules({ ...$state.snapshot(app.rules), [rule]: { ...app.rules[rule], on: !app.rules[rule].on } } as RuleSettings);
  const status = (rule: RuleId) => result?.rules.find((r) => r.rule === rule);
  const bankValue = (key: string, v: number | boolean) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : /AMOUNT/.test(key) ? money(BigInt(Math.round(v * 100))) : times(v));
</script>

<div class="top">
  <div style="flex: 1 1 320px; min-width: 0">
    <h1 class="h1">Findings</h1>
    <p class="sub">{main ? answer || 'Running the rules…' : 'What exactly was flagged, and why?'}</p>
  </div>
  {#if main && result}
    <div role="group" aria-label="Filter by severity" class="sev">
      {#each CHIPS as [id, label] (id)}
        <button type="button" aria-pressed={filter === id} onclick={() => (filter = id)}>{label} {count(chipCount(id))}</button>
      {/each}
    </div>
  {/if}
  <a class="btn" href={rulesOpen ? '#/findings' : '#/findings/rules'} aria-current={rulesOpen ? 'page' : undefined} style="font-weight: 500">Detection rules</a>
</div>

{#if !main}
  <p class="empty">Findings come from the master's save. Open it on the <a href="#/saves" style="color: var(--accent)">Saves and servers</a> screen.</p>
{:else if !result || !grouped}
  <p class="small" aria-busy="true">Running the rules over all loaded data…</p>
{:else}
  <div class="cols">
    <section aria-label="List of findings" class="card list">
      {#if hidden}
        <label class="switch small"><input type="checkbox" bind:checked={showDismissed} /> Show the {count(hidden)} marked as not a problem</label>
      {/if}
      {#if groups.length === 0 && orphans.length === 0}
        <p class="small" style="margin: 12px">{result.findings.length ? 'No finding of this severity in this time range.' : 'No finding in this time range.'}</p>
      {/if}
      {#each groups as g (g.key)}
        <div class="group">
          <h2>{g.title}</h2>
          <span class="small">{count(g.list.length)}</span>
        </div>
        {#if g.sentence}<p class="small sentence">{g.sentence}</p>{/if}
        {#each opened.has(g.key) ? g.list : g.list.slice(0, FIRST) as f (f.id)}
          <a class="row item" href={'#/findings/' + encodeURIComponent(f.id)} aria-current={f.id === pickedId ? 'true' : undefined} class:faded={dismissed(f.id)}>
            <span class="dot" style="background: {LEVEL[f.level].color}" aria-hidden="true"></span>
            <span class="what">
              <span style="font-weight: 500">{describe(f, w).title}</span>
              <span class="small">{about(f, w)} · {span(f.start, f.end)}</span>
            </span>
            {#if markOf(f.id)?.pinned}<span style="color: var(--accent); display: flex"><Icon d={ICON.pin} label="Pinned to the case" size={16} /></span>{/if}
          </a>
        {/each}
        {#if g.list.length > FIRST}
          <button type="button" class="link more" onclick={() => (opened = new Set(opened.has(g.key) ? [...opened].filter((k) => k !== g.key) : [...opened, g.key]))}>
            {opened.has(g.key) ? 'Show fewer' : `Show all ${count(g.list.length)}`}</button>
        {/if}
      {/each}
      {#if orphans.length}
        <div class="group"><h2>Not raised with the current settings</h2><span class="small">{count(orphans.length)}</span></div>
        <p class="small sentence">You marked these, and the rules no longer raise them, for example after a threshold changed. What you stored stays here.</p>
        {#each orphans as o (o.id)}
          <a class="row item" href={'#/findings/' + encodeURIComponent(o.id)} aria-current={o.id === pickedId ? 'true' : undefined}>
            <span class="dot" style="background: var(--line2)" aria-hidden="true"></span>
            <span class="what">
              <span style="font-weight: 500">{o.mark.title || o.id}</span>
              <span class="small">{o.mark.start ? time(o.mark.start) : 'time unknown'} · {[o.mark.pinned && 'pinned', o.mark.dismissed && 'not a problem', o.mark.note && 'note'].filter(Boolean).join(', ')}</span>
            </span>
          </a>
        {/each}
      {/if}
    </section>

    <section aria-label={rulesOpen ? 'Detection rules' : 'Selected finding'} class="card detail">
      {#if rulesOpen}
        <div>
          <h2 class="title">Detection rules</h2>
          <p class="sub">Changing a rule runs it again over all loaded data. The settings are kept with the case.</p>
        </div>
        {#each Object.keys(DEFAULT_RULES) as id (id)}
          {@const rule = id as keyof RuleSettings}
          {@const st = status(rule)}
          <div class="rule" id="rule-{rule}">
            <div class="rulehead">
              <span style="flex: 1 1 auto; font-weight: 600">{RULE_NAME[rule]}</span>
              <span class="small">{st?.notApplicable ? 'does not apply' : st?.found === null || st?.found === undefined ? 'off' : `${count(st.found)} ${st.found === 1 ? 'finding' : 'findings'} in all data`}</span>
              <label class="toggle"><input type="checkbox" role="switch" checked={app.rules[rule].on} onchange={() => toggle(rule)} aria-label="{RULE_NAME[rule]} on" /></label>
            </div>
            <p class="small" style="margin: 0; color: var(--text2)">{ruleText(rule, app.rules)}</p>
            {#if st?.notApplicable}<p class="small" style="margin: 0">{st.notApplicable}</p>{/if}
            {#if FIELDS[rule]}
              <div class="fields">
                {#each FIELDS[rule]! as field (field[0])}
                  <label>{field[1]}
                    <input type="text" inputmode="decimal" value={shownValue((app.rules[rule] as Record<string, unknown>)[field[0]], field[2])} disabled={!app.rules[rule].on}
                      onchange={(e) => setField(rule, field, e.currentTarget)} />
                  </label>
                  {#if problems[rule + field[0]]}<p class="small" style="margin: 0; color: var(--down)">{problems[rule + field[0]]}</p>{/if}
                {/each}
              </div>
            {/if}
            {#if rule === 'bank-flag' && Object.keys(result.bankSettings).length}
              <p class="small" style="margin: 0">The server's own settings, read from its settings.json. They can only be changed on the server.</p>
              <dl class="bank">
                {#each Object.entries(result.bankSettings) as [k, v] (k)}<dt>{k}</dt><dd>{bankValue(k, v)}</dd>{/each}
              </dl>
            {/if}
          </div>
        {/each}
        {#each result.rules.filter((r) => !(r.rule in DEFAULT_RULES)) as r (r.rule)}
          <div class="rule">
            <div class="rulehead"><span style="flex: 1 1 auto; font-weight: 600">{RULE_NAME[r.rule]}</span><span class="small">not available</span></div>
            <p class="small" style="margin: 0; color: var(--text2)">{r.notApplicable}</p>
          </div>
        {/each}
      {:else if picked && text}
        {@const m = markOf(picked.id)}
        <div class="tags">
          <span class="tag" style="color: {LEVEL[picked.level].color}; background: color-mix(in srgb, {LEVEL[picked.level].color} 16%, transparent)">{LEVEL[picked.level].word}</span>
          <span class="tag">{SOURCE[picked.source]}</span>
          <span class="tag">{basis(picked)}</span>
        </div>
        <div>
          <h2 class="title">{text.title}</h2>
          <p class="small" style="margin: 4px 0 0">{about(picked, w)} · {span(picked.start, picked.end)}</p>
        </div>
        <p class="summary">{text.summary}</p>
        <div class="facts">
          {#each text.facts as [label, value] (label)}
            <div class="fact"><span class="small">{label}</span><span class="fv">{value}</span></div>
          {/each}
        </div>
        <div class="rulebox">
          <div class="rulehead">
            <span style="flex: 1 1 auto; font-weight: 600">Rule: {text.rule}</span>
            {#if picked.source === 'tool'}<a href="#/findings/rules" class="ref small" style="font-weight: 500">Change this rule</a>{/if}
          </div>
          <p class="small" style="margin: 0; color: var(--text2)">{picked.rule === 'bank-flag' ? flagRule(Number(picked.facts.flagType), result.bankSettings) : picked.rule === 'market-alert' ? alertRule(picked) : ruleText(picked.rule, app.rules)}</p>
          <p class="small" style="margin: 0">Measured here: <span style="font-weight: 500; color: var(--text)">{text.measured}</span></p>
        </div>

        <div>
          <h3 class="label">The records behind it</h3>
          {#if picked.records.flags.length}<p class="small" style="margin: 0 0 8px">Row {picked.records.flags.join(', ')} of the bank's flag table; its content is above.</p>{/if}
          {#if picked.facts.origin === 'audit log'}<p class="small" style="margin: 0 0 8px">An entry of the bank's audit log; the database lost its row.</p>{/if}
          {#if !rec}
            <p class="small" aria-busy="true" style="margin: 0">Loading the records…</p>
          {:else if recordCount === 0 && !picked.records.flags.length && picked.facts.origin !== 'audit log'}
            <p class="small" style="margin: 0">{picked.rule === 'hour-profit' || picked.rule === 'balance' ? 'This finding is worked out from the orders and balances of the time shown; open the player or the account for them.'
              : picked.rule === 'market-alert' ? "The market mod sums all of the player's orders in its time window and does not record which they were; open the player for them." : 'No single rows behind it.'}</p>
          {:else}
            <div class="scroll">
              {#if rec.orders.length}
                <table>
                  <thead><tr><th>Order</th><th>Time</th><th>Player</th>{#if picked.markets.length > 1}<th>Market</th>{/if}<th>Side</th><th class="r">Quantity</th><th class="r">Price</th></tr></thead>
                  <tbody>
                    {#each rows(rec.orders) as o (o.id)}
                      <tr><td>{o.orderId ?? o.id}</td><td class="mono">{clock(o.time, true)}</td><td>{nameOf.get(o.player) ?? o.player.slice(0, 8)}</td>{#if picked.markets.length > 1}<td>{w.itemName(o.item)}</td>{/if}
                        <td style="color: {o.amount > 0n ? 'var(--buy)' : 'var(--sell)'}">{o.amount > 0n ? 'Buy' : 'Sell'}</td><td class="r">{quantity(o.amount < 0n ? -o.amount : o.amount)}</td><td class="r">{money(o.price)}</td></tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
              {#if rec.ledger.length}
                <table>
                  <thead><tr><th>Time</th><th>Account</th><th>Entry</th><th class="r">Amount</th></tr></thead>
                  <tbody>
                    {#each rows(rec.ledger) as r (r.id)}
                      <tr><td class="mono">{clock(r.time)}</td><td><a class="ref" href="#/accounts/{r.account}">{r.account}</a></td><td>{w.what(r)}</td><td class="r">{w.amount(r)}</td></tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
              {#if rec.candles.length}
                <table>
                  <thead><tr><th>Minute</th><th class="r">Open</th><th class="r">High</th><th class="r">Low</th><th class="r">Volume</th></tr></thead>
                  <tbody>
                    {#each rows(rec.candles) as c (c.time)}
                      <tr><td class="mono">{clock(c.time)}</td><td class="r">{money(c.open)}</td><td class="r">{money(c.high)}</td><td class="r">{money(c.low)}</td><td class="r">{countShort(c.volume)}</td></tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
            </div>
            {#if Math.max(rec.orders.length, rec.ledger.length, rec.candles.length) > ROWS}
              <button type="button" class="link" onclick={() => (allRows = !allRows)}>{allRows ? 'Show fewer' : `Show all ${count(recordCount)}`}</button>
            {/if}
          {/if}
        </div>

        <div class="open">
          <span class="small">Open:</span>
          {#each picked.players as p (p.uuid)}<a class="pill" href="#/players/{encodeURIComponent(p.uuid)}">{p.name}</a>{/each}
          {#each picked.markets as id (id)}<a class="pill" href="#/markets/{id}">{w.itemName(id)} market</a>{/each}
          {#each picked.accounts as n (n)}<a class="pill" href="#/accounts/{n}">Account {n}</a>{/each}
        </div>

        {@render actions(picked.id, m)}
      {:else if pickedId && markOf(pickedId)}
        {@const m = markOf(pickedId)!}
        <div class="tags"><span class="tag">Not raised with the current settings</span></div>
        <div>
          <h2 class="title">{m.title || pickedId}</h2>
          <p class="small" style="margin: 4px 0 0">{m.start ? time(m.start) : 'time unknown'}</p>
        </div>
        <p class="summary">{grouped.orphans.includes(pickedId) ? 'The rules no longer raise this finding, for example because a threshold or a rule was changed since you marked it.' : 'This finding is not in the selected time range.'} What you stored is kept until you remove it.</p>
        {@render actions(pickedId, m, true)}
      {:else if pickedId && pickedId !== firstId}
        <p class="empty">This finding is not raised in the selected time range with the current settings.</p>
      {:else}
        <p class="small" style="margin: 0">Pick a finding on the left.</p>
      {/if}
    </section>
  </div>
{/if}

{#snippet actions(id: string, m: Mark | undefined, orphan = false)}
  {#if m?.dismissed}
    <p class="note"><strong>Marked as not a problem.</strong>{m.reason ? ` ${m.reason}` : ''}</p>
  {/if}
  {#if m?.note && form !== 'note'}
    <p class="note"><strong>Note:</strong> {m.note}</p>
  {/if}
  {#if form}
    <form class="form" onsubmit={(e) => save(e, id)}>
      <label>{form === 'dismiss' ? 'Why is it not a problem? (optional)' : 'Note'}
        <textarea bind:value={draft} rows="3" maxlength="10000"></textarea></label>
      <div class="buttons">
        <button type="submit" class="btn primary">{form === 'dismiss' ? 'Mark as not a problem' : 'Save the note'}</button>
        <button type="button" class="btn" onclick={() => (form = null)}>Cancel</button>
      </div>
    </form>
  {:else}
    <div class="buttons actions">
      <button type="button" class="btn primary" aria-pressed={m?.pinned === true} onclick={() => change(id, { pinned: !m?.pinned })}><Icon d={ICON.pin} />{m?.pinned ? 'Pinned to the case' : 'Pin to the case'}</button>
      {#if orphan}
        <button type="button" class="btn" onclick={() => change(id, { pinned: false, dismissed: false, reason: '', note: '' })}>Remove from the case</button>
      {:else if m?.dismissed}
        <button type="button" class="btn" onclick={() => change(id, { dismissed: false, reason: '' })}>It is a problem after all</button>
      {:else}
        <button type="button" class="btn" onclick={() => open('dismiss', id)}>Not a problem</button>
      {/if}
      <button type="button" class="btn" onclick={() => open('note', id)}>{m?.note ? 'Change the note' : 'Add a note'}</button>
    </div>
  {/if}
{/snippet}

<style>
  .top { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 16px; }
  .sev { display: flex; flex-wrap: wrap; gap: 8px; }
  .sev button { height: 36px; padding: 0 12px; border-radius: 18px; font-weight: 500; border: 1px solid var(--line); background: transparent; color: var(--text2); }
  .sev button[aria-pressed='true'] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--text); }
  .btn[aria-current] { border-color: var(--accent); }
  .empty { margin: 0; padding: 24px; border-radius: 14px; border: 1px dashed var(--line2); color: var(--text2); }
  .cols { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 24px; }
  .list { flex: 1 1 400px; min-width: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 2px; padding: 16px 12px; }
  .detail { flex: 1.4 1 480px; min-width: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 20px; padding: 28px;
    position: sticky; top: 24px; max-height: calc(100vh - 69px - 48px); overflow-y: auto; } /* 69px: the top bar */
  .switch { display: flex; align-items: center; gap: 8px; padding: 4px 12px 8px; }
  .group { display: flex; align-items: baseline; gap: 8px; padding: 12px 12px 4px; }
  .group h2 { flex: 1 1 auto; margin: 0; font-size: 12px; line-height: 16px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text3); }
  .sentence { margin: 0 12px 6px; text-wrap: pretty; }
  .item { display: flex; align-items: flex-start; gap: 12px; padding: 12px; border-radius: 10px; }
  .item[aria-current] { background: var(--raised); }
  .item.faded { opacity: 0.45; }
  .dot { flex: none; width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; }
  .what { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 2px; text-wrap: pretty; }
  .link { padding: 0; border: 0; background: none; font-size: 13px; font-weight: 500; color: var(--accent); align-self: flex-start; }
  .more { margin: 4px 12px 8px; }
  .tags { display: flex; flex-wrap: wrap; gap: 8px; }
  .tag { height: 24px; padding: 0 8px; border-radius: 6px; font-size: 12px; line-height: 24px; font-weight: 600; color: var(--text2); background: var(--raised); }
  .title { margin: 0; font-family: var(--font-head); font-size: 22px; line-height: 30px; font-weight: 600; text-wrap: balance; }
  .summary { margin: 0; max-width: 680px; font-size: 15px; line-height: 24px; color: var(--text2); text-wrap: pretty; }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 12px; }
  .fact { display: flex; flex-direction: column; gap: 2px; padding: 12px 14px; border-radius: 10px; background: var(--raised); }
  .fv { font-weight: 600; font-variant-numeric: tabular-nums; white-space: pre-line; overflow-wrap: anywhere; }
  .rulebox, .rule { display: flex; flex-direction: column; gap: 6px; padding: 16px; border-radius: 10px; border: 1px solid var(--line); }
  .rulehead { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .ref { color: var(--accent); }
  .label { margin: 0 0 8px; font-size: 12px; line-height: 16px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text3); }
  .scroll { overflow-x: auto; display: flex; flex-direction: column; gap: 16px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th { padding: 0 16px 8px 0; font-size: 12px; font-weight: 600; color: var(--text3); text-align: left; }
  td { padding: 10px 16px 10px 0; border-top: 1px solid var(--line); white-space: nowrap; }
  .r { text-align: right; }
  .mono { font-family: var(--font-mono); font-size: 13px; }
  .open { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .pill { display: inline-flex; align-items: center; height: 36px; padding: 0 12px; box-sizing: border-box; border-radius: 18px; border: 1px solid var(--line2); font-weight: 500; }
  .pill:hover { background: var(--raised); }
  .buttons { display: flex; flex-wrap: wrap; gap: 12px; }
  .actions { padding-top: 20px; border-top: 1px solid var(--line); }
  .btn.primary { border: 0; font-weight: 600; background: var(--accent); color: var(--onaccent); padding: 0 16px; }
  .btn.primary:hover { background: var(--accent); filter: brightness(1.08); }
  .btn { font-weight: 500; }
  .note { margin: 0; padding: 12px 14px; border-radius: 10px; background: var(--raised); color: var(--text2); white-space: pre-line; }
  .form { display: flex; flex-direction: column; gap: 12px; padding-top: 20px; border-top: 1px solid var(--line); }
  .form label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--text2); }
  textarea { font: inherit; color: var(--text); padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line2); background: var(--bg); resize: vertical; }
  .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 8px 16px; margin-top: 4px; }
  .fields label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text2); }
  .fields input { height: 36px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--line2); background: var(--bg); font-variant-numeric: tabular-nums; }
  .fields input:disabled { opacity: 0.55; }
  .toggle { display: flex; }
  .toggle input { appearance: none; width: 36px; height: 20px; margin: 0; border-radius: 10px; cursor: pointer; transition: background 0.15s;
    background: radial-gradient(circle at 10px 50%, #fff 7px, transparent 7.5px), var(--line2); }
  .toggle input:checked { background: radial-gradient(circle at 26px 50%, #fff 7px, transparent 7.5px), var(--accent); }
  .toggle input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .bank { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 0; font-size: 13px; }
  .bank dt { color: var(--text3); font-family: var(--font-mono); font-size: 12px; }
  .bank dd { margin: 0; font-variant-numeric: tabular-nums; }
</style>
