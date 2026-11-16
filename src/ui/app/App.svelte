<script lang="ts">
  // The frame around every screen: left menu, top bar, and the screen itself.
  import { count } from '../../shared/fmt.ts';
  import Accounts from '../screens/Accounts.svelte';
  import Case from '../screens/Case.svelte';
  import Findings from '../screens/Findings.svelte';
  import Flow from '../screens/Flow.svelte';
  import Markets from '../screens/Markets.svelte';
  import Overview from '../screens/Overview.svelte';
  import Players from '../screens/Players.svelte';
  import Saves from '../screens/Saves.svelte';
  import Icon from './Icon.svelte';
  import { ICON, SCREENS } from './nav.ts';
  import ScopeMenus from './ScopeMenus.svelte';
  import Search from './Search.svelte';
  import { app, pins, start, toggleTheme } from './state.svelte.ts';

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
      <a class="btn" href="#/case" aria-label="Case: {count(pins())} pinned"><span style="color: var(--text3); display: flex"><Icon d={ICON.pin} /></span><span>Case</span><span style="color: var(--text3)">{count(pins())} pinned</span></a>
      <button type="button" class="btn" style="width: 40px; padding: 0; justify-content: center; anchor-name: --info" popovertarget="info" aria-label="About the Audit Tool">
        <Icon d={ICON.info} />
      </button>
      <div id="info" popover class="info" aria-label="About the Audit Tool">
        <h2>Audit Tool <span class="small">version {__APP_VERSION__}</span></h2>
        <p>Finds exploits and cheating on Minecraft servers that run the BankSystem and StockMarket mods. It reads copies of
          the saves of a master server and its slaves, checks the bank's log against the balances, looks for unusual trading,
          follows the money and the items, and writes a report for the admins: who gained what, how, and what to take back.</p>
        <ol>
          <li><b>Saves and servers</b>: open the saves of the master and its slaves, as folders or zips.</li>
          <li><b>Overview</b> says whether something needs attention; <b>Findings</b> lists what the rules found.</li>
          <li><b>Players</b>, <b>Markets</b>, <b>Bank accounts</b> and <b>Item flow</b> show what happened and who gained.
            Picking an incident in the top bar narrows every screen to its players and accounts.</li>
          <li><b>Case and report</b> works out what to take back, prints the commands for the admins and exports the report.</li>
        </ol>
        <p class="small">It only reads: it works on copies, never writes into a save and never connects to a server.
          Source and releases: <span class="url">github.com/KROIA/BS_SM_AuditTool</span></p>
      </div>
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
          <Saves tab={route[1] ?? null} mark={route[2] ? decodeURIComponent(route[2]) : null} />
        {:else if screen.id === 'overview'}
          <Overview />
        {:else if screen.id === 'players'}
          <Players selected={route[1] ? decodeURIComponent(route[1]) : null} />
        {:else if screen.id === 'accounts'}
          <Accounts selected={route[1] ? Number(route[1]) : null} />
        {:else if screen.id === 'markets'}
          <Markets selected={route[1] ? Number(route[1]) : null} />
        {:else if screen.id === 'findings'}
          <Findings selected={route[1] ? decodeURIComponent(route[1]) : null} />
        {:else if screen.id === 'flow'}
          <Flow selected={route[1] ? decodeURIComponent(route[1]) : null} />
        {:else if screen.id === 'case'}
          <Case selected={route[1] ? decodeURIComponent(route[1]) : null} />
        {/if}
      </div>
    </main>
  </div>
</div>

<style>
  .info { position-area: bottom span-left; position-anchor: --info; inset: auto; margin: 6px 0 0; width: 440px; max-height: 80vh; overflow-y: auto; padding: 16px 20px;
    box-sizing: border-box; border-radius: 12px; background: var(--card); color: var(--text); border: 1px solid var(--line2); box-shadow: 0 12px 32px rgb(0 0 0 / 0.35); font-size: 14px; line-height: 1.5; }
  .info h2 { margin: 0 0 8px; font-family: var(--font-head); font-size: 16px; }
  .info h2 .small { margin-left: 6px; font-weight: 400; }
  .info p, .info ol { margin: 0 0 10px; }
  .info ol { padding-left: 20px; }
  .info .url { user-select: text; color: var(--accent); }
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
