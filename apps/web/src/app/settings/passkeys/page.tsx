'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AppShell, LoadError } from '@/components/AppShell';
import { ConfirmIdentity } from '@/components/ConfirmIdentity';
import { ApiProblem } from '@/lib/api';
import { dateLocale } from '@/lib/money';
import { addPasskey, cancelledByUser, listPasskeys, passkeysSupported, removePasskey } from '@/lib/passkeys';
import { useApiData } from '@/lib/use-api';

/** Signing in with Face ID, Windows Hello or a fingerprint. The password stays as the backup. */
export default function PasskeysPage() {
  const t = useTranslations('passkeys');
  const tApp = useTranslations('app');
  const locale = useLocale();
  const [supported, setSupported] = useState(true);
  const [retry, setRetry] = useState<(() => Promise<void>) | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, failed, reload } = useApiData(listPasskeys);
  useEffect(() => setSupported(passkeysSupported()), []);
  if (failed) return <LoadError retry={reload} />;

  const day = (iso: string | null) => (iso ? new Intl.DateTimeFormat(dateLocale(locale), { dateStyle: 'medium' }).format(new Date(iso)) : '');

  async function run(work: () => Promise<void>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setRetry(null);
      setNotice(done);
      await reload();
    } catch (problem) {
      if (problem instanceof ApiProblem && problem.status === 403) setRetry(() => () => run(work, done));
      else if (cancelledByUser(problem)) setNotice(t('cancelled'));
      else setError(t('failed'));
    } finally {
      setBusy(false);
    }
  }

  function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get('name') ?? '').trim() || t('defaultName');
    void run(async () => {
      await addPasskey(name);
      form.reset();
    }, t('added'));
  }

  return (
    <AppShell>
      <h1>{t('title')}</h1>
      <p className="muted">{t('intro')}</p>
      <p className="small muted">{t('privacy')}</p>
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
      {retry ? (
        <ConfirmIdentity onConfirmed={retry} />
      ) : !supported ? (
        <p className="notice notice-warning">{t('unsupported')}</p>
      ) : (
        <form className="card" onSubmit={add}>
          <div className="field">
            <label htmlFor="name">{t('name')}</label>
            <input id="name" name="name" type="text" maxLength={60} placeholder={t('namePlaceholder')} />
          </div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {t('add')}
          </button>
        </form>
      )}
      <section className="card" aria-labelledby="list-title">
        <h2 id="list-title">{t('yours')}</h2>
        {!data ? (
          <p>{tApp('loading')}</p>
        ) : data.length === 0 ? (
          <p className="muted">{t('none')}</p>
        ) : (
          data.map((passkey) => (
            <div className="row" key={passkey.id}>
              <div className="row-main">
                <div className="row-title">{passkey.name ?? t('defaultName')}</div>
                <div className="small muted">{t('addedOn', { date: day(passkey.createdAt) })}</div>
              </div>
              <button className="btn btn-ghost" type="button" disabled={busy} aria-label={t('removeNamed', { name: passkey.name ?? t('defaultName') })} onClick={() => void run(() => removePasskey(passkey.id).then(() => undefined), t('removed'))}>
                {t('remove')}
              </button>
            </div>
          ))
        )}
        <p className="small muted" style={{ marginTop: '0.75rem' }}>{t('backup')}</p>
      </section>
    </AppShell>
  );
}
