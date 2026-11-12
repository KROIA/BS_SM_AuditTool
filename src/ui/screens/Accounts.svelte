<script lang="ts">
  // Bank accounts: does the bank's log explain the balance? A list on the left, the picked account on the right.
  // The check of log against balance, the "No log entry" filter and the order by the unexplained amount come with M2.
  import type { AccountDetail, AccountRow, ItemRow, LedgerRow, Point } from '../../shared/api.ts';
  import { count, items as quantity, money, moneyShort, time } from '../../shared/fmt.ts';
  import StepChart from '../app/StepChart.svelte';
  import { app, engine } from '../app/state.svelte.ts';
  import { words } from '../app/words.ts';

  let { selected }: { selected: number | null } = $props();

  const ROWS = 10; // tables show this many rows until "Show all" (DESIGN_SPEC rule 3)
  let list = $state<AccountRow[] | null>(null);
  let itemRows = $state(new Map<number, ItemRow>());
  let detail = $state<AccountDetail | null>(null);
  let history = $state<LedgerRow[]>([]);
  let loadedFor = $state<number | null>(null); // the account the detail above was asked for; detail is null when it is unknown
  let picked = $state<number | null>(null); // the item chip the user picked
  let points = $state<Point[] | null>(null);
  let filter = $state<keyof typeof FILTERS>('all');
  let showAll = $state(false);

  const main = $derived(app.saves.find((s) => s.sources.some((x) => x.id === 'bank' && x.status !== 'none' && x.status !== 'missing')));
  const number = $derived(selected ?? list?.[0]?.number ?? null);
  const ready = $derived(loadedFor !== null && loadedFor === number);
  const shown = $derived(ready ? detail : null);
  const { itemName, isMoney, value, what, amount, amountTone } = $derived(words(itemRows));

  $effect(() => {
    const scope = $state.snapshot(app.scope);
    void app.saves.length; // ask again when saves come or go
    let stale = false;
    void Promise.all([engine.accounts(scope), engine.items()]).then(([a, i]) => {
      if (stale) return;
      list = a;
      itemRows = new Map(i.map((x) => [x.id, x]));
    });
    return () => (stale = true);
  });

  $effect(() => {
    const scope = $state.snapshot(app.scope), n = number;
    void app.saves.length;
    if (n === null) return;
    let stale = false;
    void Promise.all([engine.account(n, scope), engine.ledger({ accounts: [n] }, scope)]).then(([d, h]) => {
      if (stale) return;
      if (loadedFor !== n) [picked, filter] = [null, 'all'];
      [detail, history, showAll, loadedFor] = [d, h, false, n];
    });
    return () => (stale = true);
  });

  // The chart shows the picked item, else the account's money, else its first slot.
  const item = $derived.by(() => {
    const slots = shown?.items ?? [];
    return slots.find((s) => s.item === picked)?.item ?? slots.find((s) => isMoney(s.item))?.item ?? slots[0]?.item ?? null;
  });
  $effect(() => {
    const scope = $state.snapshot(app.scope), n = number, i = item;
    if (n === null || i === null) return;
    let stale = false;
    void engine.balances(n, i, scope).then((p) => !stale && (points = p));
    return () => ((stale = true), (points = null));
  });

  // ---- History ----
  const TRADES = new Set(['TRADE_BUY', 'TRADE_SELL', 'SHARE_TRADE']);
  const isAdmin = (r: LedgerRow) => r.kind.startsWith('ADMIN') || r.sourceKind === 'ADMIN';
  const FILTERS = {
    all: { label: 'Everything', keep: (_r: LedgerRow) => true },
    paid: { label: 'Paid in and out', keep: (r: LedgerRow) => !TRADES.has(r.kind) && !isAdmin(r) },
    trades: { label: 'Trades', keep: (r: LedgerRow) => TRADES.has(r.kind) },
    admin: { label: 'Admin actions', keep: (r: LedgerRow) => isAdmin(r) },
  };
  const rows = $derived(history.filter(FILTERS[filter].keep));
  const hasTrades = $derived(rows.some((r) => r.kind === 'TRADE_BUY' || r.kind === 'TRADE_SELL'));

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
  const kind = (a: AccountRow) => (a.company ? 'Company account' : a.owner ? 'Personal account' : 'Shared account');
  const figures = $derived.by(() => {
    if (!shown) return [];
    const s = shown, other = s.items.filter((i) => !isMoney(i.item) && i.balance + i.locked !== 0n).length;
    return [
      { label: 'Money on the account', value: moneyShort(s.money), full: money(s.money), note: 'at the time of the copy' },
      { label: 'Log entries', value: count(s.rows), full: '', note: 'in this time range' },
      { label: 'Item slots', value: count(s.items.length), full: '', note: other ? `${count(other)} holding items other than money` : s.items.length ? 'nothing held but money' : 'none in the bank files' },
    ];
  });
</script>

