<script module lang="ts">
  // What the screen shows stays when it is left and opened again: the incident or the timeline, players or accounts.
  const ui = $state({ view: 'incident' as 'incident' | 'timeline', byAccount: false });
</script>

<script lang="ts">
  // Money flow: where the money of one incident came from, which player (or account) got it and where it is now.
  // Three columns as on the design canvas; the engine sorts every move into a part (query/flow.ts), this screen groups them.
  // The timeline shows every money move of the bank in the time range instead (FlowTimeline).
  import type { AccountListRow, Finding, FlowPart, FlowTimeline as Timeline, Incident, ItemRow, LedgerRow, MoneyFlow, OrderRow, Scope } from '../../shared/api.ts';
  import { count, items as quantity, money, moneyShort, time } from '../../shared/fmt.ts';
  import { incidentTitle } from '../../shared/incident.ts';
  import CsvButton from '../app/CsvButton.svelte';
  import FindingLinks from '../app/FindingLinks.svelte';
  import FlowTimeline from '../app/FlowTimeline.svelte';
  import { app, engine } from '../app/state.svelte.ts';
  import { words } from '../app/words.ts';

  let { selected }: { selected: string | null } = $props();
  const ALL: Scope = { from: null, to: null, server: null };
  const ROWS = 10, FIRST = 5;

  let list = $state<Incident[] | null>(null);
  let itemRows = $state(new Map<number, ItemRow>());
  let byId = $state(new Map<string, Finding>());
  let player = $state<string | null>(null);
  let flow = $state<MoneyFlow | null>(null);
  let sel = $state<string | null>(null);

  $effect(() => {
    const rules = $state.snapshot(app.rules), server = app.scope.server;
    void app.saves.length;
    let stale = false;
    void Promise.all([engine.incidents({ ...ALL, server }, rules), engine.items(), engine.findings(ALL, rules)]).then(([r, i, f]) => {
      if (stale) return;
      list = r.incidents;
      itemRows = new Map(i.map((x) => [x.id, x]));
      byId = new Map(f.findings.map((x) => [x.id, x]));
    });
    return () => (stale = true);
  });
  const w = $derived(words(itemRows));
  const incidentId = $derived(selected ?? app.incident?.id ?? list?.[0]?.id ?? null);
  $effect(() => {
    void incidentId;
    player = null; // another incident has other players
  });
  $effect(() => {
    const id = incidentId, who = player, split = ui.byAccount, scope = $state.snapshot(app.scope), rules = $state.snapshot(app.rules);
    void app.saves.length;
    if (id === null || ui.view !== 'incident') return;
    let stale = false;
    void engine.moneyFlow(scope, id, who, rules, { split }).then((f) => {
      if (!stale) flow = f;
    });
    return () => (stale = true);
  });
  let tl = $state<Timeline | null>(null), accounts = $state<AccountListRow[]>([]);
  $effect(() => {
    const scope = $state.snapshot(app.scope), rules = $state.snapshot(app.rules);
    void app.saves.length;
    if (ui.view !== 'timeline') return;
    let stale = false;
    void Promise.all([engine.flowTimeline(scope, rules), engine.accounts(scope, rules)]).then(([t, a]) => {
      if (!stale) [tl, accounts] = [t, a];
    });
    return () => (stale = true);
  });

  // ---- The parts as nodes: Came from (in), the players, Is now (out) ----
  const IN: Partial<Record<FlowPart['kind'], string>> = {
    start: 'At the start', received: 'Other accounts', notes: 'Notes paid in', appeared: 'Likely notes paid in', added: 'Added, no log row',
    admin: 'Added by an admin', other: 'Other entries', 'other-server': 'Other servers', unexplained: 'Not explained',
  };
  const OUT: Partial<Record<FlowPart['kind'], string>> = {
    now: 'Still in the bank', sent: 'Sent to other accounts', notes: 'Taken out as notes', items: 'Spent on items', lost: 'Lost trading',
    removed: 'Already removed', admin: 'Removed by an admin', other: 'Other entries', 'other-server': 'Other servers', unexplained: 'Not explained',
  };
  interface Node { id: string; col: 0 | 1 | 2; name: string; parts: FlowPart[]; v: bigint; y: number; h: number; out: number; inn: number }

  const nameOf = $derived(new Map((flow?.players ?? []).map((p) => [p.uuid, p.name])));
  const parts = $derived(flow?.parts ?? []);
  const total = $derived(parts.filter((p) => p.side === 'in').reduce((s, p) => s + p.amount, 0n));
  /** The incident market with the largest gain: always on its own, so the answer sentence's market is on the chart. */
  const top = $derived(parts.filter((p) => p.kind === 'market' && p.incident).sort((a, b) => Number(b.amount - a.amount))[0]?.market ?? null);
  /** Which node of its column a part belongs to. Incident markets of at least 1% stand alone; every other market is grouped. */
  function nodeOf(p: FlowPart): [string, string] {
    if (p.side === 'out') return [`out:${p.kind}`, OUT[p.kind]!];
    if (p.kind !== 'market') return [`in:${p.kind}`, IN[p.kind]!];
    const own = parts.filter((x) => x.kind === 'market' && x.market === p.market).reduce((s, x) => s + x.amount, 0n);
    return p.incident && (own * 100n >= total || p.market === top) ? [`in:market:${p.market}`, `${w.itemName(p.market!)} market`] : ['in:markets', 'Other markets'];
  }

  // Pixel geometry from the chart's width: fixed gutters for the labels left and right, so no name is cut at 900 px.
  // The players' labels sit above their bar, centred, so a 16-letter name fits between the two outer columns.
  const H0 = 440, GAP = 16, SLOT = 44, LEFT = 160, RIGHT = 200, LABEL = 42;
  let cw = $state(1000);
  const W = $derived(Math.max(cw, 520));
  const MID = $derived(Math.round((LEFT + W - RIGHT) / 2));
  const XS = $derived([[LEFT, LEFT + 12], [MID - 6, MID + 6], [W - RIGHT - 12, W - RIGHT]] as const);
  const sk = $derived.by(() => {
    const nodes = new Map<string, Node>();
    const node = (id: string, col: 0 | 1 | 2, name: string) => nodes.get(id) ?? nodes.set(id, { id, col, name, parts: [], v: 0n, y: 0, h: 0, out: 0, inn: 0 }).get(id)!;
    const links = new Map<string, { a: Node; b: Node; v: bigint }>();
    for (const p of parts) {
      const [id, name] = nodeOf(p);
      const side = node(id, p.side === 'in' ? 0 : 2, name), owner = nameOf.get(p.player) ?? 'A player';
      const who = ui.byAccount ? node(`a:${p.accounts[0]}`, 1, `Account ${p.accounts[0]} · ${owner}`) : node(`p:${p.player}`, 1, owner);
      side.parts.push(p);
      side.v += p.amount;
      if (p.side === 'in') who.v += p.amount;
      who.parts.push(p);
      const [a, b] = p.side === 'in' ? [side, who] : [who, side];
      const k = a.id + '>' + b.id;
      (links.get(k) ?? links.set(k, { a, b, v: 0n }).get(k)!).v += p.amount;
    }
    // The start first on the left and the bank first on the right, so the eye finds them; the rest largest first.
    const first = (n: Node) => (n.id === 'in:start' || n.id === 'out:now' ? 1 : 0);
    const cols = [0, 1, 2].map((c) => [...nodes.values()].filter((n) => n.col === c).sort((a, b) => first(b) - first(a) || Number(b.v - a.v)));
    const sum = Number(total) || 1;
    const most = Math.max(1, ...cols.map((c) => c.length));
    const K = (H0 - GAP * (most - 1) - 3 * most) / sum;
    // A player's label sits above the player's bar, so the middle column keeps room for it.
    const lab = (c: number) => (c === 1 ? LABEL : 0);
    const need = cols.map((c, i) => c.reduce((s, n) => s + lab(i) + Math.max(SLOT, 3 + Number(n.v) * K + GAP), -GAP));
    const H = Math.max(H0, ...need);
    cols.forEach((c, i) => {
      let y = (H - need[i]!) / 2;
      for (const n of c) {
        n.h = 3 + Number(n.v) * K;
        const slot = Math.max(SLOT, n.h + GAP);
        n.y = y + lab(i) + (slot - GAP - n.h) / 2;
        n.out = n.inn = n.y;
        y += lab(i) + slot;
      }
    });
    const f = (v: number) => v.toFixed(1);
    const band = (l: { a: Node; b: Node; v: bigint }) => {
      const share = (n: Node) => (n.v === 0n ? 0 : (n.h * Number(l.v)) / Number(n.v));
      const ha = share(l.a), hb = share(l.b);
      const x0 = XS[l.a.col][1], x1 = XS[l.b.col][0], xm = (x0 + x1) / 2, a0 = l.a.out, b0 = l.b.inn;
      l.a.out += ha;
      l.b.inn += hb;
      return `M${x0} ${f(a0)}C${xm} ${f(a0)} ${xm} ${f(b0)} ${x1} ${f(b0)}V${f(b0 + hb)}C${xm} ${f(b0 + hb)} ${xm} ${f(a0 + ha)} ${x0} ${f(a0 + ha)}Z`;
    };
    const order = [...links.values()].sort((x, y) => x.a.y - y.a.y || x.b.y - y.b.y);
    const paths = order.map((l) => ({ a: l.a.id, b: l.b.id, d: band(l) }));
    return { nodes: [...cols[0]!, ...cols[1]!, ...cols[2]!], paths, H };
  });
  const bar = (n: Node) => `M${XS[n.col][0]} ${n.y.toFixed(1)}h12v${n.h.toFixed(1)}h-12Z`;
  const pick = $derived(sk.nodes.find((n) => n.id === sel) ?? sk.nodes.find((n) => n.id === 'out:notes') ?? sk.nodes.find((n) => n.col === 2) ?? null);
  const estimate = (n: Node) => n.parts.every((p) => p.basis === 'estimate');
  // A player name longer than 16 letters is cut (the full name is in the title).
  const POS = $derived([`right: ${W - XS[0][0] + 4}px; text-align: right; align-items: flex-end`, `left: ${MID}px; transform: translate(-50%, -100%); text-align: center; align-items: center; max-width: 172px`, `left: ${XS[2][1] + 4}px`]);
  const labelY = (n: Node) => (n.col === 1 ? n.y - 2 : n.y + n.h / 2);

  // ---- The answer first ----
  const sum = (kind: FlowPart['kind'], side: 'in' | 'out') => parts.filter((p) => p.kind === kind && p.side === side).reduce((s, p) => s + p.amount, 0n);
  const PHRASE: [FlowPart['kind'], string][] = [
    ['now', 'is still in the bank'], ['notes', 'was taken out as banknotes'], ['items', 'was spent on items'], ['removed', 'was already removed'],
    ['sent', 'was sent to other accounts'], ['lost', 'was lost trading'], ['admin', 'was removed by an admin'], ['unexplained', 'is not explained'],
  ];
  const lead = $derived.by(() => {
    if (!flow?.incident) return '';
    const made = parts.filter((p) => p.kind === 'market' && p.incident).reduce((s, p) => s + p.amount, 0n);
    const markets = [...new Set(parts.filter((p) => p.kind === 'market' && p.incident).map((p) => p.market!))];
    const more = markets.length - 1;
    const where = top === null ? 'the markets of the incident' : `the ${w.itemName(top).toLowerCase()} market${more ? ` and ${count(more)} other market${more > 1 ? 's' : ''} of the incident` : ''}`;
    const now = PHRASE.map(([k, t]) => [sum(k, 'out'), t] as const).filter(([v]) => v * 100n >= total && v > 0n).sort((a, b) => Number(b[0] - a[0])).slice(0, 4);
    const list = now.map(([v, t]) => `${moneyShort(v)} ${t}`);
    const tail = list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;
    // The base is the whole left column (start and every inflow), since the parts after it are shares of that.
    const who = flow.player !== null ? nameOf.get(flow.player) : flow.players.length === 1 ? 'this player' : 'these players';
    return `Of the ${moneyShort(total)} ${who} had or got since the incident's start${made > 0n ? ` (${moneyShort(made)} of it made on ${where})` : ''}, ${tail}.`;
  });

  // ---- The picked node in words ----
  const acct = (p: FlowPart) => p.accounts.map((a) => `account ${a}`).join(', ');
  const TEXT: Record<string, string> = {
    'in:start': 'What the accounts held at the incident\'s start: the newest balance snapshot at or before it, or the first one after it when there is none.',
    'in:received': 'Money other accounts transferred to these accounts, from the bank\'s log.',
    'in:notes': 'More notes were paid in than taken out in this time. Notes carry no owner, so they may come from another player.',
    'in:appeared': 'Money that appeared between two balance snapshots without a log row, each time no more than the notes then outside the bank. BankSystem 2.1.2 did not log notes paid in through the ATM converter, so that is the likely cause.',
    'in:added': 'Money that appeared between two balance snapshots without a log row, more than all notes outside the bank then: an admin action or another cause.',
    'in:admin': 'Money an admin added, from the bank\'s log.',
    'in:other': 'Other log entries that added money: payouts, dividends, changes from an unknown source.',
    'in:other-server': 'Trading on the servers the server filter leaves out, netted.',
    'in:unexplained': 'What the balance gained beyond every log entry and order. It includes amounts below the threshold of the finding, and entries whose direction the save does not give.',
    'in:markets': 'Profit on the other markets, grouped.',
    'out:now': 'Still on the accounts, read from the bank\'s files when the copy was taken. This part can be taken back directly.',
    'out:sent': 'Transferred to other accounts, from the bank\'s log.',
    'out:notes': 'Taken out as banknotes and not paid back in. Notes carry no owner: where they are now is worked out from the player files and the region scan.',
    'out:items': 'Bought on markets that lost money and still held at the end: what the goods cost at the player\'s average buying price. Every purchase is a market order.',
    'out:lost': 'Lost on markets where the player bought and sold back for less.',
    'out:removed': 'Left the account between two balance snapshots without a log row. BankSystem 2.1.2 logged no admin action, so an admin most likely removed it. Confirm that first, or the same money is taken twice.',
    'out:admin': 'Money an admin removed, from the bank\'s log.',
    'out:other': 'Other log entries that took money: payouts, closed accounts, changes from an unknown source.',
    'out:other-server': 'Trading on the servers the server filter leaves out, netted.',
    'out:unexplained': 'What the balance lost beyond every log entry and order. It includes amounts below the threshold of the finding.',
  };
  const textOf = (n: Node) => (n.col === 1 ? `Where the money ${n.id.startsWith('a:') ? `on account ${n.id.slice(2)} of ${nameOf.get(n.parts[0]!.player)}` : `of ${n.name}`} came from and where it is now.` : n.id.startsWith('in:market:') ? `What ${n.parts.length === 1 ? nameOf.get(n.parts[0]!.player) : 'the players'} made on this market from the incident's start to the copy: sales minus purchases, from the orders.` : TEXT[n.id] ?? '');
  interface Row { label: string; sub: string; amount: bigint | null; basis: 'proven' | 'estimate'; href?: string }
  function rowsOf(n: Node): Row[] {
    if (n.col === 1) {
      return sk.nodes.filter((x) => x.col !== 1).flatMap((x) => {
        const v = x.parts.filter((p) => n.parts.includes(p)).reduce((s, p) => s + p.amount, 0n);
        return v ? [{ label: (x.col === 0 ? 'From: ' : 'To: ') + x.name, sub: '', amount: v, basis: x.parts.every((p) => p.basis === 'estimate') ? 'estimate' as const : 'proven' as const }] : [];
      });
    }
    const one = new Set(n.parts.map((p) => p.player)).size === 1;
    const who = (p: FlowPart) => (one ? acct(p) : `${nameOf.get(p.player)}, ${acct(p)}`);
    // A row names what is not in the node's name already: the market, the other account, else the player.
    const market = (p: FlowPart) => p.market !== null && !n.id.startsWith('in:market:');
    const rows: Row[] = [...n.parts].sort((a, b) => Number(b.amount - a.amount)).map((p) => ({
      label: market(p) ? w.itemName(p.market!) : p.other !== null ? `Account ${p.other}` : nameOf.get(p.player) ?? '',
      sub: [p.items ? `${quantity(p.items.qty)} still held` : p.notes ? `${money(p.notes.out)} taken out, ${money(p.notes.back)} paid back in` : '', market(p) || p.other !== null ? who(p) : acct(p)].filter(Boolean).join(' · '),
      amount: p.amount, basis: p.basis, href: market(p) ? `#/markets/${p.market}` : p.other !== null ? `#/accounts/${p.other}` : `#/accounts/${p.accounts[0]}`,
    }));
    const top = rows.length > FIRST + 1 ? [...rows.slice(0, FIRST), { label: `${count(rows.length - FIRST)} more`, sub: '', amount: rows.slice(FIRST).reduce((s, r) => s + r.amount!, 0n), basis: rows.slice(FIRST).every((r) => r.basis === 'estimate') ? 'estimate' as const : 'proven' as const }] : rows;
    return top;
  }
  /** The rows under their headings. Each group adds up to the node, except "worth about", which is another measure. */
  function groupsOf(n: Node): { head: string; rows: Row[] }[] {
    if (n.id === 'out:items') {
      const worth = n.parts.map((p) => p.items?.worth ?? null);
      return [{ head: 'Made of', rows: rowsOf(n) }, { head: 'What the goods are worth', rows: [{ label: 'Worth about, at the usual price', sub: worth.includes(null) ? 'some markets have no usual price' : "at each market's usual price before the incident", amount: worth.includes(null) ? null : worth.reduce((s, v) => s! + v!, 0n), basis: 'estimate' }] }];
    }
    if (n.id !== 'out:notes' || !flow) return [{ head: 'Made of', rows: rowsOf(n) }];
    const m = flow.notes, where: Row[] = [], others = m.others.reduce((s, o) => s + o.amount, 0n);
    if (n.v > m.outside + others) where.push({ label: 'Paid in again', sub: `by ${flow.player === null ? 'these players' : 'this player'}: “Notes paid in” and “Likely notes paid in” on the left`, amount: n.v - m.outside - others, basis: 'estimate' });
    for (const o of m.others) where.push({ label: `Likely paid in by ${o.player.name}`, sub: 'the same amount, paid in within a day after it was taken out', amount: o.amount, basis: 'estimate', href: `#/players/${encodeURIComponent(o.player.uuid)}` });
    where.push({ label: 'In their own files', sub: 'inventory and ender chest', amount: m.inFiles, basis: 'estimate' });
    if (m.elsewhere === null || m.notFound === null) {
      where.push({ label: 'Not in their own files', sub: 'pick All players to see where the rest may be: notes found elsewhere are one pool for all of them', amount: m.outside - m.inFiles, basis: 'estimate' });
    } else {
      where.push({ label: 'Found elsewhere, owner unknown', sub: 'other players\' files and the region scan', amount: m.elsewhere, basis: 'estimate' },
        { label: 'Not found', sub: 'not in any file or block the tool read', amount: m.notFound, basis: 'estimate' });
    }
    return [{ head: 'Who took them out', rows: rowsOf(n) }, { head: 'Where they are now', rows: where }];
  }
  const findingsOf = (n: Node) => [...new Set(n.parts.flatMap((p) => p.records.findings))].flatMap((id) => byId.get(id) ?? []);
  const linkOf = (n: Node): [string, string] | null => {
    if (n.id.startsWith('a:')) return [`Open account ${n.id.slice(2)}`, `#/accounts/${n.id.slice(2)}`];
    if (n.col === 1) return [`Open ${n.name}`, `#/players/${encodeURIComponent(n.parts[0]!.player)}`];
    if (n.id.startsWith('in:market:')) return [`Open the ${w.itemName(n.parts[0]!.market!).toLowerCase()} market`, `#/markets/${n.parts[0]!.market}`];
    const accounts = [...new Set(n.parts.flatMap((p) => p.accounts))];
    return accounts.length === 1 ? [`Open account ${accounts[0]}`, `#/accounts/${accounts[0]}`] : null;
  };

  // ---- The records behind the picked node ----
  let records = $state<{ for: string; orders: OrderRow[]; ledger: LedgerRow[] } | null>(null);
  let showRecords = $state(false), allRows = $state(false);
  $effect(() => {
    void sel;
    showRecords = allRows = false;
  });
  $effect(() => {
    const n = pick;
    if (!n || !showRecords) return;
    const ledger = n.parts.flatMap((p) => p.records.ledger), orders = n.parts.flatMap((p) => p.records.orders);
    let stale = false;
    void Promise.all([orders.length ? engine.orders({ ids: orders }, ALL) : [], ledger.length ? engine.ledger({ ids: ledger }, ALL) : []]).then(([o, l]) => {
      if (!stale) records = { for: n.id, orders: o, ledger: l };
    });
    return () => (stale = true);
  });
  const rec = $derived(records && pick && records.for === pick.id ? records : null);
  const cut = <T,>(l: T[]) => (allRows ? l : l.slice(0, ROWS));
  const recordCount = (n: Node) => n.parts.reduce((s, p) => s + p.records.ledger.length + p.records.orders.length, 0);
  const late = $derived(flow?.incident ? flow.accounts.filter((a) => a.from !== null && a.from > flow!.incident!.start) : []);

  // ---- CSV (AT-44): every part of the flow for the players chosen, with the records behind it ----
  const partTable = () => ({
    columns: [['Column', 'text'], ['Part', 'text'], ['Kind', 'text'], ['Player', 'text'], ['Player uuid', 'id'], ['Accounts', 'id'], ['Market', 'text'], ['Item id', 'id'],
      ['Other account', 'id'], ['Amount ($)', 'money'], ['Basis', 'text'], ['On an incident market', 'text'], ['Items still held', 'quantity'], ['Worth at the usual price ($)', 'money'],
      ['Notes taken out ($)', 'money'], ['Notes paid back in ($)', 'money'], ['Gap from', 'time'], ['Gap to', 'time'], ['Entry ids', 'id'], ['Order ids', 'id'], ['Finding ids', 'id']] as const,
    rows: parts.map((p) => [p.side === 'in' ? 'Came from' : 'Is now', nodeOf(p)[1], p.kind, nameOf.get(p.player), p.player, p.accounts.join(' '), p.market === null ? null : w.itemName(p.market),
      p.market, p.other, p.amount, p.basis, p.market === null ? null : p.incident, p.items?.qty, p.items?.worth, p.notes?.out, p.notes?.back, p.gap?.from, p.gap?.to,
      p.records.ledger.join(' '), p.records.orders.join(' '), p.records.findings.join(' ')]),
  });
