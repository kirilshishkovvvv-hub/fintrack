/**
 * CSV import rules (FR-16, Stage 1 §9.5, §9.6): reading a bank's file and classifying each row.
 * Pure functions. Nothing here touches the ledger; rows become transactions only on confirmation
 * (BR-16.1). What can't be read is reported per row, never guessed.
 */
import { isIsoDate, type IsoDate } from './dates.ts';
import { MAX_ABS_CENTS, parseAmount, type Cents } from './money.ts';

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 10_000;
/** BR-16.4, BR-16.5: a manual entry or the other side of a transfer may be up to 3 days away. */
export const IMPORT_MATCH_DAYS = 3;

export const IMPORT_ENCODINGS = ['utf-8', 'utf-16le', 'windows-1252', 'iso-8859-15', 'windows-1251', 'windows-1253', 'iso-8859-7'] as const;
export type ImportEncoding = (typeof IMPORT_ENCODINGS)[number];

export const IMPORT_DATE_FORMATS = ['YYYY-MM-DD', 'DD.MM.YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY', 'DD.MM.YY', 'DD/MM/YY'] as const;
export type ImportDateFormat = (typeof IMPORT_DATE_FORMATS)[number];

export interface ImportMapping {
  date: number;
  /** A single signed column, or separate debit and credit columns. */
  amount?: number | undefined;
  debit?: number | undefined;
  credit?: number | undefined;
  description?: number | undefined;
  counterparty?: number | undefined;
  reference?: number | undefined;
  currency?: number | undefined;
}

export interface ImportSettings {
  encoding: ImportEncoding;
  delimiter: string;
  decimalSeparator: '.' | ',';
  dateFormat: ImportDateFormat;
  /** Index of the header row, or null when the file has none. */
  headerRow: number | null;
  mapping: ImportMapping;
}

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

/** Letters that are most common in Bulgarian/Russian and in Greek, for telling the code pages apart. */
const COMMON_CYRILLIC = /[оаеинтрсв]/gu;
const COMMON_GREEK = /[αοιετνσρη]/gu;

/** AC-16.5: UTF-8 if the bytes are valid UTF-8, otherwise the single-byte code page they look like. */
export function detectEncoding(bytes: Uint8Array): ImportEncoding {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch {
    // Not UTF-8: a single-byte code page.
  }
  let high = 0;
  let adjacent = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i]! < 0x80) continue;
    high += 1;
    if ((bytes[i - 1] ?? 0) >= 0x80 || (bytes[i + 1] ?? 0) >= 0x80) adjacent += 1;
  }
  // Western text has an accented letter here and there; Cyrillic and Greek words are all high bytes.
  if (high === 0 || adjacent / high < 0.5) return 'windows-1252';
  const cyrillic = (decodeBytes(bytes, 'windows-1251').match(COMMON_CYRILLIC) ?? []).length;
  const greek = (decodeBytes(bytes, 'windows-1253').match(COMMON_GREEK) ?? []).length;
  return greek > cyrillic ? 'windows-1253' : 'windows-1251';
}

export function decodeBytes(bytes: Uint8Array, encoding: ImportEncoding): string {
  return new TextDecoder(encoding).decode(bytes);
}

