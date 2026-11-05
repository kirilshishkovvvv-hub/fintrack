'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { editableAmount } from '@/components/TransactionForm';
import { api, errorMessage } from '@/lib/api';
import { parseUserAmount } from '@/lib/money';
import { notifyDataChanged, useApiData } from '@/lib/use-api';

interface WorkspaceSettings {
  name: string;
  currency: string;
  timezone: string;
  protectedReserve_minor: number;
  stsCountSavingsTransfers: boolean;
  version: number;
  currencyLocked: boolean;
}

/** Workspace settings (Stage 2 §9.2). */
export default function GeneralSettingsPage() {
  const t = useTranslations('general');
  const tApp = useTranslations('app');
  const tErrors = useTranslations('errors');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, failed, reload } = useApiData(() => api<WorkspaceSettings>('GET', '/api/v1/workspace'));
  const zones = useMemo(() => Intl.supportedValuesOf('timeZone'), []);
  if (failed) return <LoadError retry={reload} />;

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data) return;
    const form = new FormData(event.currentTarget);
    const reserve = parseUserAmount(String(form.get('reserve') ?? ''));
    if (reserve === null || reserve < 0) return setError(t('badAmount'));
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api('PATCH', '/api/v1/workspace', {
        ifMatch: data.version,
        body: {
          name: String(form.get('name') ?? '').trim(),
          timezone: String(form.get('timezone')),
          protectedReserve_minor: reserve,
          stsCountSavingsTransfers: form.get('savingsTransfers') === 'on',
          ...(data.currencyLocked ? {} : { currency: String(form.get('currency')) }),
        },
      });
      setNotice(t('saved'));
      notifyDataChanged();
    } catch (problem) {
      setError(errorMessage(problem, tErrors));
      await reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice notice-info" role="status">
          {notice}
        </p>
      )}
      {!data ? (
        <p aria-live="polite">{tApp('loading')}</p>
      ) : (
        <form className="card" onSubmit={save} key={data.version}>
          <div className="field">
            <label htmlFor="name">{t('name')}</label>
            <input id="name" name="name" type="text" maxLength={100} defaultValue={data.name} required />
          </div>
          <div className="field">
            <label htmlFor="reserve">{t('reserve')}</label>
            <input id="reserve" name="reserve" type="text" inputMode="decimal" defaultValue={editableAmount(data.protectedReserve_minor)} aria-describedby="reserve-hint" />
            <span id="reserve-hint" className="hint">
              {t('reserveHint')}
            </span>
          </div>
          <label className="check">
            <input type="checkbox" name="savingsTransfers" defaultChecked={data.stsCountSavingsTransfers} /> <span>{t('savingsTransfers')}</span>
          </label>
          <p className="small muted">{t('savingsTransfersHint')}</p>
          <div className="field">
            <label htmlFor="timezone">{t('timezone')}</label>
            <select id="timezone" name="timezone" defaultValue={data.timezone} aria-describedby="timezone-hint">
              {[...new Set([data.timezone, ...zones])].map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
            <span id="timezone-hint" className="hint">
              {t('timezoneHint')}
            </span>
          </div>
          <div className="field">
            <label htmlFor="currency">{t('currency')}</label>
            <select id="currency" name="currency" defaultValue={data.currency} disabled={data.currencyLocked} aria-describedby={data.currencyLocked ? 'currency-hint' : undefined}>
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
            </select>
            {data.currencyLocked && (
              <span id="currency-hint" className="hint">
                {t('currencyLocked')}
              </span>
            )}
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('save')}
          </button>
        </form>
      )}
    </AppShell>
  );
}
