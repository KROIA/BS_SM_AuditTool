<script lang="ts">
  // The frame around every screen: left menu, top bar, and the screen itself.
  import { count } from '../../shared/fmt.ts';
  import Accounts from '../screens/Accounts.svelte';
  import Markets from '../screens/Markets.svelte';
  import Players from '../screens/Players.svelte';
  import Saves from '../screens/Saves.svelte';
  import Soon from '../screens/Soon.svelte';
  import Icon from './Icon.svelte';
  import { ICON, SCREENS } from './nav.ts';
  import ScopeMenus from './ScopeMenus.svelte';
  import Search from './Search.svelte';
  import { app, start, toggleTheme } from './state.svelte.ts';

  // An address is the screen and, for a player, an account or a market, what it shows: #/players/<uuid>
  const route = $derived(app.route.split('/'));
  const screen = $derived(SCREENS.find((s) => s.id === route[0]) ?? SCREENS.find((s) => s.id === 'saves')!);
  const savesLine = $derived(app.saves.length === 0 ? 'No save loaded' : app.saves.length === 1 ? '1 save loaded' : count(app.saves.length) + ' saves loaded');

  void start();
</script>

<div class="app" data-theme={app.theme}>
  <nav aria-label="Sections">
    <a class="brand" href="#/saves">
      <span style="color: var(--accent); display: flex"><Icon d={ICON.logo} size={22} stroke={2} /></span>
      <span>Audit Tool</span>
    </a>
    <div class="links">
      {#each SCREENS as s (s.id)}
        <a class="nav" href={'#/' + s.id} aria-current={s.id === screen.id ? 'page' : undefined}><Icon d={s.icon} /><span>{s.label}</span></a>
      {/each}
    </div>
    <a class="btn loaded" href="#/saves">
      <span style="font-weight: 500">{savesLine}</span>
      <span class="readonly"><Icon d={ICON.lock} size={14} stroke={2} />Read-only copies</span>
    </a>
  </nav>

  <div class="right">
    <header>
      <Search />
      <div style="flex: 1 1 0"></div>
      <ScopeMenus />
      <!-- The case arrives with milestone M4; until then it is switched off. -->
      <button type="button" class="btn" disabled><span style="color: var(--text3); display: flex"><Icon d={ICON.pin} /></span><span>Case</span><span style="color: var(--text3)">0 pinned</span></button>
      <button type="button" class="btn" style="width: 40px; padding: 0; justify-content: center" onclick={toggleTheme} aria-label={app.theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}>
        <Icon d={app.theme === 'dark' ? ICON.sun : ICON.moon} />
      </button>
    </header>
    {#if app.scope.server !== null}
      <p class="scopenote">Only orders placed on {app.scope.server} are counted: bank and market data exist only once, on the master, and orders whose server the save does not record (saves of version 2.1.2, inter-market legs) are left out.</p>
    {/if}

    <main>
      <div class="page" class:flush={screen.id === 'players' || screen.id === 'accounts' || screen.id === 'markets'}>
        {#if screen.id === 'saves'}
          <Saves />
        {:else if screen.id === 'players'}
          <Players selected={route[1] ? decodeURIComponent(route[1]) : null} />
        {:else if screen.id === 'accounts'}
          <Accounts selected={route[1] ? Number(route[1]) : null} />
        {:else if screen.id === 'markets'}
          <Markets selected={route[1] ? Number(route[1]) : null} />
        {:else}
          <Soon {screen} />
        {/if}
      </div>
    </main>
  </div>
</div>

<style>
  nav { flex: 0 0 232px; box-sizing: border-box; display: flex; flex-direction: column; gap: 28px; padding: 20px 12px; overflow-y: auto; background: var(--rail); border-right: 1px solid var(--line); }
  .brand { display: flex; align-items: center; gap: 10px; height: 32px; padding: 0 12px; font-family: var(--font-head); font-size: 16px; font-weight: 600; }
  .links { display: flex; flex-direction: column; gap: 2px; }
  .loaded { margin-top: auto; height: auto; flex-direction: column; align-items: stretch; gap: 4px; padding: 12px; background: transparent; }
  .readonly { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--up); }
  .right { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; }
  header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 14px 32px; border-bottom: 1px solid var(--line); }
  .scopenote { margin: 0; padding: 10px 32px; border-bottom: 1px solid var(--line); font-size: 13px; color: var(--text2); background: var(--card); }
  main { flex: 1 1 0; min-height: 0; overflow-y: auto; }
  .page { display: flex; flex-direction: column; gap: 24px; padding: 28px 32px 40px; }
  .page.flush { display: block; height: 100%; padding: 0; } /* a screen with its own list on the left lays itself out */
</style>
