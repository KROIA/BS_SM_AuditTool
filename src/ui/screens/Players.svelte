<script lang="ts">
  // Players: what did this player do? A list on the left, the picked player on the right.
  // The list is in the suspicion order (DESIGN_SPEC 8.3), then by profit. Connected players come with M4.
  import type { BanknotesResult, Finding, ItemRow, LedgerRow, Level, OrderRow, PlayerDetail, PlayerRow, Session, WorldItemsResult, WorldStack } from '../../shared/api.ts';
  import { span } from '../../shared/finding.ts';
  import { count, items as quantity, money, moneyShort, time } from '../../shared/fmt.ts';
  import { blamed, suspicion } from '../../shared/incident.ts';
  import FindingLinks from '../app/FindingLinks.svelte';
  import StepChart from '../app/StepChart.svelte';
  import { app, engine } from '../app/state.svelte.ts';
  import { entries, gapRows, heldText, LEVEL_COLOR, tone, whereMade, words, type GapRow } from '../app/words.ts';

  let { selected }: { selected: string | null } = $props();

  const ROWS = 10; // tables show this many rows until "Show all" (DESIGN_SPEC rule 3)
  let list = $state<PlayerRow[] | null>(null);
  let itemRows = $state(new Map<number, ItemRow>());
  let detail = $state<PlayerDetail | null>(null);
  let orders = $state<OrderRow[]>([]);
  let bank = $state<LedgerRow[]>([]);
  let gaps = $state<GapRow[]>([]);
  let found = $state<Finding[]>([]);
  let sessions = $state<Session[]>([]);
  let allSessions = $state(false);
  let tab = $state<'trades' | 'bank' | 'notes'>('trades');
  let notes = $state<BanknotesResult | null>(null);
  let world = $state<WorldItemsResult | null>(null);
  let allOrders = $state(false);
  let allBank = $state(false);
  let loadedFor = $state<string | null>(null); // the player the detail above was asked for; detail is null when that player is unknown

  const main = $derived(app.saves.find((s) => s.sources.some((x) => (x.id === 'bank' || x.id === 'market') && x.status !== 'none' && x.status !== 'missing')));
  // Most suspicious first: findings not marked as "not a problem", weighted by level; the engine's profit order breaks ties.
  const dismissed = (id: string) => app.marks[id]?.dismissed === true;
  const open = $derived(found.filter((f) => !dismissed(f.id)));
  const ordered = $derived.by(() => {
    if (!list) return null;
    const score = suspicion(found, dismissed);
    return [...list].sort((a, b) => (score.get(b.uuid) ?? 0) - (score.get(a.uuid) ?? 0));
  });
  /** Open findings per player, with the highest level (findings come highest level first). */
  const flags = $derived.by(() => {
    const out = new Map<string, { n: number; level: Level }>();
    for (const f of open) for (const p of blamed(f)) out.set(p.uuid, { n: (out.get(p.uuid)?.n ?? 0) + 1, level: out.get(p.uuid)?.level ?? f.level });
    return out;
  });
  const uuid = $derived(selected ?? ordered?.[0]?.uuid ?? null);
  const flagged = $derived(open.filter((f) => blamed(f).some((p) => p.uuid === uuid)));
  const ready = $derived(loadedFor !== null && loadedFor === uuid);
  const shown = $derived(ready ? detail : null);

  $effect(() => {
    const scope = $state.snapshot(app.scope), rules = $state.snapshot(app.rules);
    void app.saves.length; // ask again when saves come or go
    let stale = false;
    void Promise.all([engine.players(scope), engine.items(), engine.findings(scope, rules)]).then(([p, i, f]) => {
      if (stale) return;
      [list, found] = [p, f.findings];
      itemRows = new Map(i.map((x) => [x.id, x]));
    });
    return () => (stale = true);
  });

  $effect(() => {
    const scope = $state.snapshot(app.scope), rules = $state.snapshot(app.rules), who = uuid;
    void app.saves.length;
    if (!who) return;
    let stale = false;
    void (async () => {
      const d = await engine.player(who, scope);
      const numbers = d?.accounts.map((a) => a.number) ?? [];
      const [o, b, s, c] = d
        ? await Promise.all([engine.orders({ player: who }, scope), engine.ledger({ accounts: numbers }, scope), engine.sessions(who, scope), Promise.all(numbers.map((n) => engine.check(n, scope, rules)))])
        : [[], [], [], []];
      if (stale) return;
      [detail, orders, bank, sessions, allOrders, allBank, allSessions, loadedFor] = [d, o, b, s, false, false, false, who];
      gaps = numbers.flatMap((n, k) => gapRows(n, c[k]!));
    })();
    return () => (stale = true);
  });

  // The Banknotes and items tab asks only while it is open: the count and the world take a while on a large save.
  $effect(() => {
    const scope = $state.snapshot(app.scope);
    void app.saves.length;
    void app.scanRound; // the region scan finds bank terminals with the player's slots
    if (tab !== 'notes') return;
    let stale = false;
    void Promise.all([engine.banknotes(scope), engine.worldItems()]).then(([b, w]) => {
      if (!stale) [notes, world] = [b, w];
    });
    return () => (stale = true);
  });

  // ---- Words ----
  const { itemName, isMoney, what, amount: bankAmount, amountTone: bankTone, change, gapWhat, gapSub, gapWhen } = $derived(words(itemRows));
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
    const where = whereMade(r, main?.name);
    if (where) parts.push(where);
    return parts.join(' · ');
  }
  const SIDE = { market: 'Market', limit: 'Limit', intermarket: 'Inter-market' };
  /** SM-317: the limit price beside the kind; a limit price of 0 is a market order. */
  const kindOf = (o: OrderRow) => (o.limitPrice !== null && o.limitPrice > 0n && o.type !== 'intermarket' ? `Limit at ${money(o.limitPrice)}` : SIDE[o.type]);
  const abs = (v: bigint) => (v < 0n ? -v : v);
  /** Filled, and of how many when the player wanted another amount (SM-317). */
  const filled = (o: OrderRow) => quantity(abs(o.amount)) + (o.wanted !== null && abs(o.wanted) !== abs(o.amount) ? ` of ${quantity(abs(o.wanted))}` : '');

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
      { label: 'Open findings', value: count(flagged.length), full: '', fg: flagged[0] ? LEVEL_COLOR[flagged[0].level] : 'var(--text)',
        note: flagged.length ? LEVELS.map((l) => [l, flagged.filter((f) => f.level === l).length] as const).filter(([, n]) => n).map(([l, n]) => `${count(n)} ${l}`).join(', ') : 'nothing flagged in this time range' },
    ];
  });
  const LEVELS: Level[] = ['critical', 'high', 'medium', 'low'];

  // ---- Sessions and bank history ----
  /** Time between orders: ms below a second, else seconds, else minutes. */
  const apart = (ms: number) => (ms < 1000 ? `${count(Math.round(ms))} ms` : ms < 60_000 ? `${count(Math.round(ms / 1000))} s` : `${count(Math.round(ms / 60_000))} min`);
  const sessionRows = $derived([...sessions].reverse().map((s) => {
    const f = flagged.find((x) => x.start <= s.end && x.end >= s.start); // the strongest finding in the session's time
    return {
      key: s.start, when: span(s.start, s.end), market: s.markets.length === 1 ? itemName(s.markets[0]!) : `${count(s.markets.length)} markets`, item: s.markets.length === 1 ? s.markets[0]! : null,
      sub: `${count(s.orders)} ${s.orders === 1 ? 'order' : 'orders'}${s.medianGapMs === null ? '' : `, ${apart(s.medianGapMs)} apart`}`,
      profit: s.profit, dot: f ? LEVEL_COLOR[f.level] : 'var(--line2)',
    };
  }));
  const bankEntries = $derived(entries(bank, gaps));

  // ---- Banknotes and items ----
  /** What the log and NoteFlow say this player did with notes in the range (an estimate: notes change hands). */
  const moves = $derived(notes?.players.find((p) => p.player.uuid === uuid) ?? null);
  const noteRows = $derived.by(() => {
    if (!shown || !notes || notes.reason !== null) return [];
    const m = moves ?? { out: 0n, back: 0n, created: 0n, destroyed: 0n, net: 0n };
    const own = new Set(shown.accounts.filter((a) => a.owner).map((a) => a.number));
    const mine = notes.accounts.filter((a) => own.has(a.account));
    const intoOwn = mine.reduce((sum, a) => sum + a.back, 0n), outOfOwn = mine.reduce((sum, a) => sum + a.out, 0n);
    return [
      { label: 'Withdrawn as banknotes', raw: m.out, total: false },
      { label: `Paid back in by ${shown.name}`, raw: m.back, total: false },
      ...(m.created ? [{ label: 'Made outside the bank (converter, villagers, creative mode)', raw: m.created, total: false }] : []),
      ...(m.destroyed ? [{ label: 'Destroyed outside the bank (converter, villagers)', raw: m.destroyed, total: false }] : []),
      // The accounts tell what others did: notes paid into this player's accounts, or taken out of them, by someone else.
      ...(intoOwn !== m.back ? [{ label: 'Paid into their own accounts by anyone', raw: intoOwn, total: false }] : []),
      ...(outOfOwn !== m.out ? [{ label: 'Withdrawn from their own accounts by anyone', raw: outOfOwn, total: false }] : []),
      { label: 'Still outside the bank, if nobody else used them', raw: m.net, total: true },
    ];
  });
  /** What the player carries, per place and server, and the bank terminal slots the region scan found for them. */
  const carried = $derived.by(() => {
    if (!world || world.reason !== null || !uuid) return [];
    const server = app.scope.server, p = world.players.find((x) => x.player.uuid === uuid);
    const held = new Map<string, WorldStack[]>();
    for (const s of p ? [...p.stacks, ...p.valuables] : []) {
      const k = `${s.place} on ${s.server}`;
      if (server === null || s.server === server) held.set(k, [...(held.get(k) ?? []), s]);
    }
    const out = [...held].map(([k, list]) => ({ key: k, label: k.charAt(0).toUpperCase() + k.slice(1), sub: heldText(list), raw: list.reduce((a, s) => a + (s.value ?? 0n), 0n) }));
    for (const t of world.places) {
      if (t.player?.uuid !== uuid || (server !== null && t.server !== server)) continue;
      out.push({ key: t.server + t.where, label: `Slots at a ${t.where}`, sub: `${t.server}, ${heldText([...t.stacks, ...t.valuables])}`, raw: t.notes });
    }
    return out;
  });
  const carriedNote = $derived.by(() => {
    if (!world || !shown) return '';
    if (world.reason !== null) return world.reason;
    if (world.unreadable.some((p) => p.uuid === shown.uuid)) return `What ${shown.name} carries is unknown: the player file could not be read.`;
    if (world.missing.some((p) => p.uuid === shown.uuid)) return `What ${shown.name} carries is unknown: no loaded save has a player file for them.`;
    return carried.length ? '' : `No banknotes or valuables in ${shown.name}'s inventory or ender chest${app.scope.server === null ? '' : ` on ${app.scope.server}`}.`;
  });

  const ownAccounts = $derived(shown?.accounts.filter((a) => a.owner) ?? []);
  const sharedAccounts = $derived(shown?.accounts.filter((a) => !a.owner) ?? []);
