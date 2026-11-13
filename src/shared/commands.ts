// The lines an admin runs to take money back, checked against BankSystem's command tree in
// BankSystemCommandsRegistration.java: 2.1.2 (tag 1.21.1-2.1.2) and the current code (2.2.0). The tool runs nothing.
import type { TakeBackRow } from './api.ts';
import { items as quantity, plain } from './fmt.ts';

export type BankVersion = '2.1.2' | '2.2.0';

/**
 * `/money remove <player> <amount>` reads the amount as a 32-bit float (FloatArgumentType) and stores
 * Math.round(amount * 100) (BankManager.convertToRawAmountStatic). A float holds 24 significant bits, so an amount is
 * split into whole-dollar parts of at most 24 bits and a rest below $65'536, which a float still holds to the cent.
 */
export function floatParts(raw: bigint): bigint[] {
  const out: bigint[] = [];
  let dollars = raw / 100n;
  while (dollars >= 65_536n) {
    const shift = BigInt(Math.max(0, dollars.toString(2).length - 24));
    const part = (dollars >> shift) << shift;
    out.push(part * 100n);
    dollars -= part;
  }
  const rest = dollars * 100n + (raw % 100n);
  return rest > 0n ? [...out, rest] : out;
}

/**
 * The money lines. Both versions read them from a player only (getPlayerOrException): an admin runs them in game, not on
 * the server console. `/money remove <name> <amount>` works on the named player's personal account (2.1.2
 * BankSystemCommandsRegistration.java:424-447, 2.2.0 :467-480) and refuses when getRealBalance() (raw / 100, a double)
 * is below the parsed float: 1.23 parses to 1.2300000190734863, so the last part fails on an account that would end at 0.
 * An account that keeps nothing gets `/money set <name> 0` instead (setRealBalance; 2.1.2 registration :399,
 * ServerBankSystemCommandHandler.java:344-354; 2.2.0 registration :442, handler :412-425, logged as ADMIN_SET).
 * 2.2.0 adds `/banksystem freeze <account> on|off` (by number, :204-211), around all the lines, so the accounts cannot
 * move anything while they are worked on.
 */
export function commands(rows: TakeBackRow[], v: BankVersion): string[] {
  const work = rows.filter((r) => r.take > 0n || r.items.length);
  const freeze = (on: boolean) => (v === '2.2.0' ? work.map((r) => `/banksystem freeze ${r.account} ${on ? 'on' : 'off'}`) : []);
  const take = rows.flatMap((r) => (r.take <= 0n ? [] : r.keep === 0n ? [`/money set ${r.player.name} 0`] : floatParts(r.take).map((p) => `/money remove ${r.player.name} ${plain(p)}`)));
  return [...freeze(true), ...take, ...freeze(false)];
}

/** No version has a command that removes items from an account: they are a list to work through in `/bank <player> manage`. */
export const itemList = (rows: TakeBackRow[], itemName: (id: number) => string): string[] =>
  rows.flatMap((r) => r.items.map((i) => `Account ${r.account} (${r.player.name}): ${itemName(i.item)}, remove ${quantity(i.remove)}, leaves ${quantity(i.now - i.remove)}`));
