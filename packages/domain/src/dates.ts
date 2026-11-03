/**
 * Calendar dates as ISO strings ("2026-03-31"), with no time of day (A-2).
 * ISO strings compare correctly with < and >.
 */
export type IsoDate = string;

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function assertIsoDate(value: string): IsoDate {
  if (!isIsoDate(value)) {
    throw new RangeError(`Invalid calendar date: "${value}"`);
  }
  return value;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const [year, month, day] = assertIsoDate(date).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** "2026-03-17" -> "2026-03" */
export function monthOf(date: IsoDate): string {
  return assertIsoDate(date).slice(0, 7);
}

/** First and last day of a "YYYY-MM" month. */
export function monthRange(month: string): { from: IsoDate; to: IsoDate } {
  const from = assertIsoDate(`${month}-01`);
  const [year, monthNumber] = month.split('-').map(Number) as [number, number];
  const to = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  return { from, to };
}

/**
 * "Today" in the workspace time zone (A-1). Always computed on the server,
 * never taken from the client's clock (Stage 2 §7.3).
 */
export function todayIn(timeZone: string, now: Date = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return assertIsoDate(`${get('year')}-${get('month')}-${get('day')}`);
}
