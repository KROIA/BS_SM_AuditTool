<script lang="ts">
  // The time range, the server filter and the incident of the top bar. All set app.scope, which every screen passes to
  // its questions. An incident picked here (focus) narrows the whole tool to its players and accounts until it is removed.
  import type { Incident } from '../../shared/api.ts';
  import { time } from '../../shared/fmt.ts';
  import { incidentTitle, strongest as pick } from '../../shared/incident.ts';
  import Icon from './Icon.svelte';
  import { ICON } from './nav.ts';
  import { app, engine, newest, setRange, type Range } from './state.svelte.ts';
  import { words } from './words.ts';

  let rangeMenu = $state<HTMLElement>();
  let serverMenu = $state<HTMLElement>();
  let focusMenu = $state<HTMLElement>();
  let fromText = $state('');
  let toText = $state('');
  let problem = $state('');

  const MIN = 60_000;
  const short = (ms: number) => time(ms).slice(0, -3); // to the minute
  /** epoch ms <-> the value of a datetime-local field, in the computer's time zone */
  const field = (ms: number | null) => (ms === null ? '' : new Date(ms - new Date(ms).getTimezoneOffset() * MIN).toISOString().slice(0, 16));
  const parse = (v: string) => (v === '' ? null : new Date(v).getTime());

  const label = $derived.by(() => {
    const { from, to } = app.scope;
    if (app.range === 'day') return 'Last 24 hours';
    if (app.range === 'week') return 'Last 7 days';
    if (app.range === 'incident') return 'The incident';
    // Within one year the year is left out, as on the canvas: 3 Nov, 00:00 to 5 Nov, 18:25
    if (from !== null && to !== null) return new Date(from).getFullYear() === new Date(to).getFullYear()
      ? `${short(from).replace(/ \d{4},/, ',')} to ${short(to).replace(/ \d{4},/, ',')}` : `${short(from)} to ${short(to)}`;
    if (from !== null) return 'From ' + short(from);
    if (to !== null) return 'Up to ' + short(to);
    return 'Everything';
  });
  const end = $derived(newest());
  const CHOICES: [Range, string][] = [['all', 'Everything'], ['day', 'Last 24 hours'], ['week', 'Last 7 days']];

  // The strongest incident over all the data of the filtered server (highest level, then largest profit) that still has
  // a finding not marked as "not a problem". Shared through app.incident with the Overview.
  let strongest = $state<{ incident: Incident; title: string } | null>(null);
  /** Every incident, titled, strongest first: the choices of the incident menu. */
  let list = $state<{ incident: Incident; title: string }[]>([]);
  $effect(() => {
    const server = app.scope.server, rules = $state.snapshot(app.rules), marks = app.marks;
    const none = app.saves.length === 0;
    let stale = false;
    app.incident = none ? null : undefined;
    if (none) [strongest, list] = [null, []];
    if (none || app.queue.length) return; // saves are still being read: each one would start the rules over
    // The engine answers one call after the other and the first run of the rules takes seconds: a tick later, the
    // screen's own quick questions go first.
    const timer = setTimeout(() => void Promise.all([engine.incidents({ from: null, to: null, server }, rules), engine.items()]).then(([r, i]) => {
      if (stale) return;
      const top = pick(r.incidents, (id) => marks[id]?.dismissed === true), name = words(new Map(i.map((x) => [x.id, x]))).itemName;
      app.incident = top;
      strongest = top ? { incident: top, title: incidentTitle(top, name) } : null;
      list = r.incidents.map((incident) => ({ incident, title: incidentTitle(incident, name) }));
      // Changed rules can change the picked incident, or end it: the focus follows.
      const was = app.scope.focus, now = was ? (r.incidents.find((x) => x.id === was.id) ?? null) : null;
      if (was && !now) focus(null);
      else if (was && now && JSON.stringify([now.players, now.accounts, now.findings]) !== JSON.stringify([was.players, was.accounts, was.findings])) app.scope = { ...app.scope, focus: now };
    }));
    return () => ((stale = true), clearTimeout(timer));
  });

  /** Picks the incident the whole tool shows (null: all the data again), with its time and 30 minutes on each side. */
  function focus(i: Incident | null) {
    app.scope = { ...app.scope, focus: i };
    if (i) setRange('incident', i.start - 30 * MIN, i.end + 30 * MIN);
    else setRange('all');
    focusMenu?.hidePopover();
  }
  const focused = $derived(list.find((x) => x.incident.id === app.scope.focus?.id)?.title ?? null);

  function choose(r: Range) {
    const inc = app.scope.focus ?? strongest?.incident;
    if (r === 'incident' && inc) setRange(r, inc.start - 30 * MIN, inc.end + 30 * MIN);
    else setRange(r);
    rangeMenu?.hidePopover();
  }
  function opened(e: ToggleEvent) {
    if (e.newState !== 'open') return;
    [fromText, toText, problem] = [field(app.scope.from), field(app.scope.to), ''];
  }
  function custom(e: SubmitEvent) {
    e.preventDefault();
    const from = parse(fromText), to = parse(toText);
    if (from !== null && to !== null && from > to) return void (problem = 'The start is after the end.');
    setRange(from === null && to === null ? 'all' : 'custom', from, to === null ? null : to + MIN - 1); // the end's whole minute counts
    rangeMenu?.hidePopover();
  }
  function server(name: string | null) {
    app.scope = { ...app.scope, server: name };
    serverMenu?.hidePopover();
  }
