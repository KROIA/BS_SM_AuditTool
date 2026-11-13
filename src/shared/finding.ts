// A finding in plain words (DESIGN_SPEC 8.2): its title, summary, facts and rule, for the Findings screen and the report.
// Every number goes through fmt.ts. The facts each rule fills are listed in engine/query/findings.ts.
import type { Finding, Rating, RuleId, RuleSettings } from './api.ts';
import { count, items, money, moneyShort, percent, time } from './fmt.ts';

/** What the screens know about items: the name ("Diamond") and whether it is money. */
export interface ItemWords { itemName: (id: number) => string; isMoney: (id: number) => boolean }

/** The bank log's kinds in words. */
export const KIND: Record<string, string> = {
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

export const RULE_NAME: Record<RuleId, string> = {
  'round-trip': 'Quick round trip', 'order-rate': 'Order rate', 'hour-profit': 'Profit per hour', 'far-price': 'Price far from usual',
  'price-spike': 'Price spike', 'balance': 'Balance not explained', 'order-ledger': 'Order and bank log disagree', 'bank-flag': 'Bank mod flag',
  'last-save': 'Log rows after the last bank save', 'market-alert': 'StockMarket alert', 'transfer': 'Cross-server transfer', 'banknotes': 'Banknote count',
};

/** A factor or a number of seconds with up to two decimals: 2, 3.07 */
export const times = (v: number) => items(BigInt(Math.round(v * 100)));

/** The rule with its thresholds in one sentence. */
export function ruleText(rule: RuleId, s: RuleSettings): string {
  switch (rule) {
    case 'round-trip': return `Flags a buy followed by a sale on the same market at more than ${times(s[rule].times)} times the price within ${count(s[rule].seconds)} seconds, when no other player traded on that market in between.`;
    case 'order-rate': return `Flags more than ${count(s[rule].orders)} orders by one player inside one second.`;
    case 'hour-profit': return `Flags a player whose realised trading profit inside one clock hour is above ${money(s[rule].money)}.`;
    case 'far-price': return `Flags an order whose price is more than ${times(s[rule].times)} times above or below the market's usual price.`;
    case 'price-spike': return `Flags a one-minute candle whose high is more than ${times(s[rule].times)} times its low. Candles at the price floor are skipped: from there any move is a huge multiple.`;
    case 'balance': return `Compares each change between two balance snapshots with the trades and log entries in that time, and flags a difference above ${money(s[rule].money)}, or ${items(s[rule].items)} for other items.`;
    case 'order-ledger': return 'Flags an order whose rows in the bank log do not add up to its volume, or that has no row at all.';
    case 'bank-flag': return 'Shows the flags the bank mod raised itself on the server, with the thresholds the server used.';
    case 'last-save': return 'Flags log rows newer than the bank\'s last save: if the server crashed before the next save, what they did may have been undone.';
    case 'market-alert': return 'Shows the alerts the market mod raised itself on the server: a large profit within a time window, and the two pump-and-dump patterns, with the thresholds the server used then.';
    case 'transfer': return 'Pairs each transfer between the master and a slave by its id, and flags one that was lost, arrived twice, came from nothing, or was left for an admin.';
    case 'banknotes': return `Compares the money in banknotes the bank handed out and did not get back with the notes found in the players' inventories and ender chests, and flags a difference above ${money(s[rule].money)}. Notes in chests and other blocks are not counted until the region scan has run.`;
  }
}

/** How much a gap of the check per account says, by its rating (DESIGN_SPEC 8.4). */
export const GAP_SAYS: Record<Rating, { short: string; why: string }> = {
  low: { short: 'Little: old save', why: 'This save was written by BankSystem 2.1.2, which did not log trades or admin actions, so gaps like this are expected there.' },
  medium: { short: 'Some: the log has known holes',
    why: 'In the mod version this server ran, several paths still change a balance without a log entry, such as an admin setting a balance by hand, so this may be one of them.' },
  high: { short: 'Much: the log is complete',
    why: 'From this point on the bank logs nearly every change, so this points to tampering or a bug. Merged player aliases and changes on an external currency mod\'s side are the remaining harmless causes.' },
};

export const SOURCE: Record<Finding['source'], string> = { 'tool': 'Found by this tool', 'bank mod': 'Raised by the bank mod on the server', 'market mod': 'Raised by the market mod on the server' };
export function basis(f: Finding): string {
  if (f.rule === 'balance') return 'Amount proven, cause is a guess';
  return { 'proven': 'Proven from the data', 'estimate': 'Estimate', 'hint': 'A hint, not proof', 'as raised': 'As the mod raised it' }[f.basis];
}

/** Who a finding is about, for the list: up to three names, else the market or the account. */
export function about(f: Finding, w: ItemWords): string {
  if (f.rule !== 'price-spike' && f.players.length) return f.players.length <= 3 ? f.players.map((p) => p.name).join(', ') : `${count(f.players.length)} players`;
  if (f.markets.length) return f.markets.length === 1 ? `${w.itemName(f.markets[0]!)} market` : `${count(f.markets.length)} markets`;
  if (f.accounts.length) return f.accounts.length === 1 ? `Account ${f.accounts[0]}` : `${count(f.accounts.length)} accounts`;
  return 'The bank';
}

/** When: one moment, or from to (the end without its date when it is the same day). */
export function span(start: number, end: number): string {
  const [a, b] = [time(start), time(end)];
  if (end <= start || a === b) return a;
  return a.split(', ')[0] === b.split(', ')[0] ? `${a} to ${b.split(', ')[1]}` : `${a} to ${b}`;
}

const FLAG: Record<number, string> = {
  1: 'Banknotes from someone else', 2: 'Large banknote withdrawal', 3: 'Wealth jump', 4: 'Transfer to a new account', 5: 'Money supply growth',
  6: 'Transfer parked', 7: 'External binding suspended', 8: 'More shares than issued', 9: 'Shares created',
};
/** The bank mod's rule for a flag type, with the server's thresholds (whole money units in its settings.json). */
export function flagRule(type: number, bank: Record<string, number | boolean>): string {
  const m = (key: string) => (typeof bank[key] === 'number' ? money(BigInt(Math.round((bank[key] as number) * 100))) : 'the server\'s amount');
  const n = (key: string) => (typeof bank[key] === 'number' ? times(bank[key] as number) : '?');
  switch (type) {
    case 1: return `A rule of the bank mod: a banknote deposit of ${m('LAUNDERING_MIN_AMOUNT')} or more by a player whose own withdrawals in the ${n('LAUNDERING_WINDOW_HOURS')} hours before were smaller.`;
    case 2: return `A rule of the bank mod: banknote withdrawals by one player that add up to ${m('LARGE_NOTE_WITHDRAWAL_AMOUNT')} or more in one burst.`;
    case 3: return `A rule of the bank mod: wealth that grows by more than ${m('WEALTH_JUMP_AMOUNT')} and more than ${n('WEALTH_JUMP_PERCENT')}% within one hour.`;
    case 4: return `A rule of the bank mod: a transfer, payout or dividend of ${m('NEW_ACCOUNT_TRANSFER_AMOUNT')} or more to an account younger than ${n('NEW_ACCOUNT_AGE_HOURS')} hours.`;
    case 5: return `A rule of the bank mod: all money in the bank grows by ${n('MONEY_SUPPLY_GROWTH_PERCENT')}% and ${m('MONEY_SUPPLY_GROWTH_AMOUNT')} against a snapshot at least one hour old.`;
    case 6: return 'A rule of the bank mod: money handed out to a slave server whose outcome the master does not know.';
    case 7: return 'A rule of the bank mod: a binding to an external account was suspended at start-up.';
    case 8: return 'A rule of the bank mod: more shares deposited than the company issued.';
    case 9: return 'A rule of the bank mod: shares made by /give or in creative mode.';
    default: return `A rule of the bank mod that this version of the tool does not know (type ${type}).`;
  }
}

const ALERT: Record<string, string> = { profit: 'Profit alert', pump_dump_pump: 'Pump and dump: price pushed up', pump_dump_cycle: 'Pump and dump: bought and sold again' };
const minutes = (ms: unknown) => (typeof ms === 'number' ? `${count(Math.round(ms / 60_000))} minutes` : 'its time window');
/** The market mod's rule behind an alert, with the threshold the row says the server used then. */
export function alertRule(f: Finding): string {
  const x = f.facts, limit = typeof x.threshold === 'number' ? x.threshold : null;
  const m = limit === null ? "the server's amount" : money(BigInt(Math.round(limit * 100)));
  switch (x.kind) {
    case 'profit': return `A rule of the market mod: a player's trading cash flow over all markets above ${m} within ${minutes(x.windowMs)}. Selling items bought before the window counts as profit.`;
    case 'pump_dump_cycle': return `A rule of the market mod: buying on one market and selling it again within ${minutes(x.windowMs)} for more than ${m} profit.`;
    case 'pump_dump_pump': return `A rule of the market mod: a market buy in a moment the price rose by more than ${limit === null ? "the server's percent" : percent(limit)}, while the same player had sell orders waiting above the price.`;
    default: return 'A rule of the market mod that this version of the tool does not know.';
  }
}

export interface FindingWords {
  title: string;
  summary: string;
  facts: [string, string][];
  /** The rule's name: for a bank flag the flag's. */
  rule: string;
  measured: string;
}

/** Title, summary, facts and measured value of a finding. */
export function describe(f: Finding, w: ItemWords): FindingWords {
  const x = f.facts;
  const b = (k: string) => (typeof x[k] === 'bigint' ? x[k] : BigInt(Number(x[k] ?? 0)));
  const n = (k: string) => Number(x[k] ?? 0);
  const item = (id: number | undefined) => (id === undefined ? 'item' : w.itemName(id).toLowerCase());
  const market = item(f.markets[0]);
  const who = f.players.map((p) => p.name).join(' and ') || 'A player';
  const value = (id: number, raw: bigint) => (w.isMoney(id) ? money(raw) : `${items(raw)} ${item(id)}`);
  const v = f.measured.value;
  const plural = (k: number, one: string, many: string) => `${count(k)} ${k === 1 ? one : many}`;

  switch (f.rule) {
    case 'round-trip': return {
      rule: RULE_NAME[f.rule], measured: `${times(v as number)} times the price, ${times(n('seconds'))} seconds apart`,
      title: `Bought and sold again at ${times(v as number)} times the price within ${times(n('seconds'))} seconds`,
      summary: `${who} bought ${items(b('bought'))} ${market} at ${money(b('buyPrice'))} and sold ${items(b('sold'))} ${times(n('seconds'))} seconds later at ${money(b('sellPrice'))}. `
        + 'No other player traded on this market in between, so only the market\'s own price bot can have moved the price.'
        + (n('rounds') > 1 ? ` The same pattern shows ${count(n('rounds'))} times.` : ''),
      facts: [['Bought', `${items(b('bought'))} at ${money(b('buyPrice'))}`], ['Sold', `${items(b('sold'))} at ${money(b('sellPrice'))}`],
        ['Time between', `${times(n('seconds'))} seconds`], ['Profit from this round', money(b('profit'))], ['Rounds like this', count(n('rounds'))]],
    };
    case 'order-rate': {
      const gap = n('medianGapMs');
      return {
        rule: RULE_NAME[f.rule], measured: `${plural(v as number, 'order', 'orders')} in one second`,
        title: `${count(n('orders'))} orders with ${count(gap)} ms between them`,
        summary: `${who} placed ${plural(n('orders'), 'order', 'orders')} with typically ${count(gap)} ms between them, up to ${count(n('busiestSecond'))} inside one second. `
          + (gap < 50 ? 'One game tick lasts 50 ms, so several orders arrived inside every tick. Nobody clicks this fast: this points to a script or a changed game client.'
            : 'That is faster than a person usually clicks.'),
        facts: [['Orders', count(n('orders'))], ['Typical gap', `${count(gap)} ms`], ['Busiest second', plural(n('busiestSecond'), 'order', 'orders')],
          ['Markets', f.markets.map((m) => w.itemName(m)).join(', ') || 'none']],
      };
    }
    case 'hour-profit': return {
      rule: RULE_NAME[f.rule], measured: `${money(v as bigint)} in one hour`,
      title: `${moneyShort(b('profit'))} trading profit within one hour`,
      summary: `${who} made ${money(b('profit'))} of realised trading profit in the hour from ${time(n('hour'))}. All other players together made ${money(b('others'))} in that hour.`
        + (n('hours') > 1 ? ` ${count(n('hours'))} hours close together were above the threshold, ${money(b('total'))} in all.` : ''),
      facts: [['Profit in that hour', money(b('profit'))], ['All other players that hour', money(b('others'))], ['Hours above the threshold', count(n('hours'))],
        ['Profit in those hours', money(b('total'))]],
    };
    case 'far-price': {
      const above = b('price') > b('usual'), side = above ? 'above' : 'below';
      return {
        rule: RULE_NAME[f.rule], measured: `${times(v as number)} times ${side} the usual price`,
        title: `${n('orders') === 1 ? 'An order' : `${count(n('orders'))} orders`} at up to ${times(v as number)} times ${side} the usual price`,
        summary: `${who} placed ${plural(n('orders'), 'order', 'orders')} on the ${market} market at prices far from its usual price of ${money(b('usual'))}. `
          + `The furthest was at ${money(b('price'))}, ${times(v as number)} times ${side} it.`,
        facts: [['Usual price', money(b('usual'))], ['Furthest price', money(b('price'))], ['Orders', count(n('orders'))]],
      };
    }
    case 'price-spike': {
      const traders = f.players.map((p) => p.name);
      return {
        rule: RULE_NAME[f.rule], measured: `${times(v as number)} times from low to high`,
        title: `The ${market} price swung between ${money(b('low'))} and ${money(b('high'))} inside one minute`,
        summary: `In the minute from ${time(n('time'))} the ${market} price moved between ${money(b('low'))} and ${money(b('high'))}`
          + (x.usual === null ? '. ' : `; its usual price is ${money(b('usual'))}. `)
          + (n('minutes') > 1 ? `${count(n('minutes'))} minutes close together swung like this. ` : '')
          + (traders.length ? `${traders.length <= 3 ? traders.join(', ') : `${count(traders.length)} players`} traded on this market at the time. They are named, not blamed: the price bot moves prices too.`
            : 'No player order falls into these minutes.'),
        facts: [['Lowest price', money(b('low'))], ['Highest price', money(b('high'))], ['Usual price', x.usual === null ? 'unknown' : money(b('usual'))],
          ['Minutes', count(n('minutes'))]],
      };
    }
    case 'balance': {
      const id = n('item'), diff = b('difference'), rose = diff > 0n, size = rose ? diff : -diff;
      const short = w.isMoney(id) ? moneyShort(size) : `${items(size)} ${item(id)}`;
      const labels = (x.labels as string[] | null) ?? [];
      const why = GAP_SAYS[String(x.rating) as Rating]?.why ?? '';
      return {
        rule: RULE_NAME[f.rule], measured: `${value(id, size)} not explained`,
        title: `A balance ${rose ? 'rose' : 'fell'} by ${short} and the log has no entry for it`,
        summary: `Between the snapshots of ${time(f.start)} and ${time(f.end)}, account ${f.accounts[0]} ${rose ? 'gained' : 'lost'} ${value(id, size)} more than its trades and log entries explain. ${why}`
          + (labels.length ? ` The gap holds rows the log gives no direction for: ${labels.map((k) => (KIND[k] ?? k).toLowerCase()).join(', ')}.` : ''),
        facts: [['Account', String(f.accounts[0] ?? '')], ['Not explained', (rose ? '+' : '-') + value(id, size)],
          ['How much this says', GAP_SAYS[String(x.rating) as Rating]?.short ?? String(x.rating)]],
      };
    }
    case 'order-ledger': {
      const logged = b('logged');
      return {
        rule: RULE_NAME[f.rule], measured: `${items(v as bigint)} ${market} apart`,
        title: n('orders') === 1 ? 'An order and the bank log disagree' : `${count(n('orders'))} orders and the bank log disagree`,
        summary: `The order furthest off filled ${items(b('volume'))} ${market}, ${logged === 0n ? 'and the bank log has no row for it' : `and the bank log has ${items(logged)} for it`}. `
          + 'Either the bank did not write the trade, or its rows were lost.',
        facts: [['Orders', count(n('orders'))], ['Filled (furthest off)', `${items(b('volume'))} ${market}`], ['In the bank log', `${items(logged)} ${market}`]],
      };
    }
    case 'bank-flag': {
      const type = n('flagType'), amount = b('amount');
      const shown = f.measured.unit === 'money' ? money(amount) : `${items(amount)} ${f.measured.unit}`;
      const short = f.measured.unit === 'money' ? moneyShort(amount) : shown;
      const title: Record<number, string> = {
        1: `Paid in ${short} of banknotes this player did not withdraw`, 2: `${short} withdrawn as banknotes in one burst`, 3: `Wealth grew by ${short} within one hour`,
        4: `${short} paid into an account younger than a day`, 5: `The money in the bank grew by ${short}`, 6: 'A transfer to a slave server with an unknown outcome',
        7: 'A binding to an external account was suspended', 8: `${shown} more than the company issued`, 9: `${shown} made outside the game's rules`,
      };
      return {
        rule: FLAG[type] ?? `Bank flag type ${type}`, measured: shown + (f.measured.threshold === null ? '' : `, the server's limit is ${money(f.measured.threshold as bigint)}`),
        title: title[type] ?? `A flag of type ${type} by the bank mod`,
        summary: 'The bank mod raised this itself while the server was running.'
          + (x.origin === 'audit log' ? ` The database lost its row; only the bank's audit log still has it${x.approximateTime ? ', and its time may be off by whole hours' : ''}.` : '')
          + (f.acknowledged ? ' An admin has acknowledged it.' : ''),
        facts: [['Flag', FLAG[type] ?? `type ${type}`], ['Amount', shown], ...(x.ref ? [['Reference', String(x.ref)] as [string, string]] : []),
          ...(x.details ? [['Details', String(x.details)] as [string, string]] : []), ['Acknowledged', f.acknowledged === null ? 'unknown' : f.acknowledged ? 'yes' : 'no']],
      };
    }
    case 'market-alert': {
      const kind = String(x.kind), limit = f.measured.threshold, amount = b('amount');
      const raised = 'The market mod raised this itself while the server was running.';
      const facts: [string, string][] = [['Alert', ALERT[kind] ?? `kind ${kind}`], ['Orders behind it', count(f.records.orders.length)]];
      const log: [string, string][] = x.text ? [['Server log line', String(x.text)]] : [];
      if (kind === 'pump_dump_pump') {
        const pct = typeof x.percent === 'number' ? x.percent : null;
        return {
          rule: ALERT[kind]!, facts: [...facts, ['Price rise', `${money(amount)} per item`], ["That minute's opening price", x.open === null || x.open === undefined ? 'no price recorded' : money(b('open'))], ...log],
          measured: pct === null ? `a rise of ${money(amount)} per item; without a price for that minute the percent is unknown`
            : `a rise of ${percent(pct)}` + (limit === null ? '' : `, the server's limit is ${percent(limit as number)}`),
          title: `Bought ${market} while the price rose ${pct === null ? `by ${money(amount)}` : percent(pct)}, with own sell orders waiting above`,
          summary: `${raised} ${who} bought ${market} at market price in a moment the price jumped ${pct === null ? `by ${money(amount)} per item` : `about ${percent(pct)}`}, while ${f.players.length > 1 ? 'they' : 'the same player'} had sell orders waiting above the old price. `
            + "Pushing the price up into one's own sell orders is the first half of a pump and dump."
            + (pct === null ? '' : ' The percent is measured against the opening price of that minute; the mod measured it against the price just before.'),
        };
      }
      const short = moneyShort(amount);
      const over = limit === null ? '' : `, above the server's limit of ${money(limit as bigint)}`;
      if (kind === 'profit') return {
        rule: ALERT[kind]!, facts: [...facts, ['Profit', money(amount)], ['Time window', minutes(x.windowMs)], ...log],
        measured: money(amount) + (limit === null ? '' : `, the server's limit is ${money(limit as bigint)}`),
        title: `${short} trading profit within ${minutes(x.windowMs)}`,
        summary: `${raised} ${who} took in ${money(amount)} more than ${f.players.length > 1 ? 'they' : 'the player'} paid, over all markets, within ${minutes(x.windowMs)}${over}. `
          + 'The mod counts cash: selling items bought before the window counts as profit too.',
      };
      if (kind === 'pump_dump_cycle') return {
        rule: ALERT[kind]!, facts: [...facts, ['Profit', money(amount)], ['Time window', minutes(x.windowMs)], ...log],
        measured: money(amount) + (limit === null ? '' : `, the server's limit is ${money(limit as bigint)}`),
        title: `Bought and sold ${market} again within ${minutes(x.windowMs)} for ${short} profit`,
        summary: `${raised} ${who} bought ${market} and sold it again within ${minutes(x.windowMs)} for ${money(amount)} profit${over}. The mod calls this a pump-and-dump cycle.`,
      };
      return { rule: RULE_NAME[f.rule], facts: [...facts, ...log], measured: money(amount), title: 'An alert of the market mod', summary: `${raised} ${x.text ? String(x.text) : ''}`.trim() };
    }
    case 'last-save': return {
      rule: RULE_NAME[f.rule], measured: plural(n('rows'), 'row', 'rows'),
      title: `${plural(n('rows'), 'log row', 'log rows')} after the bank last saved`,
      summary: `The bank last saved its data at ${time(n('lastSave'))}, and ${plural(n('rows'), 'log row is', 'log rows are')} newer than that. `
        + 'If the server crashed before the next save, what these rows did may have been undone while the rows stay. Check the accounts they name.',
      facts: [['Bank last saved', time(n('lastSave'))], ['Rows after it', count(n('rows'))], ['Accounts', count(f.accounts.length)]],
    };
    case 'transfer': {
      const id = typeof x.item === 'number' ? x.item : null; // null: money
      const unit = (raw: bigint) => (id === null ? money(raw) : value(id, raw));
      const size = unit(v as bigint), short = id === null ? moneyShort(v as bigint) : size;
      const others = n('itemsOff') - 1;
      const where = f.servers[0] ? `the slave "${f.servers[0]}"` : 'a slave';
      const title: Record<string, string> = {
        lost: `${short} sent between servers did not arrive`, twice: `${short} more arrived than was sent between servers`,
        created: `${short} arrived from another server that no server sent`, parked: `A transfer of ${short} between servers was left for an admin`,
      };
      return {
        rule: RULE_NAME[f.rule], measured: `${size} ${x.class === 'twice' || x.class === 'created' ? 'too much' : 'missing'}`,
        title: title[String(x.class)] ?? RULE_NAME[f.rule],
        summary: `${x.direction === 'FROM_MASTER' ? `From the master to ${where}` : x.direction === 'TO_MASTER' ? `From ${where} to the master` : `Between the master and ${where}`}: `
          + `${unit(b('sent'))} was sent and ${unit(b('received'))} arrived. ${String(x.why ?? '')}`
          + (others > 0 ? ` ${plural(others, 'other item differs', 'other items differ')} too.` : ''),
        facts: [['Transfer id', String(x.transferId)], ['Sent', unit(b('sent'))], ['Arrived', unit(b('received'))],
          ['Journal steps', ((x.steps as string[] | null) ?? []).join(', ') || 'none'], ['Bank log rows', count(f.records.ledger.length)]],
      };
    }
    case 'banknotes': {
      const diff = b('difference'), more = diff > 0n, size = moneyShort(v as bigint);
      const names = (k: string) => (x[k] as string[] | null) ?? [];
      const listed = (l: string[]) => (l.length <= 5 ? l.join(', ') : `${l.slice(0, 5).join(', ')} and ${count(l.length - 5)} more`);
      const missing = names('missing'), without = names('without');
      const files = n('scanFiles'), total = n('scanFilesTotal'), unread = n('chunksUnread'), lz4 = n('lz4'), filesUnread = n('filesUnread');
      // What was looked at follows the region scan's coverage (DESIGN_SPEC 8.7).
      const looked = {
        'complete': 'Looked at: player files, ender chests and every region file (chests and other blocks, dropped items and other entities).',
        'partial': `Looked at: player files, ender chests and ${count(files)} of ${count(total)} region files; the region scan was stopped or the world changed since, so notes in the rest of the world are not counted.`,
        'no region files': 'Looked at: player files and ender chests only; the loaded saves have no region files, so notes in chests and other blocks are not counted.',
      }[String(x.scan)] ?? 'Looked at: player files and ender chests only; the region scan has not been run, so notes in chests and other blocks are not counted.';
      const unreadable = (unread ? ` ${plural(unread, 'chunk', 'chunks')} could not be read${lz4 ? ` (${count(lz4)} packed with LZ4, which the tool does not read)` : ''}` : '')
        + (filesUnread ? `${unread ? ' and' : ''} ${plural(filesUnread, 'region file', 'region files')} not at all` : '');
      // Money that appeared on accounts without a log row could be notes paid back through the ATM converter (2.1.2 logged none).
      const back = b('appeared') < (v as bigint) ? b('appeared') : (v as bigint);
      return {
        rule: RULE_NAME[f.rule], measured: `${money(v as bigint)} ${more ? 'more' : 'fewer'} found than expected`,
        title: more ? `${size} more in banknotes found than the bank handed out` : `${size} of banknotes the bank handed out were not found`,
        summary: `The bank's log says ${money(b('outstanding'))} in banknotes should be outside the bank; ${money(b('found'))} was found. ` + looked
          + (unreadable ? `${unreadable}; what they hold is not counted.` : '')
          + (!more && back > 0n ? ` Of the ${money(v as bigint)} not found, ${back === v ? 'all' : `up to ${money(back)}`} may have been paid back through the ATM converter: that much appeared on accounts without a log row.` : '')
          + (b('offers') ? ` Villagers' offers name ${money(b('offers'))} in notes; those are prices, not notes, and are not counted.` : '')
          + (missing.length ? ` ${plural(missing.length, 'player who traded or used the bank has', 'players who traded or used the bank have')} no readable player file: ${listed(missing)}.` : '')
          + (n('unnamed') ? ` ${plural(n('unnamed'), 'other id that placed orders or used the bank has', 'other ids that placed orders or used the bank have')} no player file and no name in the save; they may never have joined.` : '')
          + (without.length ? ` ${without.length === 1 ? 'The save' : 'The saves'} ${listed(without.map((s) => `"${s}"`))} ${without.length === 1 ? 'has' : 'have'} no player files.` : '')
          + (more ? ' More notes than were handed out points to notes made outside the bank.' : ''),
        facts: [['Should be outside the bank', money(b('outstanding'))], ['Found in inventories', money(b('inventory'))], ['Found in ender chests', money(b('enderChest'))],
          ['Found in blocks and entities', x.scan === 'complete' || x.scan === 'partial' ? money(b('blocks')) : 'region scan not run'],
          ['Region scan', x.scan === 'partial' ? `${count(files)} of ${count(total)} files` : x.scan === 'complete' ? 'complete' : String(x.scan ?? 'not run')],
          ['Difference', (more ? '+' : '-') + money(v as bigint)], ...(b('putBack') ? [['Taken off for 2.1.2 put-backs', money(b('putBack'))] as [string, string]] : []),
          ...(!more && back > 0n ? [['Could be notes paid back through the converter', money(back)] as [string, string]] : []),
          ['Players without a file', missing.length ? listed(missing) : 'none']],
      };
    }
    default: return { rule: RULE_NAME[f.rule], measured: count(v), title: RULE_NAME[f.rule], summary: '', facts: [] };
  }
}
