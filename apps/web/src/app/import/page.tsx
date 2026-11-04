'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { api, errorMessage, newIdempotencyKey, postForm } from '@/lib/api';
import { formatMoney } from '@/lib/money';
import { active, loadAccounts, loadSummary, useApiData } from '@/lib/use-api';

const ENCODINGS = ['utf-8', 'utf-16le', 'windows-1252', 'iso-8859-15', 'windows-1251', 'windows-1253', 'iso-8859-7'];
const DELIMITERS = [';', ',', '\t', '|'];
const DATE_FORMATS = ['YYYY-MM-DD', 'DD.MM.YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY', 'DD.MM.YY', 'DD/MM/YY'];
const FIELDS = ['date', 'amount', 'debit', 'credit', 'description', 'counterparty', 'reference', 'currency'] as const;

type Field = (typeof FIELDS)[number];

interface Settings {
  encoding: string;
  delimiter: string;
  decimalSeparator: string;
  dateFormat: string;
  headerRow: number | null;
  mapping: Partial<Record<Field, number>>;
}

interface Preview {
  settings: Settings;
  columns: string[];
  ready: boolean;
  rowCount: number;
  unreadable: number;
  ignoredLines: number;
  hasCurrencyColumn: boolean;
  sample: { rowNo: number; date: string | null; amount_minor: number | null; description: string; problem: string | null }[];
}

interface Profile extends Settings {
  id: string;
  name: string;
}

interface BatchSummary {
  id: string;
  status: string;
  fileName: string | null;
  rowCount: number;
  createdAt: string;
}

