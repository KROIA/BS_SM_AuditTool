<script lang="ts">
  // Players: what did this player do? A list on the left, the picked player on the right.
  // Findings, trading sessions, banknotes and connected players come with M2 to M4.
  import type { ItemRow, LedgerRow, OrderRow, PlayerDetail, PlayerRow } from '../../shared/api.ts';
  import { count, items as quantity, money, moneyShort, time } from '../../shared/fmt.ts';
  import { app, engine } from '../app/state.svelte.ts';

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
  /** "minecraft:iron_ingot" -> "Iron ingot" */
  function itemName(id: number): string {
    const name = itemRows.get(id)?.name;
    if (!name) return 'Item ' + id;
    const base = name.slice(name.indexOf(':') + 1).replaceAll('_', ' ');
    return base.charAt(0).toUpperCase() + base.slice(1);
  }
  const isMoney = (id: number) => itemRows.get(id)?.money ?? false;
  const initials = (name: string) => (name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '?').toUpperCase();
  const signed = (raw: bigint) => (raw > 0n ? '+' : '') + moneyShort(raw);
  const tone = (raw: bigint) => (raw > 0n ? 'var(--up)' : raw < 0n ? 'var(--down)' : 'var(--text)');
  const when = (ms: number | null) => (ms === null ? 'none in this time range' : time(ms));
  /** A balance change of any item: money as money, other items as a count with their name. */
  function change(item: number, raw: bigint): string {
    if (isMoney(item)) return (raw > 0n ? '+' : '') + money(raw);
    return (raw > 0n ? '+' : '') + quantity(raw) + ' ' + itemName(item);
  }

  const KIND: Record<string, string> = {
    DEPOSIT: 'Deposit', WITHDRAW: 'Withdrawal', TRANSFER: 'Transfer', WITHDRAW_REFUND: 'Withdrawal returned to the account',
    ADMIN_SET: 'Set by an admin', ADMIN_ADD: 'Added by an admin', ADMIN_REMOVE: 'Removed by an admin', ADMIN_UNLOCK: 'Locked money released by an admin',
    ADMIN_ACCOUNT_EDIT: 'Account changed by an admin', BANK_CLOSED: 'Item slot closed', CONVERTER_DEPOSIT: 'Paid in through a converter',
    CONVERTER_WITHDRAW: 'Paid out through a converter', UPLOAD_DEPOSIT: 'Paid in through an upload block', DOWNLOAD_WITHDRAW: 'Paid out through a download block',
    CRAFT_CONSUME: 'Used for crafting', CRAFT_OUTPUT: 'Made by crafting', STARTING_BALANCE: 'Starting balance', PAYOUT: 'Company payout', DIVIDEND: 'Dividend',
    SHARE_STAMP: 'Shares stamped', SHARE_REDEEM: 'Shares redeemed', SHARE_TRADE: 'Shares traded', ACCOUNT_DELETE_PAYOUT: 'Paid out when the account was deleted',
    ACCOUNT_FREEZE: 'Account frozen or unfrozen', ADMIN_DISALLOW_ITEM: 'Item disallowed by an admin', ACCOUNT_DELETE_LOSS: 'Lost when the account was deleted',
    RAW_CHANGE: 'Balance changed outside the bank', EXTERNAL_BIND: 'External account bound', EXTERNAL_UNBIND: 'External account unbound',
    TRANSFER_IN: 'Transfer', TRANSFER_OUT: 'Transfer', UNKNOWN_LEGACY: 'Change of an unknown kind',
  };
  function what(r: LedgerRow): string {
    if (r.kind === 'TRADE_BUY' || r.kind === 'TRADE_SELL') return `${r.kind === 'TRADE_BUY' ? 'Bought' : 'Sold'} ${quantity(r.amount < 0n ? -r.amount : r.amount)} ${itemName(r.item)}`;
    return KIND[r.kind] ?? r.kind;
  }
  function detailOf(r: LedgerRow): string {
    const parts = ['Account ' + r.account];
    if (r.otherAccount !== null) parts.push(`${r.change !== null && r.change < 0n ? 'to' : 'from'} account ${r.otherAccount}`);
    const order = /^sm:order:(\d+)$/.exec(r.ref ?? '');
    if (order) parts.push('order ' + order[1]);
    else if (r.ref?.startsWith('sm:im:')) parts.push('inter-market order');
    if (r.actor !== uuid && r.actorName) parts.push('by ' + r.actorName);
    if (r.kind === 'ADMIN_SET' && r.change !== null && r.balanceAfter !== null && isMoney(r.item)) parts.push(`from ${money(r.balanceAfter - r.change)} to ${money(r.balanceAfter)}`);
    else if (r.note) parts.push(r.note);
    if (r.change === null) parts.push('the log does not say in which direction');
    return parts.join(' · ');
  }
  const bankAmount = (r: LedgerRow) => (r.money ? change(r.money.item, r.money.change) : r.change === null ? quantity(r.amount) : change(r.item, r.change));
  const bankTone = (r: LedgerRow) => { const v = r.money?.change ?? r.change; return v === null ? 'var(--text3)' : tone(v); };
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

  // ---- Money over time: a step line, because a balance holds until the next snapshot ----
  const W = 1000, H = 180;
  const chart = $derived.by(() => {
    const pts = shown?.money ?? [];
    if (!pts.length) return null;
    let lo = 0n, hi = 0n;
    for (const [, v] of pts) [lo, hi] = [v < lo ? v : lo, v > hi ? v : hi];
    if (hi === lo) hi = lo + 100n;
    const x0 = pts[0]![0], x1 = Math.max(pts.at(-1)![0], x0 + 1);
    const x = (ms: number) => (((ms - x0) / (x1 - x0)) * W).toFixed(1);
    const y = (v: bigint) => (H - (Number(v - lo) / Number(hi - lo)) * H).toFixed(1); // only the drawing goes through a float
    let line = `M0 ${y(pts[0]![1])}`;
    for (const [ms, v] of pts.slice(1)) line += ` H${x(ms)} V${y(v)}`;
    line += ` H${W}`;
    return { line, area: `${line} V${y(lo < 0n ? 0n : lo)} H0 Z`, zero: y(0n), top: moneyShort(hi), mid: moneyShort((hi + lo) / 2n), bottom: moneyShort(lo), from: time(x0), to: time(x1) };
  });

  const ownAccounts = $derived(shown?.accounts.filter((a) => a.owner) ?? []);
  const sharedAccounts = $derived(shown?.accounts.filter((a) => !a.owner) ?? []);