/** RFC 4180 parsing with the given delimiter. Empty lines are dropped. */
export function parseTable(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    cell = '';
    if (row.some((value) => value.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n') endRow();
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

function modalWidth(rows: string[][]): { width: number; share: number } {
  const counts = new Map<number, number>();
  for (const row of rows) counts.set(row.length, (counts.get(row.length) ?? 0) + 1);
  let width = 0;
  let best = 0;
  for (const [candidate, count] of counts) {
    if (count > best || (count === best && candidate > width)) {
      width = candidate;
      best = count;
    }
  }
  return { width, share: rows.length ? best / rows.length : 0 };
}

export function detectDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024);
  let chosen = ',';
  let bestScore = 0;
  for (const delimiter of [';', ',', '\t', '|']) {
    const { width, share } = modalWidth(parseTable(sample, delimiter));
    const score = width > 1 ? share * Math.log2(width) : 0;
    if (score > bestScore) {
      bestScore = score;
      chosen = delimiter;
    }
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Reads a bank's amount with the stated decimal separator. Null if it isn't exactly an amount (§10.2). */
export function parseBankAmount(input: string, decimalSeparator: '.' | ','): Cents | null {
  let text = input.replace(/[\s  ']/g, '').replace(/[€$]|EUR|USD/gi, '');
  if (text === '') return null;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (/-$|^-|^−|−$/.test(text)) negative = true;
  text = text.replace(/^[-+−]|[-+−]$/g, '');
  const group = decimalSeparator === ',' ? '.' : ',';
  // Thousands separators only in real groups of three: "1.5" with a comma decimal is unreadable.
  const parts = text.split(decimalSeparator);
  if (parts.length > 2) return null;
  const whole = parts[0]!;
  if (whole.includes(group) && !new RegExp(`^\\d{1,3}(\\${group}\\d{3})+$`).test(whole)) return null;
  const normalized = whole.split(group).join('') + (parts[1] !== undefined ? `.${parts[1]}` : '');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  try {
    const value = parseAmount(normalized);
    if (Math.abs(value) > MAX_ABS_CENTS) return null;
    return negative ? -value : value;
  } catch {
    return null;
  }
}

/** Reads a date in the stated format, ignoring any time after it. Null if it isn't a real date. */
export function parseBankDate(input: string, format: ImportDateFormat): IsoDate | null {
  const text = input.trim();
  const separator = format.includes('.') ? '\\.' : format.includes('/') ? '/' : '-';
  const yearDigits = format.endsWith('YY') && !format.endsWith('YYYY') ? 2 : 4;
  let year: string;
  let month: string;
  let day: string;
  if (format === 'YYYY-MM-DD') {
    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\D|$)/.exec(text);
    if (!match) return null;
    [, year, month, day] = match as unknown as [string, string, string, string];
  } else {
    const match = new RegExp(`^(\\d{1,2})${separator}(\\d{1,2})${separator}(\\d{${yearDigits}})(?:\\D|$)`).exec(text);
    if (!match) return null;
    const [, first, second, y] = match as unknown as [string, string, string, string];
    year = yearDigits === 2 ? `20${y}` : y;
    [day, month] = format.startsWith('MM') ? [second, first] : [first, second];
  }
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

/**
 * The format that reads every sample. DD/MM comes first because the market is EU-first (MKT-1);
 * for a file that fits both, the preview shows the dates and the user can change the format.
 */
export function detectDateFormat(samples: readonly string[]): ImportDateFormat | null {
  const values = samples.filter((value) => value.trim() !== '');
  if (values.length === 0) return null;
  return IMPORT_DATE_FORMATS.find((format) => values.every((value) => parseBankDate(value, format) !== null)) ?? null;
}

export function detectDecimalSeparator(samples: readonly string[]): '.' | ',' {
  let comma = 0;
  let dot = 0;
  for (const raw of samples) {
    const value = raw.trim();
    const lastComma = value.lastIndexOf(',');
    const lastDot = value.lastIndexOf('.');
    if (lastComma > lastDot && /,\d{1,2}\s*\D*$/.test(value)) comma += 1;
    else if (lastDot > lastComma && /\.\d{1,2}\s*\D*$/.test(value)) dot += 1;
  }
  return comma > dot ? ',' : '.';
}

/** BR-16.3: case, accents of spacing and repeated whitespace don't make a different row. */
export function normalizeDescription(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** For search only (AC-22.4): "cafe" finds "Café", and Greek matches with or without accents. */
export function searchText(text: string): string {
  return normalizeDescription(text).normalize('NFD').replace(/\p{M}/gu, '').replace(/ς/g, 'σ');
}

// ---------------------------------------------------------------------------
// Detecting the layout
// ---------------------------------------------------------------------------

/** Column names in the launch languages (MKT-2). The user sees and can change every choice. */
const KEYWORDS: Record<keyof ImportMapping, RegExp> = {
  date: /date|дата|datum|fecha|data|ημερομην/i,
  amount: /amount|сума|betrag|importe|importo|montant|ποσό|ποσο/i,
  debit: /debit|дебит|soll|débit|cargo|addebit|χρέωση|χρεωση|money out|paid out/i,
  credit: /credit|кредит|haben|crédit|abono|accredit|πίστωση|πιστωση|money in|paid in/i,
  description: /descr|memo|details|narrative|text|описание|основание|verwendungszweck|buchungstext|concepto|causale|libell|αιτιολογ|περιγραφ/i,
  counterparty: /counterparty|payee|beneficiary|контрагент|получател|empf|beguenstigt|beneficiario|bénéficiaire|δικαιούχος/i,
  reference: /reference|референц|referenz|referencia|riferimento|référence|αναφορά/i,
  currency: /currency|^ccy$|валута|währung|moneda|valuta|devise|νόμισμα/i,
};

function looksLikeValue(cell: string): boolean {
  const value = cell.trim();
  return detectDateFormat([value]) !== null || /^[-+−(]?\d[\d\s.,]*\)?$/.test(value);
}

/** The first row of the table's full width with no dates or numbers in it; banks often put title lines above it. */
export function detectHeaderRow(table: string[][]): number | null {
  const { width } = modalWidth(table.slice(0, 200));
  for (let i = 0; i < Math.min(table.length, 30); i += 1) {
    const row = table[i]!;
    if (row.length !== width) continue;
    return row.some(looksLikeValue) ? null : i;
  }
  return null;
}

/** Suggests columns from their names and, failing that, from what's in them. */
export function suggestMapping(headers: readonly string[] | null, samples: string[][]): Partial<ImportMapping> {
  const mapping: Partial<ImportMapping> = {};
  const used = new Set<number>();
  const take = (field: keyof ImportMapping, index: number) => {
    if (index < 0 || used.has(index) || mapping[field] !== undefined) return;
    mapping[field] = index;
    used.add(index);
  };
  if (headers) {
    for (const field of ['date', 'currency', 'debit', 'credit', 'amount', 'counterparty', 'reference', 'description'] as const) {
      take(field, headers.findIndex((name, index) => !used.has(index) && KEYWORDS[field].test(name)));
    }
  }
  const width = samples[0]?.length ?? 0;
  const column = (index: number) => samples.map((row) => row[index] ?? '').filter((value) => value.trim() !== '');
  for (let index = 0; index < width; index += 1) {
    const values = column(index);
    if (values.length === 0) continue;
    if (mapping.date === undefined && detectDateFormat(values)) take('date', index);
  }
  if (mapping.amount === undefined && mapping.debit === undefined && mapping.credit === undefined) {
    for (let index = 0; index < width; index += 1) {
      if (!used.has(index) && column(index).length > 0 && column(index).every((value) => /^[-+−(]?\d[\d\s.,]*\)?$/.test(value.trim()))) {
        take('amount', index);
        break;
      }
    }
  }
  if (mapping.description === undefined) {
    let longest = -1;
    let length = 0;
    for (let index = 0; index < width; index += 1) {
      if (used.has(index)) continue;
      const total = column(index).join('').length;
      if (total > length) {
        length = total;
        longest = index;
      }
    }
    take('description', longest);
  }
  return mapping;
}

export interface DetectedFormat {
  encoding: ImportEncoding;
  delimiter: string;
  decimalSeparator: '.' | ',';
  dateFormat: ImportDateFormat | null;
  headerRow: number | null;
  mapping: Partial<ImportMapping>;
}

export function detectFormat(bytes: Uint8Array, forcedEncoding?: ImportEncoding): DetectedFormat {
  const encoding = forcedEncoding ?? detectEncoding(bytes);
  const text = decodeBytes(bytes, encoding);
  const delimiter = detectDelimiter(text);
  const table = parseTable(text, delimiter);
  const headerRow = detectHeaderRow(table);
  const body = bodyRows(table, headerRow);
  const samples = body.slice(0, 200);
  const mapping = suggestMapping(headerRow === null ? null : table[headerRow]!, samples);
  const cells = (index: number | undefined) => (index === undefined ? [] : samples.map((row) => row[index] ?? ''));
  return {
    encoding,
    delimiter,
    decimalSeparator: detectDecimalSeparator([...cells(mapping.amount), ...cells(mapping.debit), ...cells(mapping.credit)]),
    dateFormat: detectDateFormat(cells(mapping.date)),
    headerRow,
    mapping,
  };
}

/**
 * The data rows: those after the header with the width most of them share, so title and footer
 * lines fall away. The preview reports how many lines were left out, so nothing vanishes unseen.
 */
export function bodyRows(table: string[][], headerRow: number | null): string[][] {
  const rows = table.slice(headerRow === null ? 0 : headerRow + 1);
  const { width } = modalWidth(rows);
  return rows.filter((row) => row.length === width);
}

// ---------------------------------------------------------------------------
// From cells to rows
// ---------------------------------------------------------------------------

export type RowProblem = 'unreadable_date' | 'unreadable_amount' | 'zero_amount';

export interface ParsedRow {
  /** 1-based position among the data rows, for showing to the user. */
  rowNo: number;
  date: IsoDate | null;
  amount: Cents | null;
  description: string;
  counterparty: string | null;
  reference: string | null;
  currency: string | null;
  problem: RowProblem | null;
}

const clean = (value: string | undefined, max: number) => (value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);

export function readRows(table: string[][], settings: ImportSettings): ParsedRow[] {
  const { mapping, decimalSeparator, dateFormat } = settings;
  const cell = (row: string[], index: number | undefined) => (index === undefined ? '' : row[index] ?? '');
  return bodyRows(table, settings.headerRow).map((row, index): ParsedRow => {
    const date = parseBankDate(cell(row, mapping.date), dateFormat);
    let amount: Cents | null;
    if (mapping.amount !== undefined) {
      amount = parseBankAmount(cell(row, mapping.amount), decimalSeparator);
    } else {
      const debit = cell(row, mapping.debit).trim();
      const credit = cell(row, mapping.credit).trim();
      const out = debit === '' ? 0 : parseBankAmount(debit, decimalSeparator);
      const incoming = credit === '' ? 0 : parseBankAmount(credit, decimalSeparator);
      // A debit column may hold 45.00 or −45.00; it is money out either way.
      amount = out === null || incoming === null ? null : Math.abs(incoming) - Math.abs(out);
    }
    const counterparty = clean(cell(row, mapping.counterparty), 200) || null;
    const description = clean(cell(row, mapping.description), 500) || counterparty || '';
    let problem: RowProblem | null = null;
    if (date === null) problem = 'unreadable_date';
    else if (amount === null) problem = 'unreadable_amount';
    else if (amount === 0) problem = 'zero_amount';
    return {
      rowNo: index + 1,
      date,
      amount,
      description,
      counterparty,
      reference: clean(cell(row, mapping.reference), 200) || null,
      currency: mapping.currency === undefined ? null : clean(cell(row, mapping.currency), 8).toUpperCase() || null,
      problem,
    };
  });
}

// ---------------------------------------------------------------------------
// Fingerprints and classification (§9.6)
// ---------------------------------------------------------------------------

export function fingerprintOf(row: { date: IsoDate; amount: Cents; description: string }): string {
  return `${row.date}|${row.amount}|${normalizeDescription(row.description)}`;
}

export const importedKey = (fingerprint: string, ordinal: number) => `${fingerprint}#${ordinal}`;

export type RowClass = 'new' | 'duplicate' | 'possible_duplicate' | 'already_recorded' | 'transfer' | 'rejected';
export type RowDecision = 'import' | 'skip' | 'link' | 'transfer';
export type RejectReason = RowProblem | 'foreign_currency' | 'future_date' | 'before_opening';

/** A posted transaction on the target account that a row could turn out to be. */
export interface ClaimCandidate {
  transactionId: string;
  date: IsoDate;
  /** The raw posting on the target account: negative is money out, like a bank's row. */
  amount: Cents;
  isTransfer: boolean;
}

/** A posted income or expense on another account that may be the other side of a transfer (BR-16.5). */
export interface PairCandidate {
  transactionId: string;
  accountId: string;
  date: IsoDate;
  amount: Cents;
}

export interface ClassifyContext {
  today: IsoDate;
  openingDate: IsoDate;
  workspaceCurrency: string;
  /** importedKey of every row already imported into this account. */
  imported: ReadonlySet<string>;
  candidates: readonly ClaimCandidate[];
  pairs: readonly PairCandidate[];
  otherAccounts: readonly { id: string; name: string }[];
}

export interface ClassifiedRow extends ParsedRow {
  fingerprint: string | null;
  ordinal: number;
  classification: RowClass;
  /** Null means the user must decide before confirming (BR-16.4, BR-16.5). */
  decision: RowDecision | null;
  rejectReason: RejectReason | null;
  candidateTransactionId: string | null;
  counterAccountId: string | null;
}

function daysApart(a: IsoDate, b: IsoDate): number {
  return Math.abs(Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8))) / 86_400_000;
}

/** Nearest date first, then the earliest ID (§9.5 M-6). */
function nearest<T extends { transactionId: string; date: IsoDate }>(items: T[], date: IsoDate): T | undefined {
  return [...items].sort((a, b) => daysApart(a.date, date) - daysApart(b.date, date) || (a.transactionId < b.transactionId ? -1 : 1))[0];
}

/** An account named in the description ("Transfer to savings"), as a whole word of at least 4 letters. */
function namedAccount(description: string, accounts: ClassifyContext['otherAccounts']) {
  const text = normalizeDescription(description);
  return accounts.find((account) => {
    const name = normalizeDescription(account.name);
    if (name.length < 4) return false;
    const at = text.indexOf(name);
    if (at < 0) return false;
    const boundary = (c: string | undefined) => c === undefined || !/[\p{L}\p{N}]/u.test(c);
    return boundary(text[at - 1]) && boundary(text[at + name.length]);
  });
}

/**
 * Classifies every row in file order (§9.6 step 3): rejected, exact duplicate, an existing
 * transaction it claims, a transfer, or new. Each existing transaction is claimed at most once;
 * a row with no unclaimed candidate is new (BR-16.9). Matching planned occurrences joins with Stage 5.
 */
export function classifyRows(rows: readonly ParsedRow[], context: ClassifyContext): ClassifiedRow[] {
  const ordinals = new Map<string, number>();
  const claimed = new Set<string>();
  return rows.map((row): ClassifiedRow => {
    const empty = { fingerprint: null, ordinal: 0, rejectReason: null, candidateTransactionId: null, counterAccountId: null };
    const reject = (reason: RejectReason): ClassifiedRow => ({ ...row, ...empty, classification: 'rejected', decision: 'skip', rejectReason: reason });
    if (row.problem) return reject(row.problem);
    if (row.currency && row.currency !== context.workspaceCurrency) return reject('foreign_currency');
    const date = row.date!;
    const amount = row.amount!;
    if (date > context.today) return reject('future_date');
    if (date < context.openingDate) return reject('before_opening');

    const fingerprint = fingerprintOf({ date, amount, description: row.description });
    const ordinal = (ordinals.get(fingerprint) ?? 0) + 1;
    ordinals.set(fingerprint, ordinal);
    const base = { ...row, ...empty, fingerprint, ordinal };

    if (context.imported.has(importedKey(fingerprint, ordinal))) return { ...base, classification: 'duplicate', decision: 'skip' };

    const close = context.candidates.filter(
      (candidate) => !claimed.has(candidate.transactionId) && candidate.amount === amount && daysApart(candidate.date, date) <= IMPORT_MATCH_DAYS,
    );
    const recorded = nearest(close.filter((candidate) => candidate.isTransfer), date);
    if (recorded) {
      claimed.add(recorded.transactionId);
      return { ...base, classification: 'already_recorded', decision: 'link', candidateTransactionId: recorded.transactionId };
    }
    const manual = nearest(close.filter((candidate) => !candidate.isTransfer), date);
    if (manual) {
      claimed.add(manual.transactionId);
      return { ...base, classification: 'possible_duplicate', decision: null, candidateTransactionId: manual.transactionId };
    }

    const pair = nearest(
      context.pairs.filter((candidate) => !claimed.has(candidate.transactionId) && candidate.amount === -amount && daysApart(candidate.date, date) <= IMPORT_MATCH_DAYS),
      date,
    );
    if (pair) {
      claimed.add(pair.transactionId);
      return { ...base, classification: 'transfer', decision: null, candidateTransactionId: pair.transactionId, counterAccountId: pair.accountId };
    }
    const named = namedAccount(row.description, context.otherAccounts);
    if (named) return { ...base, classification: 'transfer', decision: null, counterAccountId: named.id };

    return { ...base, classification: 'new', decision: 'import' };
  });
}

