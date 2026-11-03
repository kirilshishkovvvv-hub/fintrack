'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatMoney } from '@/lib/money';
import type { Account, Category, Transaction } from '@/lib/use-api';

/** The effect on the user's own accounts, read from the server's postings. A transfer shows the amount moved. */
export function ownEffect(tx: Transaction, accounts: Map<string, Account>): number {
  const own = tx.lines.filter((line) => accounts.has(line.ledgerAccountId));
  return tx.kind === 'transfer' ? Math.max(...own.map((line) => line.amount_minor)) : own.reduce((sum, line) => sum + line.amount_minor, 0);
}

export function signedMoney(tx: Transaction, accounts: Map<string, Account>, currency: string): string {
  const net = ownEffect(tx, accounts);
  return tx.kind === 'transfer' ? formatMoney(net, currency) : `${net < 0 ? '−' : '+'}${formatMoney(Math.abs(net), currency)}`;
}

/**
 * One transaction as a list row, linking to its detail. The sign and arrow are shown as well
 * as the colour; a voided transaction stays visible, struck through and labelled (FR-19).
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
  const net = ownEffect(tx, accounts);
  const accountNames = own.map((line) => accounts.get(line.ledgerAccountId)?.name).filter(Boolean).join(' → ');
  const title = tx.description ?? category?.name ?? t(`kinds.${tx.kind}`);
  const detail = [tx.date, tx.description && category ? category.name : null, accountNames].filter(Boolean).join(' · ');
  const direction = isTransfer ? '' : net < 0 ? 'amount-out' : 'amount-in';
  const voided = tx.status === 'voided';

  return (
    <Link href={`/transactions/${tx.id}`} className={`row row-link${voided ? ' row-voided' : ''}`}>
      <span className="icon-dot" aria-hidden="true">
        {isTransfer ? '⇄' : net < 0 ? '−' : '+'}
      </span>
      <div className="row-main">
        <div className="row-title">
          {title}
          {voided && <span className="badge">{t('voided')}</span>}
        </div>
        <div className="small muted">{detail}</div>
      </div>
      <span className={`amount ${direction}`}>{signedMoney(tx, accounts, currency)}</span>
    </Link>
  );
}