<div class="split">
  <aside aria-label="Account list">
    <div class="listhead">
      <h2>Accounts</h2>
      <span class="small">most money first</span>
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
              <span class="ellipsis" style="font-weight: 500">{a.name}</span>
              <span class="small">{moneyShort(a.money)}{a.company ? ' · company' : ''}{a.frozen ? ' · frozen' : ''}</span>
            </span>
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
          <h1 class="h1">Account {shown.number} · {shown.name}</h1>
          <div class="facts">
            <span>{kind(shown)}</span>
            {#if shown.company}<span>Company: {shown.company}</span>{/if}
            {#if shown.owner}<span>Owner: {shown.ownerName}</span>{/if}
            {#each shown.users.filter((u) => u.uuid !== shown.owner) as u (u.uuid)}
              <span>User: <a href="#/players/{encodeURIComponent(u.uuid)}">{u.name}</a>, {rights(u.permissions)}</span>
            {/each}
            {#if shown.createdMs}<span>Opened {time(shown.createdMs)}</span>{/if}
            <span>{shown.frozen ? 'Frozen' : 'Not frozen'}</span>
          </div>
        </div>
        {#if shown.owner}<a class="btn" href="#/players/{encodeURIComponent(shown.owner)}" style="font-weight: 500">Open the owner</a>{/if}
      </div>

      {#if main.generation === 'legacy'}
        <p class="small" style="margin: -8px 0 0">This save was written by BankSystem 2.1.2, which did not log trades or admin actions, so the history below is incomplete.</p>
      {/if}

      <section aria-label="Key figures" class="figures">
        {#each figures as k (k.label)}
          <div class="figure">
            <div class="flabel">{k.label}</div>
            <div class="fvalue" title={k.full || undefined}>{k.value}</div>
            <div class="small">{k.note}</div>
          </div>
        {/each}
      </section>

      <section class="card">
        <div class="cardhead" style="align-items: center">
          <h2 class="h2 h3" style="flex: 1 1 auto">Balance over time</h2>
          {#if shown.items.length > 1}
            <div role="group" aria-label="What to chart" class="chips">
              {#each shown.items as s (s.item)}
                <button type="button" aria-pressed={s.item === item} onclick={() => (picked = s.item)}>{isMoney(s.item) ? 'Money' : itemName(s.item)}</button>
              {/each}
            </div>
          {/if}
        </div>
        {#if item === null}
          <p class="small" style="margin: 12px 0 0">This account has no item slots in the bank files.</p>
        {:else if points && points.length}
          <StepChart points={points} label="{isMoney(item) ? 'Money' : itemName(item)} on account {shown.number}" fmt={isMoney(item) ? moneyShort : quantity} />
        {:else if points}
          <p class="small" style="margin: 12px 0 0">No balance snapshots of {isMoney(item) ? 'money' : itemName(item)} on this account in this time range.</p>
        {/if}
      </section>

      <section class="card">
        <div class="cardhead" style="align-items: center">
          <h2 class="h2 h3" style="flex: 1 1 auto">History</h2>
          <div role="group" aria-label="Filter the history" class="pills">
            {#each Object.entries(FILTERS) as [id, f] (id)}
              <button type="button" aria-pressed={filter === id} onclick={() => ((filter = id as keyof typeof FILTERS), (showAll = false))}>{f.label}</button>
            {/each}
          </div>
        </div>
        {#if rows.length === 0}
          <p style="margin: 16px 0 0; color: var(--text2)">No entries of this kind in the selected time range.</p>
        {:else}
          <div style="overflow-x: auto; margin-top: 16px">
            <table>
              <thead>
                <tr><th>When</th><th>What happened</th><th class="r">Amount</th><th class="r">Balance after</th><th>Done by</th><th>Reference</th></tr>
              </thead>
              <tbody>
                {#each showAll ? rows : rows.slice(0, ROWS) as r (r.id)}
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
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
        <div class="cardhead" style="margin-top: 16px">
          <p class="small" style="flex: 1 1 auto; margin: 0">
            {rows.length > ROWS && !showAll ? `The latest ${count(ROWS)} of ${count(rows.length)} entries` : `${count(rows.length)} ${rows.length === 1 ? 'entry' : 'entries'}`}{filter === 'all' ? '' : ` of ${count(history.length)}`}, newest first.{hasTrades
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
  .head { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
  .head .facts { margin-top: 4px; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px; border-radius: 10px; background: var(--bg); border: 1px solid var(--line); }
  .chips button { height: 32px; padding: 0 12px; border: 0; border-radius: 7px; font-weight: 500; background: transparent; color: var(--text2); }
  .chips button[aria-pressed='true'] { background: var(--raised); color: var(--text); }
  .pills { display: flex; flex-wrap: wrap; gap: 8px; }
  .pills button { height: 36px; padding: 0 12px; border-radius: 18px; font-weight: 500; border: 1px solid var(--line2); background: transparent; color: var(--text2); }
  .pills button[aria-pressed='true'] { border-color: var(--accent); background: var(--accent); color: var(--onaccent); }
  td { vertical-align: top; }
</style>
