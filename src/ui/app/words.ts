// Items and bank log rows in plain words, for every screen that shows them.
import type { ItemRow, LedgerRow } from '../../shared/api.ts';
import { items as quantity, money } from '../../shared/fmt.ts';

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

export const tone = (raw: bigint) => (raw > 0n ? 'var(--up)' : raw < 0n ? 'var(--down)' : 'var(--text)');

/** The words for the items of the loaded save. */
export function words(itemRows: Map<number, ItemRow>) {
  /** "minecraft:iron_ingot" -> "Iron ingot" */
  function itemName(id: number): string {
    const name = itemRows.get(id)?.name;
    if (!name) return 'Item ' + id;
    const base = name.slice(name.indexOf(':') + 1).replaceAll('_', ' ');
    return base.charAt(0).toUpperCase() + base.slice(1);
  }
  const isMoney = (id: number) => itemRows.get(id)?.money ?? false;
  /** A balance or a change of any item: money as money, other items as a count with their name. */
  const value = (item: number, raw: bigint) => (isMoney(item) ? money(raw) : quantity(raw) + ' ' + itemName(item));
  const change = (item: number, raw: bigint) => (raw > 0n ? '+' : '') + value(item, raw);
  return {
    itemName, isMoney, value, change,
    what: (r: LedgerRow) =>
      r.kind === 'TRADE_BUY' || r.kind === 'TRADE_SELL'
        ? `${r.kind === 'TRADE_BUY' ? 'Bought' : 'Sold'} ${quantity(r.amount < 0n ? -r.amount : r.amount)} ${itemName(r.item)}`
        : (KIND[r.kind] ?? r.kind),
    /** A row's amount: the money side of a trade, else its change; the stored amount when the direction is unknown. */
    amount: (r: LedgerRow) => (r.money ? change(r.money.item, r.money.change) : r.change === null ? quantity(r.amount) : change(r.item, r.change)),
    amountTone: (r: LedgerRow) => {
      const v = r.money?.change ?? r.change;
      return v === null ? 'var(--text3)' : tone(v);
    },
  };
}