</script>

<button type="button" class="btn" popovertarget="range-menu" style="anchor-name: --range" aria-label="Time range: {label}">
  <span class="dim"><Icon d={ICON.clock} /></span><span>{label}</span>
</button>
<div id="range-menu" class="menu" popover bind:this={rangeMenu} onbeforetoggle={opened} style="position-anchor: --range" aria-label="Time range">
  {#each CHOICES as [r, text] (r)}
    <button type="button" class="choice" aria-pressed={app.range === r} disabled={r !== 'all' && end === null} onclick={() => choose(r)}>{text}</button>
  {/each}
  {#if strongest}
    <button type="button" class="choice stack" aria-pressed={app.range === 'incident'} onclick={() => choose('incident')}>The incident<span class="small">{app.scope.focus ? focused : strongest.title}</span></button>
  {/if}
  <p class="small note">{end === null ? 'No data loaded yet.' : `"Last" counts back from the newest data in the saves, ${short(end)}, not from today.`}</p>
  <form onsubmit={custom}>
    <label>From <input type="datetime-local" bind:value={fromText} /></label>
    <label>To <input type="datetime-local" bind:value={toText} /></label>
    {#if problem}<p class="small" style="margin: 0; color: var(--down)">{problem}</p>{/if}
    <button type="submit" class="btn">Use this range</button>
  </form>
</div>

<button type="button" class="btn focus" class:on={focused !== null} popovertarget="focus-menu" style="anchor-name: --focus" aria-label="Incident shown: {focused ?? 'none, all the data'}">
  <span class="dim"><Icon d={ICON.warn} /></span><span class="ellipsis">{focused ?? 'All incidents'}</span>
</button>
<div id="focus-menu" class="menu" popover bind:this={focusMenu} style="position-anchor: --focus; width: 360px" aria-label="Incident shown">
  <button type="button" class="choice" aria-pressed={!app.scope.focus} onclick={() => focus(null)}>None: all the data</button>
  <div class="options">
    {#each list as x (x.incident.id)}
      <button type="button" class="choice stack" aria-pressed={x.incident.id === app.scope.focus?.id} onclick={() => focus(x.incident)}>{x.title}<span class="small">{short(x.incident.start)}</span></button>
    {/each}
  </div>
  <p class="small note">{list.length ? 'Picking one shows only its players and accounts on every screen, from 30 minutes before it to 30 minutes after. None shows all the data again.' : 'No incident with these rule settings.'}</p>
</div>

<button type="button" class="btn" popovertarget="server-menu" style="anchor-name: --server" aria-label="Server: {app.scope.server ?? 'all servers'}">
  <span class="dim"><Icon d={ICON.servers} /></span><span>{app.scope.server ?? 'All servers'}</span>
</button>
<div id="server-menu" class="menu" popover bind:this={serverMenu} style="position-anchor: --server" aria-label="Server">
  <button type="button" class="choice" aria-pressed={app.scope.server === null} onclick={() => server(null)}>All servers</button>
  {#each app.saves as s (s.path)}
    <button type="button" class="choice" aria-pressed={app.scope.server === s.name} onclick={() => server(s.name)}>{s.name}<span class="small">{s.role.toLowerCase()}</span></button>
  {/each}
  <p class="small note">Filters orders by the server they were placed on. Bank and market data exist only once, on the master.</p>
</div>

<style>
  .dim { color: var(--text3); display: flex; }
  .menu { position-area: bottom span-left; inset: auto; margin: 6px 0 0; width: 300px; padding: 8px; box-sizing: border-box; border-radius: 12px;
    background: var(--card); color: var(--text); border: 1px solid var(--line2); box-shadow: 0 12px 32px rgb(0 0 0 / 0.35); }
  .choice { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; width: 100%; padding: 8px 10px; border: 0; border-radius: 8px; background: none; text-align: left; font-weight: 500; }
  .stack { flex-direction: column; align-items: flex-start; gap: 2px; }
  .choice:hover:not(:disabled), .choice[aria-pressed='true'] { background: var(--raised); }
  .note { margin: 8px 10px; }
  .options { display: flex; flex-direction: column; max-height: 360px; overflow-y: auto; }
  .focus { max-width: 280px; }
  .ellipsis { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .focus.on { border-color: var(--accent); color: var(--accent); }
  .focus.on .dim { color: var(--accent); }
  form { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 12px 10px 4px; border-top: 1px solid var(--line); }
  label { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--text2); }
  label input { height: 32px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); }
  form .btn { justify-content: center; color: var(--text); }
</style>
