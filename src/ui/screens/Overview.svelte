<script lang="ts">
  // Overview: is something wrong, and where do I start? The quick blocks show at once; the summary
  // and the findings figure wait for the first run of the rules.
  import type { Finding, ItemRow, KeyEvent, Level, Overview } from '../../shared/api.ts';
  import { count, money, moneyShort, time } from '../../shared/fmt.ts';
  import { describe, KIND, times } from '../../shared/finding.ts';
  import { incidentSentence, incidentTitle } from '../../shared/incident.ts';
  import Icon from '../app/Icon.svelte';
  import MoneyChart from '../app/MoneyChart.svelte';
  import { ICON } from '../app/nav.ts';
  import { app, engine, newest, setRange } from '../app/state.svelte.ts';
  import { tone, words } from '../app/words.ts';

  let data = $state<Overview | null>(null);
  let itemRows = $state(new Map<number, ItemRow>());
  let found = $state<Finding[] | null>(null);
  let events = $state<KeyEvent[] | null>(null);
  let wealthOn = $state(true);
  let picked = $state<number | null>(null);
  let view = $state<{ from: number; to: number } | null>(null);

  const used = (id: string) => app.saves.find((s) => s.sources.some((x) => x.id === id && (x.status === 'read' || x.status === 'damaged')));
  // The save with the bank and market data, as the engine picks it.
  const main = $derived(app.saves.find((s) => s.sources.some((x) => (x.id === 'bank' || x.id === 'market') && x.status !== 'none' && x.status !== 'missing')));
  const hasMarket = $derived(used('market') !== undefined);
  const w = $derived(words(itemRows));

  $effect(() => {
    const scope = $state.snapshot(app.scope);
    void app.saves.length;
    let stale = false;
    void Promise.all([engine.overview(scope), engine.items()]).then(([o, i]) => {
      if (stale) return;
      [data, itemRows] = [o, new Map(i.map((x) => [x.id, x]))];
    });
    return () => (stale = true);
  });
  // Asked after the quick ones above: the engine answers in order, and the first run of the rules takes seconds.
  $effect(() => {
    const scope = $state.snapshot(app.scope), rules = $state.snapshot(app.rules);
    void app.marks;
    void app.saves.length;
    let stale = false;
    void Promise.all([engine.findings(scope, rules), engine.keyEvents(scope, rules)]).then(([f, k]) => {
      if (stale) return;
      [found, events] = [f.findings, k];
      if (picked !== null && picked > k.length) picked = null;
    });
    return () => (stale = true);
  });

  const day = (ms: number) => time(ms).split(',')[0]!;
  const short = (ms: number) => time(ms).slice(0, -3).replace(/ \d{4},/, ',');
  const signed = (raw: bigint) => (raw > 0n ? '+' : '') + moneyShort(raw);

  const servers = $derived.by(() => {
    const n = (role: string) => app.saves.filter((s) => s.role === role).length;
    const [m, s, a] = [n('MASTER'), n('SLAVE'), n('STANDALONE')];
    return [m && `${count(m)} master`, s && `${count(s)} slave`, a && `${count(a)} standalone`].filter(Boolean).join(' and ') + (m + s + a === 1 ? ' server' : ' servers');
  });

  const open = $derived(found?.filter((f) => !app.marks[f.id]?.dismissed) ?? null);
  const LEVELS: Level[] = ['critical', 'high', 'medium', 'low'];
  const byLevel = $derived(open ? LEVELS.map((l) => [l, open.filter((f) => f.level === l).length] as const).filter(([, n]) => n > 0) : []);
  const flagged = $derived(new Set(open?.flatMap((f) => f.players.map((p) => p.uuid)) ?? []));

  // What "Nothing unusual was found" checked: the rules that ran, the saves, and the span of their data.
  const checked = $derived.by(() => {
    const rules = Object.values(app.rules).filter((r) => r.on).length;
    const starts = app.saves.flatMap((s) => s.sources.flatMap((x) => x.tables.flatMap((t) => (t.from === null ? [] : [t.from]))));
    const end = newest();
    const span = starts.length && end !== null ? `, from ${day(Math.min(...starts))} to ${day(end)}` : '';
    return `${count(rules)} ${rules === 1 ? 'rule' : 'rules'} checked ${count(app.saves.length)} ${app.saves.length === 1 ? 'save' : 'saves'}${span}.`;
  });

  const figures = $derived.by(() => {
    if (!data || !main) return null;
    const first = data.money[0], last = data.money.at(-1);
    return {
      now: { value: moneyShort(data.moneyNow), title: money(data.moneyNow), sub: first ? `was ${moneyShort(first[1])} on ${day(first[0])}` : 'no balance snapshots in this time range' },
      change: first && last ? { value: signed(last[1] - first[1]), color: tone(last[1] - first[1]), sub: first[0] === last[0] ? `on ${day(first[0])}` : `from ${day(first[0])} to ${day(last[0])}` }
        : { value: 'no data', color: 'var(--text3)', sub: 'no balance snapshots in this time range' },
    };
  });

  // name: the quoted name in the mod's subject, player "Brindle" or slave "mining-1".
  const ADMIN_CHANGE: Record<string, (name: string) => string> = {
    RIGHTS_OP: (n) => `${n} made an admin`, RIGHTS_DEOP: (n) => `${n} no longer an admin`,
    SLAVE_TRUST: (n) => `Slave server ${n} trusted`, SLAVE_UNTRUST: (n) => `Slave server ${n} no longer trusted`,
  };
  /** The events in words, numbered from left to right; link: where to read more. */
  const listed = $derived((events ?? []).map((e, i) => {
    const n = i + 1, when = short(e.time);
    if (e.kind === 'incident') {
      const p = e.incident.profit;
      return { n, when, time: e.time, title: incidentTitle(e.incident, w.itemName), link: `#/findings/${encodeURIComponent(e.incident.id)}`,
        sub: p !== 0n ? `${p > 0n ? 'made' : 'lost'} ${moneyShort(p < 0n ? -p : p)}` : `${count(e.incident.findings.length)} findings` };
    }
    if (e.kind === 'gap') {
      return { n, when, time: e.time, title: describe(e.finding, w).title, sub: `account ${e.finding.accounts[0] ?? ''}`, link: `#/findings/${encodeURIComponent(e.finding.id)}` };
    }
    const a = e.admin, by = `by ${a.actor}`;
    if (a.amount !== null) {
      return { n, when, time: e.time, title: `${KIND[a.type] ?? a.type}: ${a.item === null ? moneyShort(a.amount) : w.value(a.item, a.amount)}`,
        sub: `account ${a.account ?? ''} · ${by}`, link: a.account !== null ? `#/accounts/${a.account}` : null };
    }
    const name = /"([^"]*)"/.exec(a.subject ?? '')?.[1] ?? a.subject ?? '';
    return { n, when, time: e.time, title: ADMIN_CHANGE[a.type]?.(name) ?? `${a.type} ${name}`, sub: by,
      link: a.player ? `#/players/${encodeURIComponent(a.player)}` : null };
  }));
  const pickedEvent = $derived(listed.find((e) => e.n === picked) ?? null);
  /** Events before the first balance snapshot have no place on the chart. */
  const offChart = (t: number) => data !== null && data.money.length > 0 && t < data.money[0]![0];

  const best = $derived(data?.top[0]?.profit ?? 0n);
  const initials = (name: string) => (name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '?').toUpperCase();
  const factor = (v: number) => (v >= 10 ? count(Math.round(v)) : times(v));
