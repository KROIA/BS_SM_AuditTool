<script lang="ts">
  // The search field of the top bar: a short grouped list under the field, Enter opens the first hit. There is no results page.
  import type { SearchResult } from '../../shared/api.ts';
  import { time } from '../../shared/fmt.ts';
  import Icon from './Icon.svelte';
  import { ICON } from './nav.ts';
  import { app, engine } from './state.svelte.ts';
  import { words } from './words.ts';

  let text = $state('');
  let open = $state(false);
  let result = $state<SearchResult | null>(null);

  $effect(() => {
    const q = text.trim();
    void app.saves.length;
    if (q === '') return void (result = null);
    let stale = false;
    void engine.search(q).then((r) => !stale && (result = r));
    return () => (stale = true);
  });

  const groups = $derived.by(() => {
    if (!result) return [];
    const { itemName } = words(new Map(result.items.map((i) => [i.id, i])));
    return [
      { label: 'Players', hits: result.players.map((p) => ({ href: '#/players/' + encodeURIComponent(p.uuid), title: p.name, sub: p.uuid.slice(0, 8) })) },
      { label: 'Bank accounts', hits: result.accounts.map((a) => ({ href: '#/accounts/' + a.number, title: a.name, sub: 'Account ' + a.number })) },
      { label: 'Markets', hits: result.items.map((i) => ({ href: '#/markets/' + i.id, title: itemName(i.id), sub: i.name })) },
      {
        label: 'Orders',
        hits: result.orders.map((o) => ({
          href: '#/players/' + encodeURIComponent(o.player), title: 'Order ' + (o.orderId ?? o.id),
          sub: `${o.amount > 0n ? 'buy' : 'sell'} by ${o.name}, placed ${time(o.time)}`,
        })),
      },
      {
        label: 'Transfers',
        hits: result.transfers.map((t) => ({
          href: '#/saves/transfers/' + encodeURIComponent(t.id), title: 'Transfer ' + t.id.slice(0, 8),
          sub: `${t.player?.name ?? 'player not known'}, started ${time(t.start)}`,
        })),
      },
    ].filter((g) => g.hits.length > 0);
  });

  function go(href: string) {
    open = false;
    location.hash = href;
  }
  async function keys(e: KeyboardEvent) {
    if (e.key === 'Escape') open = false;
    if (e.key !== 'Enter' || text.trim() === '') return;
    result = await engine.search(text.trim()); // the hits of what is typed now, not of the letters before
    const first = groups[0]?.hits[0];
    if (first) go(first.href);
  }
  // The list closes when the focus leaves the field and the list together.
  const leave = (e: FocusEvent) => !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null) && (open = false);
</script>

<div class="wrap" onfocusout={leave}>
  <label class="search">
    <Icon d={ICON.search} />
    <input type="search" aria-label="Search everything" placeholder="Search players, accounts, items, order or transfer ids" autocomplete="off"
      bind:value={text} onfocus={() => (open = true)} oninput={() => (open = true)} onkeydown={keys} />
  </label>
  {#if open && text.trim() !== '' && result}
    <div class="results" role="region" aria-label="Search results">
      {#each groups as g (g.label)}
        <div class="group">{g.label}</div>
        {#each g.hits as h (h.href + h.title)}
          <a class="hit" href={h.href} onclick={() => (open = false)}><span class="title">{h.title}</span><span class="small sub">{h.sub}</span></a>
        {/each}
      {:else}
        <p class="small none">Nothing found. Search looks at player names and the start of UUIDs, account numbers and names, item names and ids, order ids, and transfer ids (whole or their first 8 characters).</p>
      {/each}
      {#if groups.length}<p class="small hint">Enter opens the first result.</p>{/if}
    </div>
  {/if}
</div>

<style>
  .wrap { position: relative; flex: 1 1 280px; max-width: 460px; }
  .search { display: flex; align-items: center; gap: 10px; height: 40px; padding: 0 12px; box-sizing: border-box; border-radius: 10px; background: var(--card); border: 1px solid var(--line); color: var(--text3); }
  .search:focus-within { border-color: var(--accent); }
  .search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--text); }
  .results { position: absolute; z-index: 10; top: 46px; left: 0; right: 0; max-height: 70vh; overflow-y: auto; padding: 8px; box-sizing: border-box;
    border-radius: 12px; background: var(--card); border: 1px solid var(--line2); box-shadow: 0 12px 32px rgb(0 0 0 / 0.35); }
  .group { padding: 8px 10px 4px; font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text3); }
  .hit { display: flex; align-items: baseline; gap: 10px; padding: 8px 10px; border-radius: 8px; }
  .hit:hover, .hit:focus-visible { background: var(--raised); }
  .title { font-weight: 500; white-space: nowrap; }
  .sub { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .none, .hint { margin: 8px 10px; }
</style>