/** Upload, column mapping and preview (FR-16 steps 1 to 6). The file stays in the browser until a batch is made from it. */
function ImportForm() {
  const t = useTranslations('import');
  const tErrors = useTranslations('errors');
  const tApp = useTranslations('app');
  const router = useRouter();
  const wanted = useSearchParams().get('account');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const key = useRef(newIdempotencyKey());
  const { data, failed, reload } = useApiData(async () => {
    const [accounts, summary, profiles, imports] = await Promise.all([
      loadAccounts(),
      loadSummary(),
      api<{ items: Profile[] }>('GET', '/api/v1/import-profiles').then((r) => r.items),
      api<{ items: BatchSummary[] }>('GET', '/api/v1/imports').then((r) => r.items),
    ]);
    return { accounts: active(accounts), currency: summary.currency, profiles, imports };
  });
  if (failed) return <LoadError retry={reload} />;

  async function load(next: File, overrides: Partial<Settings>) {
    setError(null);
    setBusy(true);
    const form = new FormData();
    form.set('file', next);
    form.set('settings', JSON.stringify(overrides));
    try {
      setPreview(await postForm<Preview>('/api/v1/imports/preview', form));
    } catch (problem) {
      setPreview(null);
      setError(errorMessage(problem, tErrors));
    } finally {
      setBusy(false);
    }
  }

  const change = (patch: Partial<Settings>) => {
    if (file && preview) void load(file, { ...preview.settings, ...patch });
  };

  function setColumn(field: Field, value: string) {
    if (!preview) return;
    const mapping = { ...preview.settings.mapping };
    if (value === '') delete mapping[field];
    else mapping[field] = Number(value);
    // One signed column, or debit and credit: not both.
    if (value !== '' && field === 'amount') {
      delete mapping.debit;
      delete mapping.credit;
    }
    if (value !== '' && (field === 'debit' || field === 'credit')) delete mapping.amount;
    change({ mapping });
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !preview?.ready) return;
    const fields = new FormData(event.currentTarget);
    const form = new FormData();
    form.set('file', file);
    form.set('accountId', String(fields.get('account')));
    form.set('settings', JSON.stringify(preview.settings));
    const name = String(fields.get('profile') ?? '').trim();
    if (name) form.set('saveProfileAs', name);
    setBusy(true);
    setError(null);
    try {
      const batch = await postForm<{ id: string }>('/api/v1/imports', form, key.current);
      router.push(`/import/${batch.id}`);
    } catch (problem) {
      key.current = newIdempotencyKey();
      setError(errorMessage(problem, tErrors));
      setBusy(false);
    }
  }

  const amountText = (minor: number | null) => (minor === null || !data ? '—' : `${minor < 0 ? '−' : '+'}${formatMoney(Math.abs(minor), data.currency)}`);

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      <p className="muted">{t('intro')}</p>
      {!data ? (
        <p aria-live="polite">{tApp('loading')}</p>
      ) : data.accounts.length === 0 ? (
        <p className="notice notice-info">
          {t('needAccount')} <Link href="/accounts/new">{t('addAccount')}</Link>
        </p>
      ) : (
        <form className="card" onSubmit={submit}>
          <div className="field">
            <label htmlFor="account">{t('account')}</label>
            <select id="account" name="account" defaultValue={wanted ?? undefined}>
              {data.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="file">{t('file')}</label>
            <input
              id="file"
              type="file"
              accept=".csv,.txt,text/csv"
              onChange={(event) => {
                const next = event.target.files?.[0] ?? null;
                setFile(next);
                setPreview(null);
                if (next) void load(next, {});
              }}
            />
            <span className="hint">{t('fileHint')}</span>
          </div>

          {preview && (
            <>
              {data.profiles.length > 0 && (
                <div className="field">
                  <label htmlFor="saved">{t('savedProfile')}</label>
                  <select
                    id="saved"
                    defaultValue=""
                    onChange={(event) => {
                      const profile = data.profiles.find((candidate) => candidate.id === event.target.value);
                      if (profile) change({ encoding: profile.encoding, delimiter: profile.delimiter, decimalSeparator: profile.decimalSeparator, dateFormat: profile.dateFormat, headerRow: profile.headerRow, mapping: profile.mapping });
                    }}
                  >
                    <option value="">{t('detected')}</option>
                    {data.profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <h2>{t('columns')}</h2>
              <div className="grid-2">
                {FIELDS.map((field) => (
                  <div className="field" key={field}>
                    <label htmlFor={`column-${field}`}>{t(`fields.${field}`)}</label>
                    <select id={`column-${field}`} value={preview.settings.mapping[field] ?? ''} disabled={busy} onChange={(event) => setColumn(field, event.target.value)}>
                      <option value="">{t('notInFile')}</option>
                      {preview.columns.map((column, index) => (
                        <option key={index} value={index}>
                          {column}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              <details>
                <summary>{t('format')}</summary>
                <div className="grid-2" style={{ marginTop: '0.75rem' }}>
                  <div className="field">
                    <label htmlFor="encoding">{t('encoding')}</label>
                    <select id="encoding" value={preview.settings.encoding} disabled={busy} onChange={(event) => file && void load(file, { encoding: event.target.value })}>
                      {ENCODINGS.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="delimiter">{t('delimiter')}</label>
                    <select id="delimiter" value={preview.settings.delimiter} disabled={busy} onChange={(event) => file && void load(file, { encoding: preview.settings.encoding, delimiter: event.target.value })}>
                      {DELIMITERS.map((value) => (
                        <option key={value} value={value}>
                          {value === '\t' ? t('tab') : value}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="dateFormat">{t('dateFormat')}</label>
                    <select id="dateFormat" value={preview.settings.dateFormat} disabled={busy} onChange={(event) => change({ dateFormat: event.target.value })}>
                      {DATE_FORMATS.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="decimal">{t('decimal')}</label>
                    <select id="decimal" value={preview.settings.decimalSeparator} disabled={busy} onChange={(event) => change({ decimalSeparator: event.target.value })}>
                      <option value=",">{t('decimalComma')}</option>
                      <option value=".">{t('decimalDot')}</option>
                    </select>
                  </div>
                </div>
              </details>

              <h2>{t('previewTitle')}</h2>
              {!preview.ready ? (
                <p className="notice notice-warning">{t('mapRequired')}</p>
              ) : (
                <>
                  <p className="small muted" role="status">
                    {t('rowsFound', { rows: preview.rowCount, unreadable: preview.unreadable })}
                    {preview.ignoredLines > 0 ? ` ${t('ignored', { lines: preview.ignoredLines })}` : ''}
                  </p>
                  <div>
                    {preview.sample.map((row) => (
                      <div className="row" key={row.rowNo}>
                        <div className="row-main">
                          <div className="row-title">{row.description || '—'}</div>
                          <div className="small muted">{row.problem ? t(`reasons.${row.problem}`) : row.date}</div>
                        </div>
                        <span className="amount">{amountText(row.amount_minor)}</span>
                      </div>
                    ))}
                  </div>
                  {!preview.hasCurrencyColumn && <p className="small muted">{t('noCurrencyColumn', { currency: data.currency })}</p>}
                </>
              )}

              <div className="field">
                <label htmlFor="profile">{t('saveProfile')}</label>
                <input id="profile" name="profile" type="text" maxLength={100} />
                <span className="hint">{t('saveProfileHint')}</span>
              </div>
              <button className="btn btn-primary" type="submit" disabled={busy || !preview.ready || preview.rowCount === 0}>
                {t('continue')}
              </button>
            </>
          )}
          {error && (
            <p className="notice notice-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}

      {data && data.imports.length > 0 && (
        <section className="card" aria-labelledby="past-title">
          <h2 id="past-title">{t('past')}</h2>
          {data.imports.map((batch) => (
            <Link key={batch.id} href={`/import/${batch.id}`} className="row row-link">
              <div className="row-main">
                <div className="row-title">{batch.fileName ?? t('title')}</div>
                <div className="small muted">
                  {batch.createdAt.slice(0, 10)} · {t('rowCount', { rows: batch.rowCount })}
                </div>
              </div>
              <span className="badge">{t(`statuses.${batch.status}`)}</span>
            </Link>
          ))}
        </section>
      )}
    </AppShell>
  );
}

export default function ImportPage() {
  return (
    <Suspense>
      <ImportForm />
    </Suspense>
  );
}
