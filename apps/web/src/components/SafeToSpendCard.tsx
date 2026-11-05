'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { formatDay, formatMoney } from '@/lib/money';
import type { SafeToSpend } from '@/lib/plan';
import { notifyDataChanged } from '@/lib/use-api';

/**
 * The figure, its window and every item behind every term (§7.10, P8). The sign, the wording
 * and the amount all say the same thing, so colour never has to.
 */
export function SafeToSpendCard({ sts, currency }: { sts: SafeToSpend; currency: string }) {
  const t = useTranslations('dashboard');
  const tErrors = useTranslations('errors');
  const locale = useLocale();
  const [error, setError] = useState<string | null>(null);
  const money = (minor: number) => formatMoney(Math.abs(minor), currency, locale);
  const signed = (minor: number) => `${minor < 0 ? '−' : ''}${money(minor)}`;
  const taken = (minor: number) => `${minor > 0 ? '−' : ''}${money(minor)}`;
  const day = (iso: string) => formatDay(iso, locale);
  const negative = sts.value_minor < 0;
  const contributors = [
    ...sts.ucoItems.map((item) => ({ name: item.name, amount: item.amount_minor })),
    ...sts.ugaItems.map((item) => ({ name: item.name, amount: item.amount_minor })),
    ...(sts.protectedReserve_minor > 0 ? [{ name: t('protectedReserve'), amount: sts.protectedReserve_minor }] : []),
  ]
    .filter((item) => item.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 3);
  const daysSinceImport = sts.lastImportAt ? Math.floor((Date.now() - Date.parse(sts.lastImportAt)) / 86_400_000) : null;

  async function link(occurrenceId: string, transactionId: string) {
    setError(null);
    try {
      await api('POST', `/api/v1/occurrences/${occurrenceId}/link`, { idempotencyKey: newIdempotencyKey(), body: { transactionId } });
      notifyDataChanged();
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
    }
  }

  const term = (label: string, amount: string, items: { name: string; amount: string; note?: string | undefined }[]) => (
    <div>
      <div className="row">
        <span>{label}</span>
        <span className="amount">{amount}</span>
      </div>
      {items.map((item, index) => (
        <div className="row row-sub small muted" key={`${item.name}-${index}`}>
          <span>
            {item.name}
            {item.note ? ` · ${item.note}` : ''}
          </span>
          <span className="amount">{item.amount}</span>
        </div>
      ))}
    </div>
  );

  return (
    <section className="card card-hero" aria-labelledby="sts-title">
      <p className="eyebrow" id="sts-title">
        {sts.window.kind === 'payday' ? t('safeUntil', { date: day(sts.window.to) }) : t('safeNext30')}
      </p>
      <p className="hero-amount">{signed(sts.value_minor)}</p>
      {negative ? (
        <p className="small" role="status">
          {sts.window.kind === 'payday' ? t('shortfallUntilPay', { amount: money(sts.value_minor) }) : t('shortfall', { amount: money(sts.value_minor) })}
          {contributors.length > 0 ? ` ${t('largestItems', { items: contributors.map((item) => `${item.name} ${money(item.amount)}`).join(', ') })}` : ''}
        </p>
      ) : (
        sts.perDay_minor !== null && <p className="small">{t('perDay', { amount: money(sts.perDay_minor) })}</p>
      )}
      <p className="small muted">{t('safeToSpendNote')}</p>
      {sts.latePayday.map((item) => (
        <p className="notice notice-warning small" key={item.occurrenceId}>
          {t('latePayday', { name: item.name, date: day(item.dueDate) })}
        </p>
      ))}
      {sts.ugaItems.some((item) => item.type === 'shortfall') && <p className="notice notice-warning small">{t('goalsShort')}</p>}
      {error && (
        <p className="notice notice-error small" role="alert">
          {error}
        </p>
      )}
      {sts.dueOnPayday.map((item) => (
        <p className="notice notice-warning small" key={item.occurrenceId}>
          {t('dueOnPayday', { name: item.name, amount: money(item.amount_minor), date: day(item.dueDate) })}
        </p>
      ))}
      <div>
        {term(t('available'), signed(sts.eligibleFunds_minor), [])}
        {term(t('commitments'), taken(sts.uco_minor), [])}
        {term(t('protectedReserve'), taken(sts.protectedReserve_minor), [])}
        {term(t('goalMoney'), taken(sts.uga_minor), [])}
        <div className="row">
          <strong>{t('safeToSpend')}</strong>
          <strong className="amount">{signed(sts.value_minor)}</strong>
        </div>
      </div>
      <details>
        <summary>{t('howCalculated')}</summary>
        {term(
          t('available'),
          signed(sts.eligibleFunds_minor),
          sts.elfItems.map((item) => ({ name: item.name, amount: signed(item.amount_minor) })),
        )}
        {term(
          t('commitments'),
          taken(sts.uco_minor),
          sts.ucoItems.map((item) => ({
            name: item.type === 'card_reserve' ? t('cardReserveItem', { name: item.name }) : item.name,
            amount: taken(item.amount_minor),
            note: item.type === 'overdue' ? t('overdue') : item.dueDate ? day(item.dueDate) : undefined,
          })),
        )}
        {term(
          t('goalMoney'),
          taken(sts.uga_minor),
          sts.ugaItems.map((item) => ({ name: item.type === 'shortfall' ? t('shortfallOn', { name: item.name }) : item.name, amount: taken(item.amount_minor) })),
        )}
        {(sts.excludedAccounts.length > 0 || sts.expectedIncome.length > 0 || sts.availableCredit_minor > 0) && (
          <p className="small muted" style={{ marginTop: '0.75rem' }}>
            {t('notIncluded')}
          </p>
        )}
        {sts.excludedAccounts.map((account) => (
          <p className="small muted" key={account.accountId}>
            {t('excludedAccount', { name: account.name, amount: signed(account.amount_minor) })}
          </p>
        ))}
        {sts.expectedIncome.map((item) => (
          <p className="small muted" key={item.occurrenceId}>
            {t('expectedIncome', { name: item.name, amount: money(item.amount_minor), date: day(item.dueDate) })}
          </p>
        ))}
        {sts.availableCredit_minor > 0 && <p className="small muted">{t('availableCredit', { amount: money(sts.availableCredit_minor) })}</p>}
        {sts.possibleDoubleCounts.map((item) => (
          <p className="notice notice-warning small" key={item.occurrenceId}>
            {t('possibleDouble', { name: item.name, amount: money(item.amount_minor) })}{' '}
            <button className="btn btn-ghost" type="button" onClick={() => void link(item.occurrenceId, item.transactionId)}>
              {t('linkThem')}
            </button>
          </p>
        ))}
        <p className="small" style={{ marginTop: '0.5rem' }}>
          <Link href="/plan">{t('seePlan')}</Link>
        </p>
      </details>
      {daysSinceImport !== null && <p className="small muted">{t('lastImport', { days: daysSinceImport })}</p>}
    </section>
  );
}
