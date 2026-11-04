'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import QRCode from 'qrcode-svg';
import { AppShell, LoadError } from '@/components/AppShell';
import { ConfirmIdentity } from '@/components/ConfirmIdentity';
import { api, ApiProblem } from '@/lib/api';
import { loadCurrentUser } from '@/lib/auth';
import { useApiData } from '@/lib/use-api';

interface Enrolment {
  totpURI: string;
  backupCodes: string[];
}

/** Password, email, sessions and 2FA (FR-01, BR-01.5, AD-15). Each change needs a recent sign-in. */
export default function SecurityPage() {
  const t = useTranslations('security');
  const tApp = useTranslations('app');
  const router = useRouter();
  const [retry, setRetry] = useState<(() => Promise<void>) | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const { data: user, failed, reload } = useApiData(loadCurrentUser);
  if (failed) return <LoadError retry={reload} />;

  /** Runs a change; if the sign-in isn't recent, asks who it is and carries on. */
  async function run(work: () => Promise<void>, messages: { wrong?: string } = {}) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setRetry(null);
    } catch (problem) {
      if (problem instanceof ApiProblem && problem.status === 403) setRetry(() => () => run(work, messages));
      else if (problem instanceof ApiProblem && (problem.status === 400 || problem.status === 401) && messages.wrong) setError(messages.wrong);
      else setError(tApp('genericError'));
    } finally {
      setBusy(false);
    }
  }

  function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const newPassword = String(fields.get('newPassword') ?? '');
    if (newPassword.length < 12) return setError(t('tooShort'));
    void run(
      async () => {
        await api('POST', '/api/auth/change-password', { body: { currentPassword: String(fields.get('currentPassword') ?? ''), newPassword } });
        form.reset();
        setNotice(t('passwordChanged'));
      },
      { wrong: t('wrongPassword') },
    );
  }

  function changeEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const newEmail = String(new FormData(form).get('newEmail') ?? '').trim();
    void run(
      async () => {
        await api('POST', '/api/auth/change-email', { body: { newEmail, callbackURL: '/settings/security' } });
        form.reset();
        setNotice(t('emailSent', { email: newEmail }));
      },
      { wrong: t('emailRefused') },
    );
  }

  const signOutEverywhere = () =>
    run(async () => {
      await api('POST', '/api/auth/revoke-sessions', { body: {} });
      router.replace('/sign-in');
    });

  function startTwoFactor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('password') ?? '');
    void run(
      async () => {
        setEnrolment(await api<Enrolment>('POST', '/api/auth/two-factor/enable', { body: { password } }));
      },
      { wrong: t('wrongPassword') },
    );
  }

  function finishTwoFactor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') ?? '').replace(/\s/g, '');
    void run(
      async () => {
        await api('POST', '/api/auth/two-factor/verify-totp', { body: { code } });
        setEnrolment(null);
        setNotice(t('twoFactorOn'));
        await reload();
      },
      { wrong: t('wrongCode') },
    );
  }

  function stopTwoFactor(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('password') ?? '');
    void run(
      async () => {
        await api('POST', '/api/auth/two-factor/disable', { body: { password } });
        setNotice(t('twoFactorOff'));
        await reload();
      },
      { wrong: t('wrongPassword') },
    );
  }

  const key = enrolment ? new URL(enrolment.totpURI).searchParams.get('secret') : null;
  const qr = enrolment ? `data:image/svg+xml;utf8,${encodeURIComponent(new QRCode({ content: enrolment.totpURI, ecl: 'M', join: true, container: 'svg-viewbox', padding: 2 }).svg())}` : null;

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
      {retry ? (
        <ConfirmIdentity onConfirmed={retry} />
      ) : !user ? (
        <p aria-live="polite">{tApp('loading')}</p>
      ) : (
        <>
          <section className="card" aria-labelledby="two-factor-title">
            <h2 id="two-factor-title">{t('twoFactorTitle')}</h2>
            <p className="small muted">{t('twoFactorIntro')}</p>
            {enrolment ? (
              <form onSubmit={finishTwoFactor}>
                <p>{t('scan')}</p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qr!} alt={t('qrAlt')} width={200} height={200} style={{ background: '#fff', borderRadius: 8 }} />
                <p className="small">
                  {t('manualKey')} <code style={{ wordBreak: 'break-all' }}>{key}</code>
                </p>
                <div className="notice notice-warning small">
                  <p>{t('backupIntro')}</p>
                  <ul style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>
                    {enrolment.backupCodes.map((code) => (
                      <li key={code}>
                        <code>{code}</code>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="field">
                  <label htmlFor="code">{t('codeFromApp')}</label>
                  <input id="code" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" required />
                </div>
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  {t('turnOn')}
                </button>
              </form>
            ) : user.twoFactorEnabled ? (
              <form onSubmit={stopTwoFactor}>
                <p>
                  <span className="badge" style={{ marginLeft: 0 }}>{t('on')}</span>
                </p>
                <div className="field">
                  <label htmlFor="off-password">{t('password')}</label>
                  <input id="off-password" name="password" type="password" autoComplete="current-password" required />
                </div>
                <button className="btn" type="submit" disabled={busy}>
                  {t('turnOff')}
                </button>
              </form>
            ) : (
              <form onSubmit={startTwoFactor}>
                <div className="field">
                  <label htmlFor="on-password">{t('password')}</label>
                  <input id="on-password" name="password" type="password" autoComplete="current-password" required />
                </div>
                <button className="btn" type="submit" disabled={busy}>
                  {t('setUp')}
                </button>
              </form>
            )}
          </section>

          <section className="card" aria-labelledby="passkeys-title">
            <h2 id="passkeys-title">{t('passkeysTitle')}</h2>
            <Link href="/settings/passkeys" className="btn">
              {t('passkeysLink')}
            </Link>
          </section>

          <form className="card" onSubmit={changePassword}>
            <h2>{t('passwordTitle')}</h2>
            <div className="field">
              <label htmlFor="currentPassword">{t('currentPassword')}</label>
              <input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required />
            </div>
            <div className="field">
              <label htmlFor="newPassword">{t('newPassword')}</label>
              <input id="newPassword" name="newPassword" type="password" autoComplete="new-password" minLength={12} required aria-describedby="new-password-hint" />
              <span id="new-password-hint" className="hint">
                {t('passwordHint')}
              </span>
            </div>
            <button className="btn" type="submit" disabled={busy}>
              {t('changePassword')}
            </button>
          </form>

          <form className="card" onSubmit={changeEmail}>
            <h2>{t('emailTitle')}</h2>
            <p className="small muted">{t('emailCurrent', { email: user.email })}</p>
            <div className="field">
              <label htmlFor="newEmail">{t('newEmail')}</label>
              <input id="newEmail" name="newEmail" type="email" autoComplete="email" required />
            </div>
            <button className="btn" type="submit" disabled={busy}>
              {t('changeEmail')}
            </button>
          </form>

          <section className="card" aria-labelledby="sessions-title">
            <h2 id="sessions-title">{t('sessionsTitle')}</h2>
            <p className="small muted">{t('sessionsIntro')}</p>
            <button className="btn" type="button" disabled={busy} onClick={() => void signOutEverywhere()}>
              {t('signOutEverywhere')}
            </button>
          </section>
        </>
      )}
    </AppShell>
  );
}
