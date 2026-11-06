'use client';

import Link from 'next/link';
import { notFound, useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

const DOCUMENTS = ['terms', 'privacy', 'cookies', 'imprint'] as const;

/** The version recorded with each consent at sign-up (LEGAL_VERSIONS in the API). */
const VERSION = 'draft-2026-11';

interface Section {
  heading: string;
  body?: string;
}

/**
 * Public legal page shells (Annex L items 1, 2, 4, 16). Only facts true of the code are written
 * here; the rest waits for a lawyer and the business details, and says so.
 */
export default function LegalPage() {
  const { doc } = useParams<{ doc: string }>();
  const t = useTranslations('legal');
  if (!DOCUMENTS.includes(doc as (typeof DOCUMENTS)[number])) notFound();
  const sections = t.raw(`${doc}.sections`) as Section[];
  const missing = doc === 'imprint' ? t('needsDetails') : t('notWritten');

  return (
    <main id="main" className="auth-wrap" style={{ maxWidth: '40rem' }}>
      <div className="card">
        <h1>{t(`${doc}.title`)}</h1>
        <p className="notice notice-warning small">
          <strong>{t('draftTitle')}.</strong> {t('draft')}
        </p>
        <p className="small muted">{t('version', { version: VERSION })}</p>
        {doc === 'cookies' && (
          <>
            <p>{t('cookies.intro')}</p>
            <div className="table-scroll" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('cookies.nameHeading')}</th>
                    <th scope="col">{t('cookies.purposeHeading')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(t.raw('cookies.list') as { name: string; purpose: string }[]).map((cookie) => (
                    <tr key={cookie.name}>
                      <td style={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }}>{cookie.name}</td>
                      <td style={{ whiteSpace: 'normal' }}>{cookie.purpose}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {sections.map((section) => (
          <section key={section.heading}>
            <h2>{section.heading}</h2>
            {section.body ? <p>{section.body}</p> : <p className="muted">{missing}</p>}
          </section>
        ))}
        <nav aria-label={t('navLabel')} className="actions" style={{ marginTop: '1rem' }}>
          {DOCUMENTS.filter((other) => other !== doc).map((other) => (
            <Link key={other} href={`/legal/${other}`} className="small">
              {t(`nav.${other}`)}
            </Link>
          ))}
        </nav>
      </div>
    </main>
  );
}
