import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getTranslations } from 'next-intl/server';
import { UndoProvider } from '@/components/UndoToast';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fintrack',
  description: 'Know what you can safely spend.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const t = await getTranslations('app');
  return (
    <html lang={locale}>
      <body>
        <a className="skip-link" href="#main">
          {t('skipToContent')}
        </a>
        <NextIntlClientProvider>
          <UndoProvider>{children}</UndoProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
