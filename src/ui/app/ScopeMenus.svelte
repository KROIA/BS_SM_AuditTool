<script lang="ts">
  // The time range and the server filter of the top bar. Both set app.scope, which every screen passes to its questions.
  import { DEFAULT_RULES, type Incident } from '../../shared/api.ts';
  import { time } from '../../shared/fmt.ts';
  import { incidentTitle } from '../../shared/incident.ts';
  import Icon from './Icon.svelte';
  import { ICON } from './nav.ts';
  import { app, engine, newest, setRange, type Range } from './state.svelte.ts';
  import { words } from './words.ts';

  let rangeMenu = $state<HTMLElement>();
  let serverMenu = $state<HTMLElement>();
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

  // The strongest incident over all the data of the filtered server (highest level, then largest profit).
  // ponytail: the default rules until the rule settings have a screen (Findings, detection rules).
  let strongest = $state<{ incident: Incident; title: string } | null>(null);
  $effect(() => {
    const server = app.scope.server;
    void app.saves;
    void Promise.all([engine.incidents({ from: null, to: null, server }, DEFAULT_RULES), engine.items()]).then(([r, i]) => {
      const top = r.incidents[0];
      strongest = top ? { incident: top, title: incidentTitle(top, words(new Map(i.map((x) => [x.id, x]))).itemName) } : null;
    });
  });

  function choose(r: Range) {
    if (r === 'incident' && strongest) setRange(r, strongest.incident.start - 30 * MIN, strongest.incident.end + 30 * MIN);
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
<div id="range-menu" class="menu" popover bind:this={rangeMenu} ontoggle={opened} style="position-anchor: --range" aria-label="Time range">
  {#each CHOICES as [r, text] (r)}
    <button type="button" class="choice" aria-pressed={app.range === r} disabled={r !== 'all' && end === null} onclick={() => choose(r)}>{text}</button>
  {/each}
  {#if strongest}
    <button type="button" class="choice stack" aria-pressed={app.range === 'incident'} onclick={() => choose('incident')}>The incident<span class="small">{strongest.title}</span></button>
  {/if}
  <p class="small note">{end === null ? 'No data loaded yet.' : `"Last" counts back from the newest data in the saves, ${short(end)}, not from today.`}</p>
  <form onsubmit={custom}>
    <label>From <input type="datetime-local" bind:value={fromText} /></label>
    <label>To <input type="datetime-local" bind:value={toText} /></label>
    {#if problem}<p class="small" style="margin: 0; color: var(--down)">{problem}</p>{/if}
    <button type="submit" class="btn">Use this range</button>
  </form>
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
  form { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 12px 10px 4px; border-top: 1px solid var(--line); }
  label { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; color: var(--text2); }
  label input { height: 32px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); }
  form .btn { justify-content: center; color: var(--text); }
</style>
