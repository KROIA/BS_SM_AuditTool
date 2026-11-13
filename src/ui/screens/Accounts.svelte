<script lang="ts">
  // Bank accounts: does the bank's log explain the balance? A list on the left, largest gap first; the picked account on the
  // right with the check per account (DESIGN_SPEC 8.4), its chart and its history.
  import type { AccountDetail, AccountListRow, AccountRow, Gap, ItemCheck, ItemRow, LedgerRow, Point, Rating } from '../../shared/api.ts';
  import { GAP_SAYS, span } from '../../shared/finding.ts';
  import { count, items as quantity, money, moneyShort, time } from '../../shared/fmt.ts';
  import StepChart from '../app/StepChart.svelte';
  import { app, engine } from '../app/state.svelte.ts';
  import { entries, gapRows, LEVEL_COLOR, words, type Entry } from '../app/words.ts';

  let { selected }: { selected: number | null } = $props();

  const ROWS = 10; // tables show this many rows until "Show all" (DESIGN_SPEC rule 3)
  let list = $state<AccountListRow[] | null>(null);
  let itemRows = $state(new Map<number, ItemRow>());
  let detail = $state<AccountDetail | null>(null);
  let history = $state<LedgerRow[]>([]);
  let checks = $state<ItemCheck[]>([]);
  let loadedFor = $state<number | null>(null); // the account the detail above was asked for; detail is null when it is unknown
  let picked = $state<number | null>(null); // the item chip the user picked
  let points = $state<Point[] | null>(null);
  let filter = $state<keyof typeof FILTERS>('all');
  let showAll = $state(false);
  let historyCard = $state<HTMLElement | null>(null);

  const main = $derived(app.saves.find((s) => s.sources.some((x) => x.id === 'bank' && x.status !== 'none' && x.status !== 'missing')));
  const number = $derived(selected ?? list?.[0]?.number ?? null);
  const ready = $derived(loadedFor !== null && loadedFor === number);
  const shown = $derived(ready ? detail : null);
  const { itemName, isMoney, value, change, what, amount, amountTone, gapWhat, gapSub, gapWhen } = $derived(words(itemRows));

  $effect(() => {
    const scope = $state.snapshot(app.scope), rules = $state.snapshot(app.rules);
    void app.saves.length; // ask again when saves come or go
    let stale = false;
    void Promise.all([engine.accounts(scope, rules), engine.items()]).then(([a, i]) => {
      if (stale) return;
      list = a;
      itemRows = new Map(i.map((x) => [x.id, x]));
    });
    return () => (stale = true);
  });

  $effect(() => {
    const scope = $state.snapshot(app.scope), rules = $state.snapshot(app.rules), n = number;
    void app.saves.length;
    if (n === null) return;
    let stale = false;
    void Promise.all([engine.account(n, scope), engine.ledger({ accounts: [n] }, scope), engine.check(n, scope, rules)]).then(([d, h, c]) => {
      if (stale) return;
      if (loadedFor !== n) [picked, filter] = [null, 'all'];
      [detail, history, checks, showAll, loadedFor] = [d, h, c, false, n];
    });
    return () => (stale = true);
  });

  // The chart and the check show the picked item, else the account's money, else its first item. A deleted account has no
  // slots left, its items come from the check.
  const itemIds = $derived([...new Set([...(shown?.items ?? []).map((s) => s.item), ...checks.map((c) => c.item)])]);
  const item = $derived(itemIds.find((i) => i === picked) ?? itemIds.find((i) => isMoney(i)) ?? itemIds[0] ?? null);
  const current = $derived(checks.find((c) => c.item === item) ?? null);
  $effect(() => {
    const scope = $state.snapshot(app.scope), n = number, i = item;
    if (n === null || i === null) return;
    let stale = false;
    void engine.balances(n, i, scope).then((p) => !stale && (points = p));
    return () => ((stale = true), (points = null));
  });

  // ---- The check ----
  const RANK: Record<Rating, number> = { low: 0, medium: 1, high: 2 };
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const short = (i: number, raw: bigint) => (isMoney(i) ? moneyShort(raw) : quantity(raw));
  const signedShort = (i: number, raw: bigint) => (raw > 0n ? '+' : '') + short(i, raw);
  const label = (i: number) => (isMoney(i) ? 'money' : itemName(i));
  const strongest = (gaps: Gap[]) => gaps.reduce<Rating>((r, g) => (RANK[g.rating] > RANK[r] ? g.rating : r), 'low');

  const tiles = $derived.by(() => {
    const c = current;
    if (!c || c.verdict === 'unchecked' || item === null) return [];
    const i = item;
    return [
      { label: 'Balance at the start', raw: c.start!, signed: false },
      { label: 'Trades, net', raw: c.trades, signed: true },
      { label: 'Paid in', raw: c.paidIn, signed: true },
      { label: 'Paid out', raw: -c.paidOut, signed: true },
      { label: 'The log adds up to', raw: c.shouldBe!, signed: false },
      { label: 'The balance is', raw: c.is!, signed: false },
    ].map((t, k) => ({ ...t, value: t.signed ? signedShort(i, t.raw) : short(i, t.raw), full: t.signed ? change(i, t.raw) : value(i, t.raw), op: k === 4 ? '=' : '', end: k >= 4 }));
  });

  const verdict = $derived.by(() => {
    const c = current;
    if (!c || item === null) return null;
    const i = item, gaps = c.gaps;
    if (c.verdict === 'unchecked') {
      return { figure: null, full: '', color: 'var(--line2)', open: false, says: '',
        text: c.start === null ? `No balance snapshot of ${label(i)} on this account in this time range, so there is nothing to check.`
          : `Only one balance snapshot of ${label(i)} in this time range: there is nothing to compare it with.` };
    }
    if (gaps.length === 0) {
      const rest = c.unexplained === 0n ? '' : ` A rest of ${change(i, c.unexplained)} stays below the threshold of the rule "Balance not explained": order money is cut off per fill.`;
      return { figure: short(i, 0n), full: '', color: 'var(--up)', open: false, says: '', text: `The log explains every change of ${label(i)} on this account in this time range.${rest}` };
    }
    const net = gaps.reduce((t, g) => t + g.difference, 0n), gross = gaps.reduce((t, g) => t + abs(g.difference), 0n);
    const big = gaps.reduce((a, g) => (abs(g.difference) > abs(a.difference) ? g : a));
    let text = gaps.length === 1
      ? `The log does not explain ${value(i, abs(net))}. It ${net > 0n ? 'came into' : 'left'} this account between two snapshots, ${span(big.from, big.to)}, and no entry was written.`
      : `The log does not explain ${count(gaps.length)} changes, ${value(i, gross)} in all. The largest, ${change(i, big.difference)}, came between two snapshots, ${span(big.from, big.to)}.`
        + (net === 0n ? ' They cancel out: at the end the balance is what the log explains.' : ` Together they come to ${change(i, net)}.`);
    const labels = [...new Set(gaps.flatMap((g) => g.labels))];
    if (labels.length) text += ` ${gaps.length === 1 ? 'In that time' : c.verdict === 'unknown-rows' ? 'In each of them' : 'In some of them'} the log has entries without a direction, which may explain ${gaps.length === 1 ? 'it' : 'them'}.`;
    const r = strongest(gaps);
    return { figure: gaps.length === 1 ? signedShort(i, net) : short(i, gross), full: gaps.length === 1 ? change(i, net) : value(i, gross), color: LEVEL_COLOR[r], open: true, text,
      says: `How much this says: ${GAP_SAYS[r].short.split(':')[0]!.toLowerCase()}.` + (r === 'low' ? '' : ` ${GAP_SAYS[r].why}`) }; // low: the sub line says why
  });
  const others = $derived(checks.filter((c) => c.item !== item && c.gaps.length));
  const bands = $derived((current?.gaps ?? []).map((g): [number, number] => [g.from, g.to]));

  function showGaps() {
    [filter, showAll] = ['gap', false];
    historyCard?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- History ----
  const TRADES = new Set(['TRADE_BUY', 'TRADE_SELL', 'SHARE_TRADE']);
  const isAdmin = (r: LedgerRow) => r.kind.startsWith('ADMIN') || r.sourceKind === 'ADMIN';
  const FILTERS = {
    all: { label: 'Everything', keep: (_e: Entry) => true },
    paid: { label: 'Paid in and out', keep: (e: Entry) => !!e.row && !TRADES.has(e.row.kind) && !isAdmin(e.row) },
    trades: { label: 'Trades', keep: (e: Entry) => !!e.row && TRADES.has(e.row.kind) },
    admin: { label: 'Admin actions', keep: (e: Entry) => !!e.row && isAdmin(e.row) },
    gap: { label: 'No log entry', keep: (e: Entry) => !!e.gap },
  };
  const everything = $derived(number === null ? [] : entries(history, gapRows(number, checks)));
  const rows = $derived(everything.filter(FILTERS[filter].keep));
  const hasTrades = $derived(rows.some((e) => e.row?.kind === 'TRADE_BUY' || e.row?.kind === 'TRADE_SELL'));

  /** The rest of the row's sub line, after the other account (a link). */
  function sub(r: LedgerRow): string {
    const parts: string[] = [];
    if (r.kind === 'ADMIN_SET' && r.change !== null && r.balanceAfter !== null) parts.push(`from ${value(r.item, r.balanceAfter - r.change)} to ${value(r.item, r.balanceAfter)}`);
    else if (r.note) parts.push(r.note);
    if (r.change === null) parts.push('the log does not say in which direction');
    return parts.join(' · ');
  }
  function by(r: LedgerRow): string {
    const who = r.actorName ?? 'not recorded';
    if (r.sourceKind === 'STOCKMARKET') return `StockMarket, for ${who}`;
    if (r.sourceKind === 'ADMIN') return `${who}, as admin`;
    if (r.sourceKind === 'SYSTEM') return `The bank, for ${who}`;
    return who;
  }

  // ---- Header ----
  /** Permission bits DEPOSIT=1 WITHDRAW=2 MANAGE=4 in words. */
  function rights(bits: number): string {
    if ((bits & 7) === 7) return 'every right';
    const list = [bits & 1 && 'deposit', bits & 2 && 'withdraw', bits & 4 && 'manage'].filter(Boolean);
    return list.length ? list.join(', ') : 'no rights';
  }
  const kind = (a: AccountRow) => (a.deleted ? 'Deleted account' : a.company ? 'Company account' : a.owner ? 'Personal account' : 'Shared account');
  const figures = $derived.by(() => {
    if (!shown) return [];
    const s = shown, other = s.items.filter((i) => !isMoney(i.item) && i.balance + i.locked !== 0n).length;
    return [
      { label: 'Money on the account', value: moneyShort(s.money), full: money(s.money), note: s.deleted ? "gone from the bank's files" : 'at the time of the copy' },
      { label: 'Log entries', value: count(s.rows), full: '', note: 'in this time range' },
      { label: 'Item slots', value: count(s.items.length), full: '', note: other ? `${count(other)} holding items other than money` : s.items.length ? 'nothing held but money' : 'none in the bank files' },
    ];
  });
  /** The list's sub line: what the log does not explain, else the money. */
  const listSub = (a: AccountListRow) =>
    (a.unexplained ? `${moneyShort(a.unexplained)} not explained` : a.gaps ? `${count(a.gaps)} ${a.gaps === 1 ? 'gap' : 'gaps'} in items` : moneyShort(a.money))
    + (a.company ? ' · company' : '') + (a.frozen ? ' · frozen' : '');
</script>

<div class="split">
  <aside aria-label="Account list">
    <div class="listhead">
      <h2>Accounts</h2>
      <span class="small">largest gap first</span>
    </div>
    {#if !main}
      <p class="small pad">No save with bank data is loaded.</p>
    {:else if list && list.length === 0}
      <p class="small pad">This save lists no bank accounts.</p>
    {:else if list}
      <div class="roster">
        {#each list as a (a.number)}
          <a class="row pick" href="#/accounts/{a.number}" aria-current={a.number === number ? 'true' : undefined}>
            <span class="badge" aria-hidden="true">{a.number}</span>
            <span class="who">
              <span class="ellipsis" style="font-weight: 500">{a.deleted ? 'Deleted account' : a.name}</span>
              <span class="small">{listSub(a)}</span>
            </span>
            {#if a.rating}<span class="dot" style="background: {LEVEL_COLOR[a.rating]}" title="How much the gaps say: {GAP_SAYS[a.rating].short}"></span>{/if}
          </a>
        {/each}
      </div>
    {/if}
  </aside>

  <div class="detail">
    {#if !main}
      <div>
        <h1 class="h1">Bank accounts</h1>
        <p class="sub">Does the bank's log explain the balance?</p>
      </div>
      <p class="empty">Bank accounts come from the master's save. Open it on the <a href="#/saves" style="color: var(--accent)">Saves and servers</a> screen.</p>
    {:else if number === null}
      <h1 class="h1">Bank accounts</h1>
      {#if list}<p class="empty">This save lists no bank accounts.</p>{/if}
    {:else if !ready}
      <p class="small" aria-busy="true">Loading the account…</p>
    {:else if !shown}
      <h1 class="h1">Bank accounts</h1>
      <p class="empty">Account {number} is not in the loaded saves.</p>
    {:else}
      <div class="head">
        <div style="flex: 1 1 320px; min-width: 0">
          <h1 class="h1">Account {shown.number} · {shown.deleted ? 'deleted' : shown.name}</h1>
          <div class="facts">
            <span>{kind(shown)}</span>
            {#if shown.deleted}<span>Gone from the bank's files; its balance snapshots and log entries are still in the save</span>{/if}
            {#if shown.company}<span>Company: {shown.company}</span>{/if}
            {#if shown.owner}<span>Owner: {shown.ownerName}</span>{/if}
            {#each shown.users.filter((u) => u.uuid !== shown.owner) as u (u.uuid)}
              <span>User: <a href="#/players/{encodeURIComponent(u.uuid)}">{u.name}</a>, {rights(u.permissions)}</span>
            {/each}
            {#if shown.createdMs}<span>Opened {time(shown.createdMs)}</span>{/if}
            {#if !shown.deleted}<span>{shown.frozen ? 'Frozen' : 'Not frozen'}</span>{/if}
          </div>
        </div>
        {#if shown.owner}<a class="btn" href="#/players/{encodeURIComponent(shown.owner)}" style="font-weight: 500">Open the owner</a>{/if}
      </div>

      <section aria-label="Key figures" class="figures">
        {#each figures as k (k.label)}
          <div class="figure">
            <div class="flabel">{k.label}</div>
            <div class="fvalue" title={k.full || undefined}>{k.value}</div>
            <div class="small">{k.note}</div>
          </div>
        {/each}
      </section>

      {#if item !== null && current && verdict}
        <section class="card" aria-label="Does the log explain the balance?">
          <h2 class="h2 h3">Does the log explain the balance?</h2>
          <p class="small" style="margin: 2px 0 0">
            {isMoney(item) ? 'Money' : itemName(item)}{current.from !== null && current.to !== null && current.to > current.from ? `, ${span(current.from, current.to)}` : ''}.
            The log is every entry the bank wrote. The balance comes from the bank's own snapshots.
            {#if main.generation === 'legacy'}BankSystem 2.1.2 wrote this save. It did not log trades or admin actions: orders stand in for trades, and gaps are expected and rated low.{/if}
          </p>
          {#if tiles.length}
            <div class="tiles">
              {#each tiles as t (t.label)}
                <div class="tile">
                  {#if t.op}<span class="op" aria-hidden="true">{t.op}</span>{/if}
                  <div class="tbox" class:end={t.end}>
                    <span class="flabel">{t.label}</span>
                    <span class="tvalue" title={t.full}>{t.value}</span>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
          <div class="verdict" class:open={verdict.open} style="--c: {verdict.color}">
            {#if verdict.figure !== null}
              <div class="vfig">
                <span class="flabel">Not explained</span>
                <span class="vvalue" title={verdict.full || undefined}>{verdict.figure}</span>
              </div>
            {/if}
            <div style="flex: 1 1 320px; min-width: 0">
              <p style="margin: 0; text-wrap: pretty">{verdict.text}</p>
              {#if verdict.says}<p class="small" style="margin: 6px 0 0; text-wrap: pretty">{verdict.says}</p>{/if}
            </div>
            {#if verdict.open}<button type="button" class="btn" onclick={showGaps} style="font-weight: 500">Show it in the history</button>{/if}
          </div>
          {#if others.length}
            <p class="small" style="margin: 12px 0 0">
              Other items with changes the log does not explain:
              {#each others as c, k (c.item)}{k ? ', ' : ' '}<button type="button" class="link" onclick={() => (picked = c.item)}>{itemName(c.item)}</button>{/each}
            </p>
          {/if}
        </section>
      {/if}

      <section class="card">
        <div class="cardhead" style="align-items: center">
          <h2 class="h2 h3" style="flex: 1 1 auto">Balance over time</h2>
          {#if itemIds.length > 1}
            <div role="group" aria-label="What to chart" class="chips">
              {#each itemIds as i (i)}
                <button type="button" aria-pressed={i === item} onclick={() => (picked = i)}>{isMoney(i) ? 'Money' : itemName(i)}</button>
              {/each}
            </div>
          {/if}
        </div>
        {#if item === null}
          <p class="small" style="margin: 12px 0 0">This account has no item slots in the bank files.</p>
        {:else if points && points.length}
          <StepChart points={points} label="{isMoney(item) ? 'Money' : itemName(item)} on account {shown.number}" fmt={isMoney(item) ? moneyShort : quantity} {bands} />
          {#if bands.length}
            <p class="legend"><span class="swatch" aria-hidden="true"></span>Orange band: the balance changed and the log has no entry for it.</p>
          {/if}
        {:else if points}
          <p class="small" style="margin: 12px 0 0">No balance snapshots of {isMoney(item) ? 'money' : itemName(item)} on this account in this time range.</p>
        {/if}
      </section>

      <section class="card" bind:this={historyCard}>
        <div class="cardhead" style="align-items: center">
          <h2 class="h2 h3" style="flex: 1 1 auto">History</h2>
          <div role="group" aria-label="Filter the history" class="pills">
            {#each Object.entries(FILTERS) as [id, f] (id)}
              <button type="button" aria-pressed={filter === id} onclick={() => ((filter = id as keyof typeof FILTERS), (showAll = false))}>{f.label}</button>
            {/each}
          </div>
        </div>
        {#if rows.length === 0}
          <p style="margin: 16px 0 0; color: var(--text2)">{filter === 'gap' ? 'The log explains every change of this account in the selected time range.' : 'No entries of this kind in the selected time range.'}</p>
        {:else}
          <div style="overflow-x: auto; margin-top: 16px">
            <table>
              <thead>
                <tr><th>When</th><th>What happened</th><th class="r">Amount</th><th class="r">Balance after</th><th>Done by</th><th>Reference</th></tr>
              </thead>
              <tbody>
                {#each showAll ? rows : rows.slice(0, ROWS) as e (e.gap ? e.gap.id : e.row.id)}
                  {#if e.gap}
                    {@const g = e.gap}
                    <tr class="gap">
                      <td style="font-size: 13px; white-space: nowrap; color: var(--text2)">{gapWhen(g)}</td>
                      <td>
                        <span style="display: block; font-weight: 500; white-space: nowrap; color: var(--high)">{gapWhat(g)}</span>
                        <span class="small" style="display: block">{gapSub(g)}</span>
                      </td>
                      <td class="r" style="font-weight: 500; white-space: nowrap; color: var(--high)">{change(g.item, g.gap.difference)}</td>
                      <td class="r dim" style="white-space: nowrap">{value(g.item, g.gap.after)}</td>
                      <td class="dim" style="white-space: nowrap">not recorded</td>
                      <td></td>
                    </tr>
                  {:else}
                    {@const r = e.row}
                    <tr>
                      <td class="dim" style="font-size: 13px; white-space: nowrap">{time(r.time)}</td>
                      <td>
                        <span style="display: block; font-weight: 500; white-space: nowrap">{what(r)}</span>
                        <span class="small" style="display: block">{#if r.otherAccount !== null}{r.change !== null && r.change < 0n ? 'to ' : 'from '}<a
                            class="ref" href="#/accounts/{r.otherAccount}">account {r.otherAccount}</a>{sub(r) ? ' · ' : ''}{/if}{sub(r)}</span>
                      </td>
                      <td class="r" style="font-weight: 500; white-space: nowrap; color: {amountTone(r)}">{amount(r)}</td>
                      <td class="r dim" style="white-space: nowrap">{r.balanceAfter === null ? 'not recorded' : value(r.item, r.balanceAfter)}</td>
                      <td class="dim" style="white-space: nowrap">{by(r)}</td>
                      <td class="mono" style="font-size: 12px; color: var(--text3)">{r.ref ?? ''}</td>
                    </tr>
                  {/if}
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
        <div class="cardhead" style="margin-top: 16px">
          <p class="small" style="flex: 1 1 auto; margin: 0">
            {rows.length > ROWS && !showAll ? `The latest ${count(ROWS)} of ${count(rows.length)} entries` : `${count(rows.length)} ${rows.length === 1 ? 'entry' : 'entries'}`}{filter === 'all' ? '' : ` of ${count(everything.length)}`}, newest first.{hasTrades
              ? ' Trade entries carry no balance, the bank does not record one for them.' : ''}
          </p>
          {#if rows.length > ROWS}<button type="button" class="link" onclick={() => (showAll = !showAll)}>{showAll ? 'Show fewer' : 'Show all'}</button>{/if}
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .badge { flex: none; min-width: 32px; height: 32px; padding: 0 4px; box-sizing: border-box; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; background: var(--raised); color: var(--text2); }
  .pick[aria-current] .badge { background: var(--card); }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 4px; }
  .head { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
  .head .facts { margin-top: 4px; }
  .tiles { display: flex; flex-wrap: wrap; align-items: stretch; gap: 12px 8px; margin-top: 20px; }
  .tile { display: flex; align-items: center; gap: 8px; }
  .op { flex: none; width: 14px; text-align: center; font-size: 18px; color: var(--text3); }
  .tbox { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 10px; }
  .tbox.end { background: var(--raised); }
  .tvalue { font-size: 17px; line-height: 24px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .verdict { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; margin-top: 20px; padding: 16px; border-radius: 10px; border: 1px dashed var(--line2); }
  .verdict.open { border-color: var(--c); background: color-mix(in srgb, var(--c) 10%, transparent); }
  .vfig { flex: none; display: flex; flex-direction: column; }
  .vvalue { font-family: var(--font-head); font-size: 24px; line-height: 30px; font-weight: 600; color: var(--c); font-variant-numeric: tabular-nums; }
  .legend { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; font-size: 13px; color: var(--text2); }
  .swatch { flex: none; width: 12px; height: 12px; border-radius: 3px; background: var(--high); opacity: 0.6; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px; border-radius: 10px; background: var(--bg); border: 1px solid var(--line); }
  .chips button { height: 32px; padding: 0 12px; border: 0; border-radius: 7px; font-weight: 500; background: transparent; color: var(--text2); }
  .chips button[aria-pressed='true'] { background: var(--raised); color: var(--text); }
  .pills { display: flex; flex-wrap: wrap; gap: 8px; }
  .pills button { height: 36px; padding: 0 12px; border-radius: 18px; font-weight: 500; border: 1px solid var(--line2); background: transparent; color: var(--text2); }
  .pills button[aria-pressed='true'] { border-color: var(--accent); background: var(--accent); color: var(--onaccent); }
  td { vertical-align: top; }
  tr.gap { background: color-mix(in srgb, var(--high) 10%, transparent); outline: 1px dashed var(--high); outline-offset: -1px; }
</style>
