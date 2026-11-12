<script lang="ts">
  // Players: what did this player do? A list on the left, the picked player on the right.
  // Findings, trading sessions, banknotes and connected players come with M2 to M4.
  import type { ItemRow, LedgerRow, OrderRow, PlayerDetail, PlayerRow } from '../../shared/api.ts';
  import { count, items as quantity, money, moneyShort, time } from '../../shared/fmt.ts';
  import StepChart from '../app/StepChart.svelte';
  import { app, engine } from '../app/state.svelte.ts';
  import { tone, words } from '../app/words.ts';

  let { selected }: { selected: string | null } = $props();

  const ROWS = 10; // tables show this many rows until "Show all" (DESIGN_SPEC rule 3)
  let list = $state<PlayerRow[] | null>(null);
  let itemRows = $state(new Map<number, ItemRow>());
  let detail = $state<PlayerDetail | null>(null);
  let orders = $state<OrderRow[]>([]);
  let bank = $state<LedgerRow[]>([]);
  let tab = $state<'trades' | 'bank'>('trades');
  let allOrders = $state(false);
  let allBank = $state(false);
  let loadedFor = $state<string | null>(null); // the player the detail above was asked for; detail is null when that player is unknown

  const main = $derived(app.saves.find((s) => s.sources.some((x) => (x.id === 'bank' || x.id === 'market') && x.status !== 'none' && x.status !== 'missing')));
  const uuid = $derived(selected ?? list?.[0]?.uuid ?? null);
  const ready = $derived(loadedFor !== null && loadedFor === uuid);
  const shown = $derived(ready ? detail : null);

  $effect(() => {
    const scope = $state.snapshot(app.scope);
    void app.saves.length; // ask again when saves come or go
    let stale = false;
    void Promise.all([engine.players(scope), engine.items()]).then(([p, i]) => {
      if (stale) return;
      list = p;
      itemRows = new Map(i.map((x) => [x.id, x]));
    });
    return () => (stale = true);
  });

  $effect(() => {
    const scope = $state.snapshot(app.scope), who = uuid;
    void app.saves.length;
    if (!who) return;
    let stale = false;
    void (async () => {
      const d = await engine.player(who, scope);
      const [o, b] = d ? await Promise.all([engine.orders({ player: who }, scope), engine.ledger({ accounts: d.accounts.map((a) => a.number) }, scope)]) : [[], []];
      if (stale) return;
      [detail, orders, bank, allOrders, allBank, loadedFor] = [d, o, b, false, false, who];
    })();
    return () => (stale = true);
  });

  // ---- Words ----
  const { itemName, isMoney, what, amount: bankAmount, amountTone: bankTone } = $derived(words(itemRows));
  const initials = (name: string) => (name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '?').toUpperCase();
  const signed = (raw: bigint) => (raw > 0n ? '+' : '') + moneyShort(raw);
  const when = (ms: number | null) => (ms === null ? 'none in this time range' : time(ms));

  /** The rest of a row's detail line, after its account numbers (those are links). */
  function detailOf(r: LedgerRow): string {
    const parts = [''];
    const order = /^sm:order:(\d+)$/.exec(r.ref ?? '');
    if (order) parts.push('order ' + order[1]);
    else if (r.ref?.startsWith('sm:im:')) parts.push('inter-market order');
    if (r.actor !== uuid && r.actorName) parts.push('by ' + r.actorName);
    if (r.kind === 'ADMIN_SET' && r.change !== null && r.balanceAfter !== null && isMoney(r.item)) parts.push(`from ${money(r.balanceAfter - r.change)} to ${money(r.balanceAfter)}`);
    else if (r.note) parts.push(r.note);
    if (r.change === null) parts.push('the log does not say in which direction');
    return parts.join(' · ');
  }
  const SIDE = { market: 'Market', limit: 'Limit', intermarket: 'Inter-market' };

  // ---- Figures ----
  const lead = $derived.by(() => {
    if (!shown) return '';
    const s = shown;
    if (s.orders === 0) return `${s.name} placed no orders in this time range.`;
    const result = s.profit === 0n ? 'made no realised trading profit' : s.profit > 0n ? `made ${moneyShort(s.profit)} trading profit` : `lost ${moneyShort(-s.profit)} trading`;
    const where = s.markets.length === 1 ? `on the ${itemName(s.markets[0]!.item)} market` : `on ${count(s.markets.length)} markets`;
    const without = s.markets.reduce((sum, m) => sum + m.soldWithoutPurchase, 0n);
    return `${s.name} ${result} in this time range, ${where}.` + (without > 0n ? ` Items worth ${moneyShort(without)} were sold that the player had not bought on the market.` : '');
  });
  const figures = $derived.by(() => {
    if (!shown) return [];
    const s = shown, own = s.accounts.filter((a) => a.owner).map((a) => a.number);
    const without = s.markets.reduce((sum, m) => sum + m.soldWithoutPurchase, 0n);
    const buys = orders.filter((o) => o.amount > 0n).length;
    return [
      { label: 'Realised trading profit', value: signed(s.profit), full: money(s.profit), fg: tone(s.profit),
        note: without > 0n ? `plus ${moneyShort(without)} sold without a purchase` : s.markets.length ? `on ${count(s.markets.length)} ${s.markets.length === 1 ? 'market' : 'markets'}` : 'no trades in this time range' },
      { label: 'Orders', value: count(s.orders), full: '', fg: 'var(--text)', note: s.orders ? `${count(buys)} bought, ${count(s.orders - buys)} sold` : 'none in this time range' },
      { label: 'Money in the bank now', value: moneyShort(s.moneyNow), full: money(s.moneyNow), fg: 'var(--text)',
        note: own.length === 0 ? 'has no account of their own' : `own ${own.length === 1 ? 'account' : 'accounts'} ${own.join(', ')}, at the time of the copy` },
    ];
  });

  const ownAccounts = $derived(shown?.accounts.filter((a) => a.owner) ?? []);
  const sharedAccounts = $derived(shown?.accounts.filter((a) => !a.owner) ?? []);