</script>

<div class="split">
  <aside aria-label="Player list">
    <div class="listhead">
      <h2>Players</h2>
      <span class="small">most suspicious first</span>
    </div>
    {#if !main}
      <p class="small pad">No save with bank and market data is loaded.</p>
    {:else if list && list.length === 0}
      <p class="small pad">This save lists no players.</p>
    {:else if ordered}
      <div class="roster">
        {#each ordered as p (p.uuid)}
          <a class="row pick" href={'#/players/' + encodeURIComponent(p.uuid)} aria-current={p.uuid === uuid ? 'true' : undefined}>
            <span class="avatar" aria-hidden="true">{initials(p.name)}</span>
            <span class="who">
              <span style="font-weight: 500">{p.name}</span>
              <span class="small ellipsis">{p.orders === 0 ? 'no orders' : p.profit === 0n ? `${count(p.orders)} ${p.orders === 1 ? 'order' : 'orders'}, no profit` : `${signed(p.profit)} trading profit`}</span>
            </span>
            {#if flags.get(p.uuid)}
              {@const x = flags.get(p.uuid)!}
              <span class="count" style="--c: {LEVEL_COLOR[x.level]}" title="{count(x.n)} open {x.n === 1 ? 'finding' : 'findings'}, the highest {x.level}">{count(x.n)}</span>
            {/if}
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

      {#if flagged.length}
        <section class="card" aria-label="What was flagged">
          <div class="cardhead">
            <h2 class="h2 h3" style="flex: 1 1 auto">What was flagged</h2>
            <a class="ref small" href="#/findings" style="font-weight: 500">All findings</a>
          </div>
          <FindingLinks list={flagged} w={{ itemName, isMoney }} empty="" />
        </section>
      {/if}

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
        <button type="button" role="tab" aria-selected={tab === 'notes'} onclick={() => (tab = 'notes')}>Banknotes and items</button>
      </div>

      {#if tab === 'trades'}
        {#if orders.length === 0}
          <p class="empty">No orders in the selected time range.</p>
        {:else}
          <div class="pair">
            <section class="card">
              <h2 class="h2 h3">Profit by market</h2>
              <div class="markets">
                {#each shown.markets as m (m.item)}
                  <div class="market">
                    <span class="who">
                      <a class="ref" href="#/markets/{m.item}" style="font-weight: 500">{itemName(m.item)}</a>
                      <span class="small">{count(m.orders)} {m.orders === 1 ? 'order' : 'orders'}{m.bought ? `, bought for ${moneyShort(m.bought)}` : ''}{m.sold ? `, sold for ${moneyShort(m.sold)}` : ''}{m.soldWithoutPurchase ? `, ${moneyShort(m.soldWithoutPurchase)} of it without a purchase` : ''}</span>
                    </span>
                    <span class="num" style="color: {tone(m.profit)}" title={money(m.profit)}>{signed(m.profit)}</span>
                  </div>
                {/each}
              </div>
            </section>
            <section class="card" aria-label="Trading sessions">
              <div class="cardhead">
                <h2 class="h2 h3" style="flex: 1 1 auto">Trading sessions</h2>
                {#if sessionRows.length > ROWS}<button type="button" class="link" onclick={() => (allSessions = !allSessions)}>{allSessions ? 'Show fewer' : `Show all ${count(sessionRows.length)}`}</button>{/if}
              </div>
              <p class="small" style="margin: 2px 0 0">Orders less than 5 minutes apart, newest first, with the typical time between them.</p>
              {#if sessionRows.length === 0}
                <p style="margin: 12px 0 0; color: var(--text2)">No sessions in this time range.</p>
              {:else}
                <div class="markets">
                  {#each allSessions ? sessionRows : sessionRows.slice(0, ROWS) as s (s.key)}
                    <div class="session">
                      <span class="sdot" style="background: {s.dot}" aria-hidden="true"></span>
                      <span class="who">
                        <span style="font-weight: 500">{s.when} · {#if s.item !== null}<a class="ref" href="#/markets/{s.item}">{s.market}</a>{:else}{s.market}{/if}</span>
                        <span class="small">{s.sub}</span>
                      </span>
                      <span class="num" style="color: {tone(s.profit)}" title={money(s.profit)}>{signed(s.profit)}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </section>
          </div>
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
                      <td><a class="ref" href="#/markets/{o.item}">{itemName(o.item)}</a></td>
                      <td style="font-weight: 500; color: {o.amount > 0n ? 'var(--buy)' : 'var(--sell)'}">{o.amount > 0n ? 'Buy' : 'Sell'}</td>
                      <td class="dim">{kindOf(o)}</td>
                      <td class="r">{filled(o)}{#if o.status && o.status !== 'filled'}<span class="small" style="display: block">{o.status}</span>{/if}</td>
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
      {:else if tab === 'notes'}
        {#if !notes || !world}
          <p class="small" aria-busy="true">Counting the banknotes…</p>
        {:else}
          <div class="pair">
            <section class="card" aria-label="Banknotes">
              <h2 class="h2 h3">Banknotes</h2>
              {#if notes.reason !== null}
                <p style="margin: 12px 0 0; color: var(--text2)">{notes.reason}</p>
              {:else}
                <div class="notes">
                  {#each noteRows as r (r.label)}
                    <div class="nrow" class:total={r.total}><span>{r.label}</span><span class="num" title={money(r.raw)}>{moneyShort(r.raw)}</span></div>
                  {/each}
                </div>
                <p class="small" style="margin: 12px 0 0; text-wrap: pretty">Banknotes carry no owner and change hands, so these figures follow who withdrew and paid in, not who holds the notes now. They are estimates.</p>
              {/if}
            </section>
            <section class="card" aria-label="Found on the player">
              <h2 class="h2 h3">Found on the player</h2>
              {#if carriedNote}<p class="where">{carriedNote}</p>{/if}
              {#if carried.length}
                <div class="notes">
                  {#each carried as c (c.key)}
                    <div class="nrow">
                      <span class="who"><span style="font-weight: 500">{c.label}</span><span class="small">{c.sub}</span></span>
                      <span class="num" title={money(c.raw)}>{c.raw > 0n ? moneyShort(c.raw) : 'no notes'}</span>
                    </div>
                  {/each}
                </div>
              {/if}
              <p class="small" style="margin: 12px 0 0; text-wrap: pretty">From the player files as each copy was taken{world.scan.state === 'complete' || world.scan.state === 'partial' ? ', and the bank terminals the region scan found' : ''}. Valuables are items with a market.</p>
            </section>
          </div>
        {/if}
      {:else}
        {#if main.generation === 'legacy'}
          <p class="small" style="margin: 0">This save was written by BankSystem 2.1.2, which did not log trades or admin actions, so changes without a log entry are expected.</p>
        {/if}
        {#if bankEntries.length === 0}
          <p class="empty">No bank log entries for this player's accounts in the selected time range.</p>
        {:else}
          <section class="card">
            <div class="cardhead">
              <h2 class="h2 h3" style="flex: 1 1 auto">Bank history</h2>
              <span class="small">{bankEntries.length > ROWS && !allBank ? `the latest ${count(ROWS)} of ${count(bankEntries.length)}` : `${count(bankEntries.length)}, newest first`}, all accounts of the player</span>
              {#if bankEntries.length > ROWS}<button type="button" class="link" onclick={() => (allBank = !allBank)}>{allBank ? 'Show fewer' : 'Show all'}</button>{/if}
            </div>
            <div class="history">
              {#each allBank ? bankEntries : bankEntries.slice(0, ROWS) as e (e.gap ? e.gap.id : e.row.id)}
                {#if e.gap}
                  {@const g = e.gap}
                  <div class="entry gap">
                    <span class="etime">{gapWhen(g)}</span>
                    <span class="who" style="flex: 1 1 260px">
                      <span style="font-weight: 500; color: var(--high)">{gapWhat(g)}</span>
                      <span class="small"><a class="ref" href="#/accounts/{g.account}">Account {g.account}</a> · {gapSub(g)}</span>
                    </span>
                    <span class="num" style="color: var(--high)">{change(g.item, g.gap.difference)}</span>
                  </div>
                {:else}
                {@const r = e.row}
                <div class="entry">
                  <span class="etime">{time(r.time)}</span>
                  <span class="who" style="flex: 1 1 260px">
                    <span style="font-weight: 500">{what(r)}</span>
                    <span class="small"><a class="ref" href="#/accounts/{r.account}">Account {r.account}</a>{#if r.otherAccount !== null}{` · ${r.change !== null && r.change < 0n ? 'to' : 'from'} `}<a
                          class="ref" href="#/accounts/{r.otherAccount}">account {r.otherAccount}</a>{/if}{detailOf(r)}</span>
                  </span>
                  <span class="num" style="color: {bankTone(r)}">{bankAmount(r)}</span>
                </div>
                {/if}
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
  .market, .session { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 0 10px; border-radius: 10px; }
  .history { display: flex; flex-direction: column; gap: 4px; margin: 12px -12px 0; }
  .entry { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; padding: 12px; border-radius: 10px; }
  .count { flex: none; min-width: 22px; height: 20px; padding: 0 6px; box-sizing: border-box; border-radius: 10px; font-size: 12px; line-height: 20px; text-align: center; font-weight: 600;
    color: var(--c); background: color-mix(in srgb, var(--c) 16%, transparent); }
  .pair { display: flex; flex-wrap: wrap; gap: 24px; }
  .pair > .card { flex: 1 1 360px; min-width: 0; box-sizing: border-box; }
  .sdot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
  .entry.gap { border: 1px dashed var(--high); background: color-mix(in srgb, var(--high) 10%, transparent); }
  .notes { display: flex; flex-direction: column; margin-top: 12px; }
  .nrow { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-top: 1px solid var(--line); }
  .nrow > span:first-child:not(.who) { color: var(--text2); }
  .nrow.total > span:first-child { color: var(--text); font-weight: 500; }
  .where { margin: 12px 0 0; padding: 12px; border-radius: 10px; font-size: 13px; color: var(--text2); background: var(--raised); text-wrap: pretty; }
  .etime { flex: 0 0 170px; font-size: 13px; color: var(--text2); font-variant-numeric: tabular-nums; }
</style>
