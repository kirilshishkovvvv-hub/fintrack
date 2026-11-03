import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

/**
 * Languages that are switched on (MKT-2: English only at launch). A language is added here
 * only after its UI strings, security emails and legal texts are reviewed (FR-22).
 */
export const ENABLED_LOCALES = ['en'] as const;
export type Locale = (typeof ENABLED_LOCALES)[number];

export default getRequestConfig(async () => {
  const requested = (await cookies()).get('locale')?.value;
  const locale: Locale = ENABLED_LOCALES.find((candidate) => candidate === requested) ?? 'en';
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