</script>

<div class="players">
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
        {#each ownAccounts as a (a.number)}<span>Own account {a.number}, {a.name}</span>{/each}
        {#each sharedAccounts as a (a.number)}<span>{a.company ? 'Company' : 'Shared'} account {a.number}, {a.name}</span>{/each}
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
        {#if chart}
          <div class="chart">
            <svg viewBox="0 0 {W} {H}" preserveAspectRatio="none" role="img" aria-label="Money in the bank from {chart.from} to {chart.to}">
              <path d="M0 0H{W}M0 {H / 2}H{W}M0 {H}H{W}" class="grid" />
              <path d={chart.area} class="area" />
              <path d={chart.line} class="line" />
            </svg>
            <div class="yaxis" aria-hidden="true">
              <span style="top: -8px">{chart.top}</span>
              <span style="top: {H / 2 - 8}px">{chart.mid}</span>
              <span style="top: {H - 8}px">{chart.bottom}</span>
            </div>
          </div>
          <div class="xaxis" aria-hidden="true"><span>{chart.from}</span><span>{chart.to}</span></div>
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
                    <span class="small">{detailOf(r)}</span>
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
  .players { display: flex; flex-wrap: wrap; min-height: 100%; }
  aside { flex: 1 1 264px; max-width: 320px; box-sizing: border-box; padding: 24px 12px; border-right: 1px solid var(--line); }
  .listhead { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 0 12px; }
  .listhead h2 { margin: 0; font-size: 12px; line-height: 16px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text3); }
  .pad { margin: 12px; }
  .roster { display: flex; flex-direction: column; gap: 2px; margin-top: 12px; }
  .pick { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 0 12px; border-radius: 8px; }
  .pick[aria-current] { background: var(--raised); }
  .avatar { flex: none; width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; background: var(--raised); color: var(--text2); }
  .pick[aria-current] .avatar { background: var(--card); }
  .avatar.big { width: 56px; height: 56px; border-radius: 14px; font-family: var(--font-head); font-size: 20px; }
  .who { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .detail { flex: 999 1 560px; min-width: 0; box-sizing: border-box; display: flex; flex-direction: column; gap: 24px; padding: 28px 32px 40px; }
  .head { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; }
  .uuid { margin: 2px 0 0; font-family: var(--font-mono); font-size: 13px; color: var(--text3); overflow-wrap: anywhere; }
  .lead { margin: -8px 0 0; font-size: 16px; line-height: 24px; text-wrap: pretty; }
  .facts { display: flex; flex-wrap: wrap; gap: 8px 24px; margin-top: -8px; font-size: 13px; color: var(--text2); }
  .figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); gap: 16px; }
  .figure { display: flex; flex-direction: column; gap: 6px; padding: 20px; border-radius: 14px; background: var(--card); border: 1px solid var(--line); }
  .flabel { font-size: 13px; color: var(--text2); }
  .fvalue { font-family: var(--font-head); font-size: 26px; line-height: 32px; font-weight: 600; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
  .h3 { font-size: 17px; line-height: 24px; }
  .cardhead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; }
  .chart { display: flex; gap: 12px; margin-top: 20px; }
  .chart svg { flex: 1 1 0; min-width: 0; height: 180px; overflow: visible; }
  .grid { fill: none; stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .area { fill: var(--accent); fill-opacity: 0.12; stroke: none; }
  .line { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
  .yaxis { position: relative; flex: none; width: 88px; height: 180px; font-size: 12px; line-height: 16px; color: var(--text3); }
  .yaxis span { position: absolute; left: 0; white-space: nowrap; }
  .xaxis { display: flex; justify-content: space-between; margin: 10px 100px 0 0; font-size: 12px; line-height: 16px; color: var(--text3); }
  .tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid var(--line); }
  .tabs button { height: 44px; margin-bottom: -1px; padding: 0 14px; border: 0; border-bottom: 2px solid transparent; background: transparent; font-weight: 500; color: var(--text2); }
  .tabs button[aria-selected='true'] { border-bottom-color: var(--accent); color: var(--text); }
  .empty { margin: 0; padding: 24px; border-radius: 14px; border: 1px dashed var(--line2); color: var(--text2); }
  .markets { display: flex; flex-direction: column; gap: 2px; margin: 12px -10px 0; }
  .market { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 0 10px; border-radius: 10px; }
  .num { flex: none; font-weight: 500; font-variant-numeric: tabular-nums; }
  .link { padding: 0; border: 0; background: none; font-size: 13px; font-weight: 500; color: var(--accent); }
  table { width: 100%; min-width: 760px; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th { padding: 0 12px 10px; font-size: 12px; font-weight: 600; color: var(--text3); text-align: left; }
  td { padding: 12px; border-top: 1px solid var(--line); }
  th:first-child, td:first-child { padding-left: 0; }
  th:last-child, td:last-child { padding-right: 0; }
  .r { text-align: right; }
  .dim { color: var(--text2); }
  .mono { font-family: var(--font-mono); font-size: 13px; white-space: nowrap; }
  .history { display: flex; flex-direction: column; gap: 4px; margin: 12px -12px 0; }
  .entry { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; padding: 12px; border-radius: 10px; }
  .etime { flex: 0 0 170px; font-size: 13px; color: var(--text2); font-variant-numeric: tabular-nums; }
</style>