</script>

<div class="split">
  <aside aria-label="Player list">
    <div class="listhead">
      <h2>Players</h2>
      <span class="small">highest profit first</span>
    </div>
    {#if !main}
      <p class="small pad">No save with bank and market data is loaded.</p>
    {:else if list && list.length === 0}
      <p class="small pad">This save lists no players.</p>
    {:else if list}
      <div class="roster">
        {#each list as p (p.uuid)}
          <a class="row pick" href={'#/players/' + encodeURIComponent(p.uuid)} aria-current={p.uuid === uuid ? 'true' : undefined}>
            <span class="avatar" aria-hidden="true">{initials(p.name)}</span>
            <span class="who">
              <span style="font-weight: 500">{p.name}</span>
              <span class="small ellipsis">{p.orders === 0 ? 'no orders' : p.profit === 0n ? `${count(p.orders)} ${p.orders === 1 ? 'order' : 'orders'}, no profit` : `${signed(p.profit)} trading profit`}</span>
            </span>
          </a>
        {/each}
      </div>
    {/if}
  </aside>

  <div class="detail">
    {#if !main}
      <div>
        <h1 class="h1">Players</h1>
        <p class="sub">What did this player do?</p>
      </div>
      <p class="empty">Players come from the master's save. Open it on the <a href="#/saves" style="color: var(--accent)">Saves and servers</a> screen.</p>
    {:else if !uuid}
      <h1 class="h1">Players</h1>
      {#if list}<p class="empty">This save lists no players.</p>{/if}
    {:else if !ready}
      <p class="small" aria-busy="true">Loading the player…</p>
    {:else if !shown}
      <h1 class="h1">Players</h1>
      <p class="empty">This player is not in the loaded saves.</p>
    {:else}
      <div class="head">
        <span class="avatar big" aria-hidden="true">{initials(shown.name)}</span>
        <div style="flex: 1 1 320px; min-width: 0">
          <h1 class="h1">{shown.name}</h1>
          <p class="uuid">{shown.uuid}</p>
        </div>
      </div>

      <p class="lead">{lead}</p>

      <div class="facts">
        <span>First activity: {when(shown.firstMs)}</span>
        <span>Last activity: {when(shown.lastMs)}</span>
        {#each ownAccounts as a (a.number)}<span>Own account <a href="#/accounts/{a.number}">{a.number}</a>, {a.name}</span>{/each}
        {#each sharedAccounts as a (a.number)}<span>{a.company ? 'Company' : 'Shared'} account <a href="#/accounts/{a.number}">{a.number}</a>, {a.name}</span>{/each}
      </div>

      <section aria-label="Key figures" class="figures">
        {#each figures as k (k.label)}
          <div class="figure">
            <div class="flabel">{k.label}</div>
            <div class="fvalue" style="color: {k.fg}" title={k.full || undefined}>{k.value}</div>
            <div class="small">{k.note}</div>
          </div>
        {/each}
      </section>

      <section class="card">
        <div class="cardhead">
          <h2 class="h2 h3">Money in the bank</h2>
          <span class="small">the player's own accounts</span>
        </div>
        {#if shown.money.length}
          <StepChart points={shown.money} label="Money in the bank" fmt={moneyShort} />
        {:else}
          <p class="small" style="margin: 12px 0 0">No balance snapshots of the player's own accounts in this time range.</p>
        {/if}
      </section>

      <div role="tablist" aria-label="Player details" class="tabs">
        <button type="button" role="tab" aria-selected={tab === 'trades'} onclick={() => (tab = 'trades')}>Trades</button>
        <button type="button" role="tab" aria-selected={tab === 'bank'} onclick={() => (tab = 'bank')}>Bank history</button>
      </div>

      {#if tab === 'trades'}
        {#if orders.length === 0}
          <p class="empty">No orders in the selected time range.</p>
        {:else}
          <section class="card">
            <h2 class="h2 h3">Profit by market</h2>
            <div class="markets">
              {#each shown.markets as m (m.item)}
                <div class="market">
                  <span class="who">
                    <span style="font-weight: 500">{itemName(m.item)}</span>
                    <span class="small">{count(m.orders)} {m.orders === 1 ? 'order' : 'orders'}{m.bought ? `, bought for ${moneyShort(m.bought)}` : ''}{m.sold ? `, sold for ${moneyShort(m.sold)}` : ''}{m.soldWithoutPurchase ? `, ${moneyShort(m.soldWithoutPurchase)} of it without a purchase` : ''}</span>
                  </span>
                  <span class="num" style="color: {tone(m.profit)}" title={money(m.profit)}>{signed(m.profit)}</span>
                </div>
              {/each}
            </div>
          </section>
          <section class="card">
            <div class="cardhead">
              <h2 class="h2 h3" style="flex: 1 1 auto">Orders</h2>
              <span class="small">{orders.length > ROWS && !allOrders ? `the latest ${count(ROWS)} of ${count(orders.length)}` : `${count(orders.length)}, newest first`}</span>
              {#if orders.length > ROWS}<button type="button" class="link" onclick={() => (allOrders = !allOrders)}>{allOrders ? 'Show fewer' : 'Show all'}</button>{/if}
            </div>
            <div style="overflow-x: auto; margin-top: 12px">
              <table>
                <thead>
                  <tr><th>Time</th><th>Market</th><th>Side</th><th>Kind</th><th class="r">Quantity</th><th class="r">Average price</th><th class="r">Value</th><th>Placed on</th></tr>
                </thead>
                <tbody>
                  {#each allOrders ? orders : orders.slice(0, ROWS) as o (o.id)}
                    <tr>
                      <td class="mono">{o.time ? time(o.time, false, true) : 'no time recorded'}</td>
                      <td>{itemName(o.item)}</td>
                      <td style="font-weight: 500; color: {o.amount > 0n ? 'var(--buy)' : 'var(--sell)'}">{o.amount > 0n ? 'Buy' : 'Sell'}</td>
                      <td class="dim">{SIDE[o.type]}</td>
                      <td class="r">{quantity(o.amount < 0n ? -o.amount : o.amount)}</td>
                      <td class="r">{money(o.price)}</td>
                      <td class="r">{money(o.money < 0n ? -o.money : o.money)}</td>
                      <td class="dim">{o.server ?? 'not recorded'}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          </section>
        {/if}
      {:else}
        {#if main.generation === 'legacy'}
          <p class="small" style="margin: 0">This save was written by BankSystem 2.1.2, which did not log trades or admin actions.</p>
        {/if}
        {#if bank.length === 0}
          <p class="empty">No bank log entries for this player's accounts in the selected time range.</p>
        {:else}
          <section class="card">
            <div class="cardhead">
              <h2 class="h2 h3" style="flex: 1 1 auto">Bank history</h2>
              <span class="small">{bank.length > ROWS && !allBank ? `the latest ${count(ROWS)} of ${count(bank.length)}` : `${count(bank.length)}, newest first`}, all accounts of the player</span>
              {#if bank.length > ROWS}<button type="button" class="link" onclick={() => (allBank = !allBank)}>{allBank ? 'Show fewer' : 'Show all'}</button>{/if}
            </div>
            <div class="history">
              {#each allBank ? bank : bank.slice(0, ROWS) as r (r.id)}
                <div class="entry">
                  <span class="etime">{time(r.time)}</span>
                  <span class="who" style="flex: 1 1 260px">
                    <span style="font-weight: 500">{what(r)}</span>
                    <span class="small"><a class="ref" href="#/accounts/{r.account}">Account {r.account}</a>{#if r.otherAccount !== null}{` · ${r.change !== null && r.change < 0n ? 'to' : 'from'} `}<a
                          class="ref" href="#/accounts/{r.otherAccount}">account {r.otherAccount}</a>{/if}{detailOf(r)}</span>
                  </span>
                  <span class="num" style="color: {bankTone(r)}">{bankAmount(r)}</span>
                </div>
              {/each}
            </div>
          </section>
        {/if}
      {/if}
    {/if}
  </div>
</div>

<style>
  .avatar { flex: none; width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; background: var(--raised); color: var(--text2); }
  .pick[aria-current] .avatar { background: var(--card); }
  .avatar.big { width: 56px; height: 56px; border-radius: 14px; font-family: var(--font-head); font-size: 20px; }
  .head { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
  .uuid { margin: 2px 0 0; font-family: var(--font-mono); font-size: 13px; color: var(--text3); overflow-wrap: anywhere; }
  .tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--line); }
  .tabs button { height: 44px; margin-bottom: -1px; padding: 0 14px; border: 0; border-bottom: 2px solid transparent; background: transparent; font-weight: 500; color: var(--text2); }
  .tabs button[aria-selected='true'] { border-bottom-color: var(--accent); color: var(--text); }
  .markets { display: flex; flex-direction: column; gap: 2px; margin: 12px -10px 0; }
  .market { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 0 10px; border-radius: 10px; }
  .history { display: flex; flex-direction: column; gap: 4px; margin: 12px -12px 0; }
  .entry { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; padding: 12px; border-radius: 10px; }
  .etime { flex: 0 0 170px; font-size: 13px; color: var(--text2); font-variant-numeric: tabular-nums; }
</style>
