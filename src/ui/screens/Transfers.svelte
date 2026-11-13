<script lang="ts">
  // The Transfers tab of Saves and servers: do the master and its slaves agree on what moved between them? The classes of
  // DESIGN_SPEC 8.6 as tiles that filter the table below; pairs are made by the engine (query/transfers.ts).
  import type { ItemRow, TransferClass, TransferItem, TransferRow, TransfersResult } from '../../shared/api.ts';
  import { count, money, time } from '../../shared/fmt.ts';
  import { app, engine } from '../app/state.svelte.ts';
  import { LEVEL_COLOR, words } from '../app/words.ts';

  const PAGE = 10; // rows shown, then "Show more" adds as many again (DESIGN_SPEC rule 3)
  /** The classes in tile order: value went wrong first (these raise a finding, level high), then the rest. */
  const CLASS: [TransferClass, string, boolean][] = [
    ['lost', 'Lost on the way', true],
    ['twice', 'Arrived twice', true],
    ['created', 'Came from nothing', true],
    ['parked', 'Left for an admin', true],
    ['ok', 'Matched', false],
    ['known-gap', 'Known gap in the mods', false],
    ['data-gap', 'Cannot tell', false],
    ['after-snapshot', 'Newer than a copy', false],
  ];
  const LABEL = Object.fromEntries(CLASS.map(([c, l]) => [c, l])) as Record<TransferClass, string>;
  const WRONG = new Set(CLASS.filter((c) => c[2]).map((c) => c[0]));

  let result = $state<TransfersResult | null>(null);
  let itemRows = $state(new Map<number, ItemRow>());
  let raised = $state(new Set<string>()); // finding ids of the transfer rule
  let picked = $state<TransferClass | null>(null);
  let shown = $state(PAGE);

  $effect(() => {
    const scope = $state.snapshot(app.scope), rules = $state.snapshot(app.rules);
    void app.saves.length;
    let stale = false;
    void Promise.all([engine.transfers(scope), engine.items(), engine.findings(scope, rules)]).then(([t, i, f]) => {
      if (stale) return;
      result = t;
      itemRows = new Map(i.map((x) => [x.id, x]));
      raised = new Set(f.findings.filter((x) => x.rule === 'transfer').map((x) => x.id));
    });
    return () => (stale = true);
  });

  const { value } = $derived(words(itemRows));
  const all = $derived(result?.transfers ?? []);
  const rows = $derived(picked === null ? all : all.filter((t) => t.class === picked));
  const wrong = $derived(CLASS.filter(([c, , w]) => w && result && result.counts[c] > 0).map(([c]) => [c, result!.counts[c]] as const));
  const master = $derived(app.saves.find((s) => s.role === 'MASTER' || s.role === 'STANDALONE')?.name ?? 'the master');

  function pick(c: TransferClass) {
    picked = picked === c ? null : c;
    shown = PAGE;
  }

  /** The answer first: how many need a look, and why. */
  const lead = $derived.by(() => {
    if (!result || !all.length) return '';
    const n = wrong.reduce((s, [, k]) => s + k, 0);
    if (!n) return `All ${count(all.length)} ${all.length === 1 ? 'transfer' : 'transfers'} in this time range matched or are explained.`;
    return `${count(n)} of ${count(all.length)} transfers need a look: ` + wrong.map(([c, k]) => `${count(k)} ${LABEL[c].toLowerCase()}`).join(', ') + '.';
  });

  // ---- One row in words ----
  const label = (i: TransferItem, raw: bigint) => (i.item === null ? money(raw) : value(i.item, raw));
  const list = (items: TransferItem[], side: 'sent' | 'received') => items.filter((i) => i[side] !== 0n).map((i) => label(i, i[side])).join(', ') || 'nothing';
  /** What moved: what left the sending side, else what arrived. */
  const moved = (t: TransferRow) => t.items.map((i) => label(i, i.sent !== 0n ? i.sent : i.received));
  const slave = (t: TransferRow) => t.server ?? 'a slave';
  function route(t: TransferRow): string {
    if (t.direction === 'TO_MASTER') return `${slave(t)} to ${master}`;
    if (t.direction === 'FROM_MASTER') return `${master} to ${slave(t)}`;
    return `${master}, the slave is not known`;
  }
  /** What each side did, in one sentence. */
  function sides(t: TransferRow): string {
    if (!t.items.length) return t.class === 'ok' ? '' : 'The amounts could not be read.'; // ok without items: nothing moved, `why` says so
    const sent = list(t.items, 'sent'), got = list(t.items, 'received');
    if (t.direction === 'TO_MASTER') return `${slave(t)} took ${sent}, ${master} credited ${got}.`;
    if (t.path === 'DROP') return `${master} took ${sent} from the account, ${slave(t)} dropped ${got} into the inventory.`;
    if (t.direction === 'FROM_MASTER') return `${master} took ${sent} from the account, ${slave(t)} handed out ${got}.`;
    return `${master} took ${sent} and credited ${got}; no loaded journal has this transfer.`;
  }
  const short = (id: string) => (id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
  const color = (c: TransferClass) => (WRONG.has(c) ? LEVEL_COLOR.high : 'var(--text2)');
</script>

<p class="intro">Every time value moves between the master bank and a slave server, the slave writes it down in its journal and the master writes the same transfer id on its log entries. The tool pairs them by that id, never by time, and checks that what left one side arrived on the other.</p>

{#if !result}
  <p class="small" aria-busy="true">Loading the transfers…</p>
{:else if result.reason !== null}
  <p class="empty">{result.reason}</p>
{:else}
  {#if lead}<p class="lead">{lead}</p>{/if}
  <div role="group" aria-label="Filter transfers by result" class="tiles">
    {#each CLASS as [c, l, w] (c)}
      {@const n = result.counts[c]}
      <button type="button" class="tile" aria-pressed={picked === c} onclick={() => pick(c)}>
        <span class="tlabel">{l}</span>
        <span class="tcount" style="color: {w && n > 0 ? LEVEL_COLOR.high : 'var(--text)'}">{count(n)}</span>
      </button>
    {/each}
  </div>

  <section class="card">
    {#if rows.length === 0}
      <p style="margin: 0; color: var(--text2)">{picked === null ? 'No transfers between servers in this time range.' : `No transfers ${LABEL[picked].toLowerCase()} in this time range.`}</p>
    {:else}
      <div style="overflow-x: auto">
        <table>
          <thead>
            <tr><th>When</th><th>Between</th><th>What moved</th><th>Result</th></tr>
          </thead>
          <tbody>
            {#each rows.slice(0, shown) as t (t.id)}
              <tr>
                <td style="white-space: nowrap">
                  <span style="display: block; font-size: 13px; color: var(--text2)">{time(t.start)}</span>
                  <span class="mono" title={t.id}>{short(t.id)}</span>
                </td>
                <td>
                  <span style="display: block; font-weight: 500">{route(t)}</span>
                  <span class="small" style="display: block">
                    {#if t.player}<a class="ref" href="#/players/{encodeURIComponent(t.player.uuid)}">{t.player.name}</a>{/if}{#if t.player && t.account !== null}{' · '}{/if}{#if t.account !== null}<a
                        class="ref" href="#/accounts/{t.account}">account {t.account}</a>{/if}
                  </span>
                </td>
                <td style="font-weight: 500">
                  {#each moved(t) as m}<span style="display: block; white-space: nowrap">{m}</span>{:else}<span class="small">{t.class === 'ok' ? 'nothing' : 'not readable'}</span>{/each}
                </td>
                <td>
                  <span class="chip" style="--c: {color(t.class)}">{LABEL[t.class]}</span>
                  {#if sides(t)}<span style="display: block; margin-top: 6px; text-wrap: pretty">{sides(t)}</span>{/if}
                  <span class="small" style="display: block; text-wrap: pretty">{t.why}</span>
                  {#if raised.has('transfer:' + t.id)}<a class="ref small" href="#/findings/{encodeURIComponent('transfer:' + t.id)}">Open the finding</a>{/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    <div class="foot">
      <p class="small" style="flex: 1 1 auto; margin: 0">
        {rows.length > shown ? `The latest ${count(shown)} of ${count(rows.length)}` : `${count(rows.length)}`} {rows.length === 1 ? 'transfer' : 'transfers'}{picked === null ? '' : ` of ${count(all.length)}`}, newest first.{picked === null ? '' : ' Pick the tile again to show them all.'}
      </p>
      {#if rows.length > shown}<button type="button" class="link" onclick={() => (shown += PAGE * 2)}>Show more</button>{/if}
    </div>
  </section>
{/if}

<style>
  .intro { margin: 0; max-width: 820px; color: var(--text2); text-wrap: pretty; }
  .lead { margin: 0; font-size: 16px; line-height: 24px; text-wrap: pretty; }
  .empty { margin: 0; padding: 24px; border-radius: 14px; border: 1px dashed var(--line2); color: var(--text2); }
  /* Four per row: the classes that need a look above, the rest below. */
  .tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
  .tile { display: flex; flex-direction: column; gap: 4px; padding: 16px; border-radius: 14px; text-align: left; border: 1px solid var(--line); background: var(--card); color: var(--text); }
  .tile:hover { background: var(--raised); }
  .tile[aria-pressed='true'] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .tlabel { font-size: 13px; color: var(--text2); }
  .tcount { font-family: var(--font-head); font-size: 26px; line-height: 32px; font-weight: 600; font-variant-numeric: tabular-nums; }
  table { width: 100%; min-width: 760px; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th { padding: 0 12px 10px; font-size: 12px; font-weight: 600; color: var(--text3); text-align: left; }
  td { padding: 12px; border-top: 1px solid var(--line); vertical-align: top; }
  th:first-child, td:first-child { padding-left: 0; }
  th:last-child, td:last-child { padding-right: 0; width: 42%; }
  .mono { font-family: var(--font-mono); font-size: 12px; color: var(--text3); }
  .ref { color: var(--accent); }
  .chip { display: inline-block; height: 24px; padding: 0 8px; border-radius: 6px; font-size: 12px; line-height: 24px; font-weight: 600; color: var(--c); background: color-mix(in srgb, var(--c) 16%, transparent); }
  .foot { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; margin-top: 16px; }
  .link { padding: 0; border: 0; background: none; font-size: 13px; font-weight: 500; color: var(--accent); }
</style>
