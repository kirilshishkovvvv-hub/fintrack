'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatMoney } from '@/lib/money';
import type { Account } from '@/lib/use-api';

/** A balance as the user reads it: a debt shows with a minus sign, never by colour alone. */
export function accountBalance(account: Account, currency: string): string {
  const owes = account.class === 'liability' ? account.balance_minor > 0 : account.balance_minor < 0;
  return `${owes ? '−' : ''}${formatMoney(Math.abs(account.balance_minor), currency)}`;
}

export function AccountRow({ account, currency }: { account: Account; currency: string }) {
  const tTypes = useTranslations('accountTypes');
  return (
    <Link href={`/accounts/${account.id}`} className="row row-link">
      <div className="row-main">
        <div className="row-title">{account.name}</div>
        <div className="small muted">{tTypes(account.type)}</div>
      </div>
      <span className="amount">{accountBalance(account, currency)}</span>
    </Link>
  );
}
