import { Chart, type AccountType, type LedgerAccount } from '../src/ledger.ts';

/** A small chart for unit tests: B0-style accounts, a card, a loan, a few categories and the system accounts. */
export function testChart(): Chart {
  const account = (id: string, type: AccountType, options: Partial<LedgerAccount> = {}): LedgerAccount => {
    const liability = type === 'card' || type === 'loan';
    const cls = liability ? 'liability' : type === 'investment' ? 'investment' : type === 'lent' ? 'other_asset' : 'cash';
    return {
      id,
      name: id,
      kind: liability ? 'liability' : 'asset',
      account: {
        class: cls,
        type,
        spendable: cls === 'cash' && type !== 'savings',
        cardReserve: type === 'card',
        openingDate: '2026-03-01',
      },
      ...options,
    };
  };
  return new Chart([
    { id: 'OBE', kind: 'equity', name: 'OBE', systemCode: 'OBE' },
    { id: 'ADJ', kind: 'equity', name: 'ADJ', systemCode: 'ADJ' },
    { id: 'VAL', kind: 'equity', name: 'VAL', systemCode: 'VAL' },
    { id: 'CNV', kind: 'equity', name: 'CNV', systemCode: 'CNV' },
    account('Current', 'current'),
    account('Cash', 'cash'),
    account('Savings', 'savings'),
    account('Card', 'card'),
    account('Loan', 'loan'),
    account('Broker', 'investment'),
    account('Closed', 'current', { archived: true }),
    { id: 'Food', kind: 'expense', name: 'Food', category: {} },
    { id: 'Fees', kind: 'expense', name: 'Fees', category: {} },
    { id: 'Salary', kind: 'income', name: 'Salary', category: {} },
    { id: 'Old category', kind: 'expense', name: 'Old category', category: {}, archived: true },
  ]);
}

export const TODAY = '2026-03-31';
