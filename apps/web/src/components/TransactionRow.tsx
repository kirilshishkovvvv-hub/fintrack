'use client';

import { useTranslations } from 'next-intl';
import { formatMoney } from '@/lib/money';
import type { Account, Category, Transaction } from '@/lib/use-api';

/**
 * One transaction as a list row. The shown amount is the effect on the user's own accounts,
 * read from the server's postings; the sign and arrow are shown as well as the colour.
 */
export function TransactionRow({
  tx,
  accounts,
  categories,
  currency,
}: {
  tx: Transaction;
  accounts: Map<string, Account>;
  categories: Map<string, Category>;
  currency: string;
}) {
  const t = useTranslations('transactions');
  const own = tx.lines.filter((line) => accounts.has(line.ledgerAccountId));
  const category = tx.lines.map((line) => categories.get(line.ledgerAccountId)).find(Boolean);
  const isTransfer = tx.kind === 'transfer';
  const net = isTransfer ? Math.max(...own.map((line) => line.amount_minor)) : own.reduce((sum, line) => sum + line.amount_minor, 0);
  const accountNames = own.map((line) => accounts.get(line.ledgerAccountId)?.name).filter(Boolean).join(' → ');
  const title = category?.name ?? t(`kinds.${tx.kind}`);
  const direction = isTransfer ? '' : net < 0 ? 'amount-out' : 'amount-in';

  return (
    <div className="row">
      <span className="icon-dot" aria-hidden="true">
        {isTransfer ? '⇄' : net < 0 ? '−' : '+'}
      </span>
      <div className="row-main">
        <div className="row-title">{title}</div>
        <div className="small muted">
          {tx.date} · {accountNames}
        </div>
      </div>
      <span className={`amount ${direction}`}>
        {isTransfer ? formatMoney(net, currency) : `${net < 0 ? '−' : '+'}${formatMoney(Math.abs(net), currency)}`}
      </span>
    </div>
  );
}