</script>

<div class="top">
  <div style="flex: 1 1 320px; min-width: 0">
    <h1 class="h1">Money flow</h1>
    <p class="sub">{ui.view === 'incident' ? 'Where the money of an incident came from, who got it and where it is now.' : 'Every move of money over time: between accounts, the markets and the world.'}</p>
  </div>
  <div role="group" aria-label="View" class="seg">
    <button type="button" aria-pressed={ui.view === 'incident'} onclick={() => (ui.view = 'incident')}>Incident</button>
    <button type="button" aria-pressed={ui.view === 'timeline'} onclick={() => (ui.view = 'timeline')}>Timeline</button>
  </div>
  <div role="group" aria-label="Show" class="seg">
    <button type="button" aria-pressed={!ui.byAccount} onclick={() => (ui.byAccount = false)}>Players</button>
    <button type="button" aria-pressed={ui.byAccount} onclick={() => (ui.byAccount = true)}>Bank accounts</button>
  </div>
  {#if ui.view === 'incident' && flow && flow.players.length > 1}
    <div role="group" aria-label="Whose money to follow" class="seg">
      <button type="button" aria-pressed={player === null} onclick={() => (player = null)}>{flow.players.length === 2 ? 'Both players' : 'All players'}</button>
      {#each flow.players as p (p.uuid)}<button type="button" aria-pressed={player === p.uuid} onclick={() => (player = p.uuid)}>{p.name}</button>{/each}
    </div>
  {/if}
</div>

{#if ui.view === 'timeline'}
  {#if tl === null}
    <p class="small" aria-busy="true" style="margin: 0">Following the money…</p>
  {:else if tl.reason !== null}
    <p class="empty">{tl.reason}</p>
  {:else}
    <FlowTimeline {tl} {accounts} byAccount={ui.byAccount} {w} />
  {/if}
{:else if list === null}
  <p class="small" aria-busy="true" style="margin: 0">Loading the incidents…</p>
{:else if list.length === 0}
  <p class="empty">No incident with these rule settings, so there is no money to follow. Findings that belong together form an incident.</p>
{:else}
  {#if list.length > 1}
    <label class="choose"><span class="small">Incident</span>
      <select value={incidentId} onchange={(e) => (location.hash = '#/flow/' + encodeURIComponent(e.currentTarget.value))}>
        {#each list as i (i.id)}<option value={i.id}>{incidentTitle(i, w.itemName)}, {time(i.start)}</option>{/each}
      </select>
    </label>
  {/if}
  {#if !flow || (flow.incident && flow.incident.id !== incidentId)}
    <p class="small" aria-busy="true" style="margin: 0">Following the money…</p>
  {:else if flow.reason !== null}
    <p class="empty">{flow.reason}</p>
  {:else}
    <p class="lead">{lead}</p>

    <section class="card">
      <div class="wrap" bind:clientWidth={cw}>
        <div aria-hidden="true" class="heads" style="width: {W}px">
          <span style={POS[0]}>Came from</span><span style="left: {MID}px; transform: translateX(-50%)">Went to</span><span style={POS[2]}>Is now</span>
        </div>
        <div class="chart" style="height: {sk.H}px; width: {W}px">
          <svg viewBox="0 0 {W} {sk.H}" aria-hidden="true">
            {#each sk.paths as p (p.a + p.b)}<path d={p.d} class="band" class:hot={pick && (p.a === pick.id || p.b === pick.id)} />{/each}
            {#each sk.nodes as n (n.id)}<path d={bar(n)} class="bar" class:hot={pick?.id === n.id} />{/each}
          </svg>
          {#each sk.nodes as n (n.id)}
            <button type="button" class="node" aria-pressed={pick?.id === n.id} onclick={() => (sel = n.id)} style="top: {labelY(n).toFixed(1)}px; {POS[n.col]}">
              <span class="nname" title={n.name}>{n.name}</span>
              <span class="namount">{estimate(n) ? 'about ' : ''}{moneyShort(n.v)}</span>
            </button>
          {/each}
        </div>
      </div>
      <div class="under">
        <p class="small" style="flex: 1 1 auto; margin: 0">Band height shows the amount. Select a name to see what it is made of.</p>
        <CsvButton screen="flow" table="parts" what="every part of the money flow" make={partTable} />
      </div>
    </section>

    {#if pick}
      {@const link = linkOf(pick)}
      {@const found = findingsOf(pick)}
      <section class="card detail">
        <div class="dleft">
          <div>
            <h2 class="dtitle">{pick.name}</h2>
            <p class="damount">{estimate(pick) ? 'about ' : ''}{money(pick.v)}</p>
          </div>
          <p class="dtext">{textOf(pick)}</p>
          {#if link}<a class="btn" href={link[1]} style="font-weight: 500; border-color: var(--line2)">{link[0]}<svg width="16" height="16" viewBox="0 0 24 24" class="icon" aria-hidden="true" style="stroke-width: 2"><path d="M5 12h14M13 6l6 6-6 6" /></svg></a>{/if}
          {#if found.length}
            <div style="align-self: stretch">
              <h3 class="label" style="margin-top: 8px">Findings about it</h3>
              <FindingLinks list={found} {w} empty="" />
            </div>
          {/if}
        </div>
        <div class="dright">
          {#each groupsOf(pick) as g, j (j)}
            <h3 class="label" style:margin-top={j ? '20px' : null}>{g.head}</h3>
            {#each g.rows as r, i (i)}
              <div class="mrow">
                <span class="mlabel"><span class="mname">{#if r.href}<a href={r.href}>{r.label}</a>{:else}{r.label}{/if}</span>{#if r.sub}<span class="small">{r.sub}</span>{/if}</span>
                <span class="num">{r.amount === null ? 'unknown' : money(r.amount)}</span>
                <span class="badge" class:est={r.basis === 'estimate'}>{r.basis === 'estimate' ? 'Estimate' : 'Proven'}</span>
              </div>
            {/each}
          {/each}
          <p class="small" style="margin: 12px 0 0">Proven means read straight from the saves. Estimate means worked out from snapshots or by matching amounts.</p>
          {#if recordCount(pick)}
            <button type="button" class="link" style="margin-top: 12px" onclick={() => (showRecords = !showRecords)}>{showRecords ? 'Hide the records' : `Show the ${count(recordCount(pick))} records`}</button>
          {/if}
        </div>
      </section>

      {#if showRecords}
        <section class="card">
          <h3 class="label">The records behind “{pick.name}”</h3>
          {#if !rec}
            <p class="small" aria-busy="true" style="margin: 0">Loading the records…</p>
          {:else}
            <div class="reccsv">
              {#if rec.orders.length}<CsvButton screen="flow" table="orders" what="the orders behind this part" text="Orders as CSV" make={() => w.orderTable(rec.orders, (u) => nameOf.get(u) ?? '')} />{/if}
              {#if rec.ledger.length}<CsvButton screen="flow" table="entries" what="the log entries behind this part" text="Log entries as CSV" make={() => w.ledgerTable(rec.ledger.map((row) => ({ time: row.time, row })), app.saves.find((s) => s.role !== 'SLAVE')?.name)} />{/if}
            </div>
            <div class="scroll">
              {#if rec.orders.length}
                <table>
                  <thead><tr><th>Order</th><th>Time</th><th>Market</th><th>Side</th><th class="r">Quantity</th><th class="r">Price</th><th class="r">Money</th></tr></thead>
                  <tbody>
                    {#each cut(rec.orders) as o (o.id)}
                      <tr><td>{o.orderId ?? o.id}</td><td class="mono">{time(o.time)}</td><td>{w.itemName(o.item)}</td>
                        <td style="color: {o.amount > 0n ? 'var(--buy)' : 'var(--sell)'}">{o.amount > 0n ? 'Buy' : 'Sell'}</td><td class="r">{quantity(o.amount < 0n ? -o.amount : o.amount)}</td><td class="r">{money(o.price)}</td><td class="r">{money(-o.money)}</td></tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
              {#if rec.ledger.length}
                <table>
                  <thead><tr><th>Time</th><th>Account</th><th>Entry</th><th class="r">Amount</th></tr></thead>
                  <tbody>
                    {#each cut(rec.ledger) as r (r.id)}
                      <tr><td class="mono">{time(r.time)}</td><td><a class="ref" href="#/accounts/{r.account}">{r.account}</a></td><td>{w.what(r)}</td><td class="r">{w.amount(r)}</td></tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
            </div>
            {#if Math.max(rec.orders.length, rec.ledger.length) > ROWS}
              <button type="button" class="link" style="margin-top: 12px" onclick={() => (allRows = !allRows)}>{allRows ? 'Show fewer' : `Show all ${count(rec.orders.length + rec.ledger.length)}`}</button>
            {/if}
          {/if}
        </section>
      {/if}
    {/if}

    <div class="notes">
      <p class="small">From the incident's start, {time(flow.incident!.start)}, to {flow.to === null ? 'when the copy was taken' : `the copy, ${time(flow.to)}`}. The time range of the top bar does not apply here.</p>
      {#each late as a (a.account)}<p class="small">Account {a.account} has no balance snapshot before the incident, so its flow starts at its first one, {time(a.from!)}.</p>{/each}
      {#each flow.missing as m}<p class="small">{m}</p>{/each}
    </div>
  {/if}
{/if}

<style>
  .top { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 16px; }
  .under { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-top: 12px; }
  .seg { display: flex; flex-wrap: wrap; gap: 4px; padding: 4px; border-radius: 10px; background: var(--card); border: 1px solid var(--line); }
  .seg button { height: 32px; padding: 0 14px; border: 0; border-radius: 7px; font-weight: 500; background: transparent; color: var(--text2); }
  .seg button[aria-pressed='true'] { background: var(--raised); color: var(--text); }
  .choose { display: flex; align-items: center; gap: 12px; max-width: 720px; }
  select { flex: 1 1 auto; min-width: 0; height: 40px; padding: 0 10px; border-radius: 10px; border: 1px solid var(--line2); background: var(--card); color: var(--text); font: inherit; }
  .empty { margin: 0; padding: 24px; border-radius: 14px; border: 1px dashed var(--line2); color: var(--text2); }
  .lead { margin: 0; max-width: 820px; font-size: 16px; line-height: 24px; text-wrap: pretty; }
  .heads { position: relative; height: 16px; font-size: 12px; line-height: 16px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text3); }
  .heads span { position: absolute; }
  .wrap { overflow: auto hidden; }
  .chart { position: relative; margin: 32px 0 20px; }
  .chart svg { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
  .band { fill: var(--accent); fill-opacity: 0.16; }
  .band.hot { fill-opacity: 0.4; }
  .bar { fill: var(--text3); }
  .bar.hot { fill: var(--accent); }
  .node { position: absolute; transform: translateY(-50%); display: flex; flex-direction: column; padding: 0 6px; border: 0; border-radius: 8px; background: var(--card); line-height: 18px; color: var(--text); }
  .node[aria-pressed='true'], .node[aria-pressed='true'] .namount { color: var(--accent); }
  .nname { max-width: 100%; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .namount { font-size: 13px; font-variant-numeric: tabular-nums; color: var(--text2); white-space: nowrap; }
  .detail { display: flex; flex-wrap: wrap; gap: 24px 40px; padding: 28px; }
  .dleft { flex: 1 1 320px; min-width: 0; display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
  .dright { flex: 1.3 1 380px; min-width: 0; }
  .dtitle { margin: 0; font-family: var(--font-head); font-size: 22px; line-height: 30px; font-weight: 600; }
  .damount { margin: 0; font-family: var(--font-head); font-size: 28px; line-height: 36px; font-weight: 600; color: var(--accent); font-variant-numeric: tabular-nums; }
  .dtext { margin: 0; font-size: 15px; line-height: 24px; color: var(--text2); text-wrap: pretty; }
  .label { margin: 0 0 4px; font-size: 12px; line-height: 16px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text3); }
  .mrow { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--line); }
  .mlabel { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; font-weight: 500; }
  .mlabel .small { font-weight: 400; text-wrap: pretty; }
  .num { flex: none; font-weight: 500; font-variant-numeric: tabular-nums; }
  .badge { flex: none; height: 24px; padding: 0 8px; box-sizing: border-box; border-radius: 6px; font-size: 12px; line-height: 22px; font-weight: 500; color: var(--text2); border: 1px solid var(--line2); }
  .badge.est { color: var(--high); border: 1px dashed var(--high); }
  .link { padding: 0; border: 0; background: none; font-size: 13px; font-weight: 500; color: var(--accent); }
  .ref { color: var(--accent); }
  .scroll { overflow-x: auto; display: flex; flex-direction: column; gap: 16px; margin-top: 8px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th { padding: 0 16px 8px 0; font-size: 12px; font-weight: 600; color: var(--text3); text-align: left; }
  td { padding: 10px 16px 10px 0; border-top: 1px solid var(--line); white-space: nowrap; }
  .r { text-align: right; }
  .mono { font-family: var(--font-mono); font-size: 13px; }
  .notes { display: flex; flex-direction: column; gap: 4px; }
  .notes p { margin: 0; max-width: 820px; text-wrap: pretty; }
</style>
