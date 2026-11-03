/**
 * Safe to Spend (§7, F3): STS = ELF − UCO − PR − UGA.
 *
 * Stage 3 scope: planned occurrences and goal allocations don't exist yet, so UCO is only
 * the card reserve and UGA is 0. The full window (payday, option (c)), planned outflows,
 * R5 and AM-1 arrive with the planning features in Stage 5. Until then this function
 * refuses inputs it can't handle, rather than returning a wrong number.
 */
import type { IsoDate } from './dates.ts';
import type { Ledger } from './metrics.ts';
import { cents, type Cents } from './money.ts';

export interface SafeToSpendInput {
  ledger: Ledger;
  today: IsoDate;
  protectedReserve?: Cents;
}

export interface SafeToSpendBreakdown {
  /** Eligible liquid funds: balances of spendable accounts, negatives included. */
  elf: Cents;
  /** Σ max(0, owed) over credit cards with the reserve on (§5.5). */
  cardReserve: Cents;
  protectedReserve: Cents;
  value: Cents;
}

export function safeToSpend(input: SafeToSpendInput): SafeToSpendBreakdown {
  const { ledger, today } = input;
  const protectedReserve = input.protectedReserve ?? 0;
  if (protectedReserve < 0) throw new RangeError('The protected reserve cannot be negative');

  let elf = 0;
  let cardReserve = 0;
  for (const account of ledger.chart.all()) {
    const info = account.account;
    if (!info || account.archived) continue;
    if (info.class === 'cash' && info.spendable) {
      elf += ledger.balance(account.id, today);
    }
    if (info.type === 'card' && info.cardReserve) {
      cardReserve += Math.max(0, ledger.balance(account.id, today));
    }
  }

  return {
    elf: cents(elf),
    cardReserve: cents(cardReserve),
    protectedReserve,
    value: cents(elf - cardReserve - protectedReserve),
  };
}