</script>

<div>
  <h1 class="h1">Overview</h1>
  {#if main}<p class="sub">{main.name} · {servers} · {count(main.players)} players · {count(main.accounts)} bank accounts</p>{/if}
</div>

{#if !main}
  <p class="empty">The Overview needs the save with the bank and market data, the master's. Open it on the <a href="#/saves" style="color: var(--accent)">Saves and servers</a> screen.</p>
{:else}
  <section class="card summary" aria-label="Summary" aria-busy={app.incident === undefined}>
    {#if app.incident === undefined || (app.incident === null && open === null)}
      <div class="badge" style="--tint: var(--text3)"><Icon d={ICON.clock} size={22} stroke={2} /></div>
      <div class="text">
        <div class="kicker" style="color: var(--text3)">Checking</div>
        <p class="sentence" style="color: var(--text2)">Running the rules over all the data. The first run takes a few seconds.</p>
      </div>
    {:else if app.incident}
      {@const i = app.incident}
      {@const strong = i.level === 'critical' || i.level === 'high'}
      <div class="badge" style="--tint: {strong ? 'var(--crit)' : 'var(--med)'}"><Icon d={ICON.warn} size={22} stroke={2} /></div>
      <div class="text">
        <div class="kicker" style="color: {strong ? 'var(--crit)' : 'var(--med)'}">{strong ? 'Needs attention' : 'Worth a look'}</div>
        <p class="sentence">{incidentSentence(i, w.itemName)}</p>
        {#if !hasMarket}<p class="small" style="margin: 8px 0 0">The save has no market data, so trading profit, unusual prices and total wealth are not shown.</p>{/if}
        <a class="go" href="#/findings/{encodeURIComponent(i.id)}">Open the incident<Icon d="M5 12h14M13 6l6 6-6 6" size={16} stroke={2} /></a>
      </div>
    {:else if open?.length}
      <!-- Lone findings make no incident; "nothing unusual" would hide them. -->
      {@const top = byLevel[0]![0]}
      {@const strong = top === 'critical' || top === 'high'}
      <div class="badge" style="--tint: {strong ? 'var(--crit)' : 'var(--med)'}"><Icon d={ICON.warn} size={22} stroke={2} /></div>
      <div class="text">
        <div class="kicker" style="color: {strong ? 'var(--crit)' : 'var(--med)'}">{strong ? 'Needs attention' : 'Worth a look'}</div>
        <p class="sentence">No incident was found, but {open.length === 1 ? '1 finding is' : `${count(open.length)} findings are`} open in this time range, the strongest {top}.{hasMarket ? '' : ' The save has no market data, so trading profit, unusual prices and total wealth are not shown.'}</p>
        <a class="go" href="#/findings">Open the findings<Icon d="M5 12h14M13 6l6 6-6 6" size={16} stroke={2} /></a>
      </div>
    {:else}
      <div class="badge" style="--tint: var(--up)"><Icon d={ICON.ok} size={22} stroke={2} /></div>
      <div class="text">
        <div class="kicker" style="color: var(--up)">Nothing unusual</div>
        <p class="sentence">Nothing unusual was found. {checked}{hasMarket ? '' : ' The save has no market data, so trading profit, unusual prices and total wealth are not shown.'}</p>
      </div>
    {/if}
  </section>

  <section aria-label="Key figures" class="figures">
    <div class="figure">
      <div class="flabel">Money in bank accounts</div>
      {#if figures}
        <div class="fvalue" title={figures.now.title}>{figures.now.value}</div>
        <div class="small">{figures.now.sub}</div>
      {:else}<div class="fvalue busy" aria-busy="true">…</div>{/if}
    </div>
    <div class="figure">
      <div class="flabel">Change over the time range</div>
      {#if figures}
        <div class="fvalue" style="color: {figures.change.color}">{figures.change.value}</div>
        <div class="small">{figures.change.sub}</div>
      {:else}<div class="fvalue busy" aria-busy="true">…</div>{/if}
    </div>
    <div class="figure" aria-busy={open === null}>
      <div class="flabel">Open findings</div>
      {#if open}
        <div class="fvalue" style="color: {byLevel[0]?.[0] === 'critical' ? 'var(--crit)' : byLevel[0]?.[0] === 'high' ? 'var(--high)' : 'var(--text)'}">{count(open.length)}</div>
        <div class="small">{byLevel.length ? byLevel.map(([l, n]) => `${count(n)} ${l}`).join(' · ') : 'none in this time range'}</div>
      {:else}
        <div class="fvalue busy">…</div>
        <div class="small">running the rules</div>
      {/if}
    </div>
    <div class="figure">
      <div class="flabel">Players</div>
      <div class="fvalue">{count(main.players)}</div>
      <div class="small">{count(main.accounts)} bank {main.accounts === 1 ? 'account' : 'accounts'}</div>
    </div>
  </section>

  <section class="chartcard">
    <div class="plotside">
      <div class="head">
        <h2 class="h2 h3" style="flex: 1 1 auto">{data?.wealth && hasMarket ? 'Money and total wealth' : 'Money in bank accounts'}</h2>
        <span class="legend"><span class="swatch" style="background: var(--accent)"></span>Money</span>
        {#if data?.wealth && hasMarket}
          <button type="button" class="pill" aria-pressed={wealthOn} onclick={() => (wealthOn = !wealthOn)}><span class="swatch" style="background: currentColor"></span>Total wealth</button>
        {/if}
        {#if view}<button type="button" class="link" onclick={() => view && setRange('custom', view.from, view.to)}>Use as time range</button>{/if}
      </div>
      <p class="small note">All accounts added up, from the bank's balance snapshots.{data?.wealth && hasMarket ? ' Total wealth is money plus every item at its market price of that moment, so it rises when prices are pushed up.' : ''} Zoom with the wheel, drag to move.</p>
      {#if !data}
        <p class="small" aria-busy="true" style="margin: 24px 0 0">Loading the balances…</p>
      {:else if !used('bank')}
        <p class="empty" style="margin-top: 24px">This save has no bank data, so there is no money to draw.</p>
      {:else if data.money.length === 0}
        <p class="empty" style="margin-top: 24px">No balance snapshots in this time range.</p>
      {:else}
        <MoneyChart money={data.money} wealth={wealthOn && hasMarket ? data.wealth : null} end={app.scope.to ?? newest() ?? 0} bind:picked bind:view
          label="Money in all bank accounts over time" marks={listed.map((e) => ({ n: e.n, time: e.time, label: e.title }))} />
        {#if main.generation === 'legacy'}
          <p class="small" style="margin: 12px 0 0">This save was written by BankSystem 2.1.2, which thins out balance snapshots older than a day, so the line is coarser there.</p>
        {/if}
      {/if}
    </div>
    <div class="eventside">
      <h2 class="h2 h3">Key events</h2>
      {#if events === null}
        <p class="small" aria-busy="true" style="margin: 12px 0 0">Looking for the strongest moments…</p>
      {:else if listed.length === 0}
        <p class="small" style="margin: 12px 0 0">Nothing stands out in this time range.</p>
      {:else}
        <div class="events">
          {#each listed as e (e.n)}
            <button type="button" class="row event" aria-pressed={e.n === picked} onclick={() => (picked = picked === e.n ? null : e.n)}>
              <span class="dot" aria-hidden="true">{e.n}</span>
              <span class="what"><span style="font-weight: 500">{e.title}</span><span class="small">{e.when} · {e.sub}{offChart(e.time) ? ' · before the first balance snapshot, so not on the chart' : ''}</span></span>
            </button>
          {/each}
        </div>
        {#if pickedEvent?.link}<a class="more" href={pickedEvent.link}>Open event {pickedEvent.n}<Icon d="M5 12h14M13 6l6 6-6 6" size={16} stroke={2} /></a>{/if}
      {/if}
      <a class="more" href="#/findings">{open ? `All ${count(open.length)} open findings` : 'All findings'}<Icon d="M5 12h14M13 6l6 6-6 6" size={16} stroke={2} /></a>
    </div>
  </section>

  {#if hasMarket}
    <div class="pair">
      <section class="card">
        <div class="cardhead"><h2 class="h2 h3">Highest trading profit</h2><a class="link" href="#/players">All players</a></div>
        {#if !data}
          <p class="small" aria-busy="true" style="margin: 12px 0 0">Loading the players…</p>
        {:else if data.top.length === 0}
          <p class="small" style="margin: 12px 0 0">No player made a trading profit in this time range.</p>
        {:else}
          <div class="rows">
            {#each data.top as p (p.uuid)}
              {@const hot = flagged.has(p.uuid)}
              <a class="row item" href="#/players/{encodeURIComponent(p.uuid)}">
                <span class="avatar" class:hot aria-hidden="true">{initials(p.name)}</span>
                <span class="what" style="gap: 6px">
                  <span class="line"><span style="font-weight: 500">{p.name}</span><span class="tab">{signed(p.profit)}</span></span>
                  <span class="bar"><span style="width: {Math.max(1, Number((p.profit * 100n) / (best > 0n ? best : 1n)))}%; background: {hot ? 'var(--crit)' : 'var(--text3)'}"></span></span>
                </span>
              </a>
            {/each}
          </div>
        {/if}
      </section>
      <section class="card">
        <div class="cardhead"><h2 class="h2 h3">Markets with unusual prices</h2><a class="link" href="#/markets">All markets</a></div>
        {#if !data}
          <p class="small" aria-busy="true" style="margin: 12px 0 0">Loading the markets…</p>
        {:else if data.unusual.length === 0}
          <p class="small" style="margin: 12px 0 0">No price went twice as far as its usual price in this time range.</p>
        {:else}
          <div class="rows">
            {#each data.unusual as m (m.item)}
              {@const sev = m.times >= app.rules['far-price'].times ? 'var(--crit)' : 'var(--high)'}
              <a class="row item" href="#/markets/{m.item}">
                <span class="avatar" aria-hidden="true">{initials(w.itemName(m.item))}</span>
                <span class="what"><span style="font-weight: 500">{w.itemName(m.item)}</span><span class="small tab">{money(m.low)} to {money(m.high)} · usual price then {money(m.usual)}</span></span>
                <span class="chip" style="--tint: {sev}">{factor(m.times)} times {m.below ? 'below usual' : 'usual'}</span>
              </a>
            {/each}
          </div>
        {/if}
      </section>
    </div>
  {/if}
{/if}

<style>
  .empty { margin: 0; padding: 24px; border-radius: 14px; border: 1px dashed var(--line2); color: var(--text2); }
  .h3 { font-size: 17px; line-height: 24px; }
  .small { font-size: 13px; color: var(--text3); }
  .tab { font-variant-numeric: tabular-nums; }
  .summary { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; }
  .badge { flex: none; width: 44px; height: 44px; border-radius: 12px; display: flex; align-items: center; justify-content: center; color: var(--tint); background: color-mix(in srgb, var(--tint) 16%, transparent); }
  .text { flex: 1 1 420px; min-width: 0; }
  .kicker { font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }
  .sentence { margin: 6px 0 0; max-width: 860px; font-size: 20px; line-height: 30px; font-weight: 500; text-wrap: pretty; }
  .go { display: inline-flex; align-items: center; gap: 8px; height: 40px; margin-top: 16px; padding: 0 16px; border-radius: 10px; font-weight: 600; background: var(--accent); color: var(--onaccent); }
  .figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 16px; }
  .figure { display: flex; flex-direction: column; gap: 8px; padding: 20px; border-radius: 14px; background: var(--card); border: 1px solid var(--line); }
  .flabel { font-size: 13px; color: var(--text2); }
  .fvalue { font-family: var(--font-head); font-size: 30px; line-height: 36px; font-weight: 600; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; }
  .busy { color: var(--text3); }
  .chartcard { display: flex; flex-wrap: wrap; border-radius: 14px; background: var(--card); border: 1px solid var(--line); }
  .plotside { flex: 3 1 520px; min-width: 0; box-sizing: border-box; padding: 24px; }
  .eventside { flex: 1 1 320px; min-width: 0; box-sizing: border-box; padding: 24px; border-left: 1px solid var(--line); display: flex; flex-direction: column; align-items: flex-start; }
  .head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .note { margin: 4px 0 0; text-wrap: pretty; }
  .legend { display: inline-flex; align-items: center; gap: 8px; font-weight: 500; }
  .swatch { width: 16px; height: 3px; border-radius: 2px; }
  .pill { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border-radius: 18px; font-weight: 500; border: 1px solid var(--line); background: transparent; color: var(--text3); }
  .pill[aria-pressed='true'] { border-color: var(--text2); color: var(--text); }
  .link { padding: 0; border: 0; background: none; font-size: 13px; font-weight: 500; color: var(--accent); }
  .events { display: flex; flex-direction: column; gap: 2px; align-self: stretch; margin: 12px -10px 0; }
  .event { display: flex; align-items: flex-start; gap: 12px; padding: 10px; border: 0; border-radius: 10px; text-align: left; background: transparent; }
  .event[aria-pressed='true'] { background: var(--raised); }
  .dot { flex: none; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; background: var(--raised); color: var(--text); }
  .event[aria-pressed='true'] .dot { background: var(--accent); color: var(--onaccent); }
  .what { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .more { display: inline-flex; align-items: center; gap: 6px; margin-top: 12px; font-weight: 500; color: var(--accent); }
  .pair { display: flex; flex-wrap: wrap; gap: 24px; }
  .pair > .card { flex: 1 1 420px; min-width: 0; box-sizing: border-box; }
  .cardhead { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .rows { display: flex; flex-direction: column; gap: 2px; margin: 12px -10px 0; }
  .item { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 0 10px; border-radius: 10px; }
  .avatar { flex: none; width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; background: var(--raised); color: var(--text2); }
  .avatar.hot { background: color-mix(in srgb, var(--crit) 16%, transparent); color: var(--crit); }
  .line { display: flex; justify-content: space-between; gap: 12px; }
  .bar { display: block; height: 4px; border-radius: 2px; background: var(--line); }
  .bar > span { display: block; height: 4px; border-radius: 2px; }
  .chip { flex: none; height: 24px; padding: 0 8px; border-radius: 6px; font-size: 12px; line-height: 24px; font-weight: 500; white-space: nowrap; color: var(--tint); background: color-mix(in srgb, var(--tint) 16%, transparent); }
</style>
