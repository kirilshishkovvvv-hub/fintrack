/**
 * Money input and display. Input is converted to integer cents by the domain module's parser
 * (§10.2: more than 2 decimals is rejected, never rounded). Display uses the locale's format,
 * fed with an exact decimal string, so no floating point is involved.
 */
import { formatAmount, parseAmount } from '@fintrack/domain';

/**
 * Accepts "12.50", "12,50", "1,234.56", "1.234,56" and "1 234,56". When both separators appear,
 * the last one is the decimal separator. Returns null for anything else.
 */
export function parseUserAmount(input: string): number | null {
  const compact = input.replace(/[\s  ]/g, '').replace(/^[€$]|[€$]$/g, '');
  if (!/^-?[\d.,]+$/.test(compact)) return null;
  const lastDot = compact.lastIndexOf('.');
  const lastComma = compact.lastIndexOf(',');
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    normalized = compact.split(thousands).join('').replace(decimal, '.');
  } else if (lastComma >= 0) {
    const decimals = compact.length - lastComma - 1;
    normalized = decimals === 3 && compact.indexOf(',') === lastComma ? compact.replace(',', '') : compact.replace(',', '.');
  } else {
    const decimals = lastDot >= 0 ? compact.length - lastDot - 1 : 0;
    normalized = lastDot >= 0 && decimals === 3 && compact.indexOf('.') === lastDot ? compact.replace('.', '') : compact;
  }
  if ((normalized.match(/\./g) ?? []).length > 1) return null;
  try {
    return parseAmount(normalized);
  } catch {
    return null;
  }
}

/** The product's English is European: "11 Nov 2026", never the US order (§10.3). */
export const dateLocale = (locale: string) => (locale === 'en' ? 'en-GB' : locale);

/** A calendar date in the user's format. It has no time, so no time zone may shift it (A-2). */
export function formatDay(iso: string, locale = 'en-GB'): string {
  return new Intl.DateTimeFormat(dateLocale(locale), { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
}

export function formatMoney(minor: number, currency: string, locale = 'en-GB'): string {
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' });
  // Intl.NumberFormat formats exact decimal strings (ES2023); the cast is only for older type definitions.
  return formatter.format(formatAmount(minor) as unknown as number);
}
