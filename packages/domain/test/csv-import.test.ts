/** Reading bank files and classifying rows (FR-16, AC-16.2, AC-16.5, BR-16.2 to BR-16.5, BR-16.9). */
import { describe, expect, test } from 'vitest';
import {
  classifyRows,
  decodeBytes,
  detectDateFormat,
  detectEncoding,
  detectFormat,
  fingerprintOf,
  importedKey,
  normalizeDescription,
  parseBankAmount,
  parseBankDate,
  parseTable,
  readRows,
  type ClassifyContext,
  type ImportSettings,
  type ParsedRow,
} from '../src/csv-import.ts';

/** Encodes through a code page by inverting its decoder, so test files hold real bank bytes. */
function encode(text: string, encoding: 'windows-1251' | 'windows-1253' | 'windows-1252'): Uint8Array {
  const decoder = new TextDecoder(encoding);
  const table = new Map<string, number>();
  for (let byte = 0; byte < 256; byte += 1) table.set(decoder.decode(new Uint8Array([byte])), byte);
  return new Uint8Array([...text].map((c) => table.get(c) ?? 0x3f));
}

describe('encodings', () => {
  test('AC-16.5: a Windows-1251 file with comma decimals reads Cyrillic text and amounts correctly', () => {
    const file = 'Дата;Основание;Сума\r\n12.03.2026;Плащане на наем за месец март;-600,00\r\n13.03.2026;Заплата от работодател;1 234,56\r\n';
    const bytes = encode(file, 'windows-1251');
    const detected = detectFormat(bytes);
    expect(detected).toMatchObject({ encoding: 'windows-1251', delimiter: ';', decimalSeparator: ',', dateFormat: 'DD.MM.YYYY', headerRow: 0 });
    expect(detected.mapping).toMatchObject({ date: 0, description: 1, amount: 2 });
    const rows = readRows(parseTable(decodeBytes(bytes, detected.encoding), detected.delimiter), { ...detected, dateFormat: detected.dateFormat!, mapping: detected.mapping as ImportSettings['mapping'] });
    expect(rows.map((row) => [row.date, row.amount, row.description])).toEqual([
      ['2026-03-12', -60000, 'Плащане на наем за месец март'],
      ['2026-03-13', 123456, 'Заплата от работодател'],
    ]);
  });

  test('Greek, Western and UTF-8 files are told apart', () => {
    expect(detectEncoding(encode('Ημερομηνία;Περιγραφή;Ποσό\n01/03/2026;Πληρωμή ενοικίου για το σπίτι;-10,00\n', 'windows-1253'))).toBe('windows-1253');
    expect(detectEncoding(encode('Date;Libellé;Montant\n01/03/2026;Café à Paris;-10,00\nBüro;Straße;-1,00\n', 'windows-1252'))).toBe('windows-1252');
    expect(detectEncoding(new TextEncoder().encode('Дата,Ποσό,Café\n'))).toBe('utf-8');
    expect(detectEncoding(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toBe('utf-16le');
  });
});

describe('layout', () => {
  test('title lines above the header and footer lines below the data fall away', () => {
    const file = 'Account statement\nIBAN: XX00\n\nDate,Details,Amount,Currency\n2026-03-12,"Coffee, bar",-2.50,EUR\n2026-03-13,"He said ""hi""",10.00,EUR\nTotal: 2 rows\n';
    const bytes = new TextEncoder().encode(file);
    const format = detectFormat(bytes);
    expect(format.headerRow).toBe(2);
    expect(format.delimiter).toBe(',');
    expect(format.mapping).toMatchObject({ date: 0, description: 1, amount: 2, currency: 3 });
    const rows = readRows(parseTable(file, ','), { ...format, dateFormat: format.dateFormat!, mapping: format.mapping as ImportSettings['mapping'] });
    expect(rows.map((row) => [row.description, row.amount, row.currency])).toEqual([['Coffee, bar', -250, 'EUR'], ['He said "hi"', 1000, 'EUR']]);
  });

  test('separate debit and credit columns become one signed amount; a file with no header is read by content', () => {
    const file = 'Datum;Text;Soll;Haben\n01.03.2026;Miete;600,00;\n02.03.2026;Gehalt;;2.000,00\n';
    const format = detectFormat(new TextEncoder().encode(file));
    expect(format.mapping).toMatchObject({ date: 0, description: 1, debit: 2, credit: 3 });
    const rows = readRows(parseTable(file, ';'), { ...format, dateFormat: format.dateFormat!, mapping: format.mapping as ImportSettings['mapping'] });
    expect(rows.map((row) => row.amount)).toEqual([-60000, 200000]);

    const bare = detectFormat(new TextEncoder().encode('2026-03-12,COFFEE BAR,-2.50\n2026-03-13,LIDL,-45.00\n'));
    expect(bare.headerRow).toBeNull();
    expect(bare.mapping).toMatchObject({ date: 0, amount: 2, description: 1 });
  });
});

describe('values', () => {
  test('amounts are read exactly, and anything ambiguous is refused rather than guessed', () => {
    const cases: [string, '.' | ',', number | null][] = [
      ['1 234,56', ',', 123456], ['1.234,56', ',', 123456], ['-45,60', ',', -4560], ['45,60-', ',', -4560], ['(10,00)', ',', -1000],
      ['1,234.56', '.', 123456], ['+12.5', '.', 1250], ['€12.50', '.', 1250], ['12.50 EUR', '.', 1250], ['1.5', ',', null], ['12,345', '.', 1234500],
      ['12.345', '.', null], ['abc', '.', null], ['', '.', null], ['1,2,3', ',', null], ['99999999999999', '.', null],
    ];
    for (const [input, separator, expected] of cases) expect(parseBankAmount(input, separator), input).toBe(expected);
  });

  test('dates must be real; a date that fits two formats takes the European reading', () => {
    expect(parseBankDate('31.03.2026', 'DD.MM.YYYY')).toBe('2026-03-31');
    expect(parseBankDate('31.02.2026', 'DD.MM.YYYY')).toBeNull();
    expect(parseBankDate('1/3/26', 'DD/MM/YY')).toBe('2026-03-01');
    expect(parseBankDate('03/15/2026', 'MM/DD/YYYY')).toBe('2026-03-15');
    expect(parseBankDate('2026-03-12 14:22:01', 'YYYY-MM-DD')).toBe('2026-03-12');
    expect(detectDateFormat(['03/04/2026'])).toBe('DD/MM/YYYY');
    expect(detectDateFormat(['03/15/2026', '03/04/2026'])).toBe('MM/DD/YYYY');
    expect(detectDateFormat(['soon'])).toBeNull();
  });

  test('descriptions compare without regard to case and spacing', () => {
    expect(normalizeDescription('  COFFEE   Bar ')).toBe('coffee bar');
    expect(fingerprintOf({ date: '2026-03-12', amount: -250, description: 'COFFEE  BAR' })).toBe(fingerprintOf({ date: '2026-03-12', amount: -250, description: 'coffee bar' }));
  });
});

describe('classification (§9.6)', () => {
  const row = (date: string, amount: number, description: string, extra: Partial<ParsedRow> = {}): ParsedRow => ({
    rowNo: 1, date, amount, description, counterparty: null, reference: null, currency: null, problem: null, ...extra,
  });
  const context: ClassifyContext = { today: '2026-03-31', openingDate: '2026-03-01', workspaceCurrency: 'EUR', imported: new Set(), candidates: [], pairs: [], otherAccounts: [] };
  const classes = (rows: ParsedRow[], extra: Partial<ClassifyContext> = {}) => classifyRows(rows, { ...context, ...extra }).map((r) => r.classification);

  test('AC-16.2, GT-35: identical rows get ordinals, so re-imports match row for row', () => {
    const coffee = row('2026-03-12', -250, 'COFFEE BAR');
    const first = classifyRows([coffee, coffee], context);
    expect(first.map((r) => [r.classification, r.ordinal])).toEqual([['new', 1], ['new', 2]]);
    const imported = new Set(first.map((r) => importedKey(r.fingerprint!, r.ordinal)));
    expect(classifyRows([coffee, coffee, coffee], { ...context, imported }).map((r) => r.classification)).toEqual(['duplicate', 'duplicate', 'new']);
  });

  test('rows that cannot count are rejected with the reason, and never get an ordinal', () => {
    const rejected = classifyRows(
      [
        row('2026-03-13', -2000, 'x', { currency: 'USD' }),
        row('2025-12-14', -5000, 'x', { currency: 'BGN' }),
        row('2026-04-01', -100, 'future'),
        row('2026-02-01', -100, 'before opening'),
        row('', 0, 'x', { date: null, problem: 'unreadable_date' }),
      ],
      context,
    );
    expect(rejected.map((r) => r.rejectReason)).toEqual(['foreign_currency', 'foreign_currency', 'future_date', 'before_opening', 'unreadable_date']);
    expect(rejected.every((r) => r.fingerprint === null && r.decision === 'skip')).toBe(true);
  });

  test('BR-16.4, BR-16.9: a manual entry within 3 days needs a decision; it is claimed once, nearest date first', () => {
    const candidates = [
      { transactionId: 'far', date: '2026-03-09', amount: -4560, isTransfer: false },
      { transactionId: 'near', date: '2026-03-11', amount: -4560, isTransfer: false },
    ];
    const rows = classifyRows([row('2026-03-12', -4560, 'LIDL'), row('2026-03-12', -4560, 'LIDL 2'), row('2026-03-12', -4560, 'LIDL 3')], { ...context, candidates });
    expect(rows.map((r) => [r.classification, r.candidateTransactionId, r.decision])).toEqual([
      ['possible_duplicate', 'near', null],
      ['possible_duplicate', 'far', null],
      ['new', null, 'import'],
    ]);
    expect(classes([row('2026-03-16', -4560, 'LIDL')], { candidates })).toEqual(['new']);
    expect(classes([row('2026-03-12', -4561, 'LIDL')], { candidates })).toEqual(['new']);
  });

  test('E-16: the second side of a transfer is already recorded, and linked without a decision', () => {
    const [recorded] = classifyRows([row('2026-03-12', 20000, 'Transfer from current')], {
      ...context,
      candidates: [{ transactionId: 'T', date: '2026-03-12', amount: 20000, isTransfer: true }],
    });
    expect(recorded).toMatchObject({ classification: 'already_recorded', decision: 'link', candidateTransactionId: 'T' });
  });

  test('BR-16.5: an account named in the text, or an opposite entry on another account, suggests a transfer', () => {
    const otherAccounts = [{ id: 'savings', name: 'Savings' }, { id: 'cash', name: 'Bar' }];
    expect(classifyRows([row('2026-03-12', -20000, 'Transfer to savings')], { ...context, otherAccounts })[0]).toMatchObject({ classification: 'transfer', decision: null, counterAccountId: 'savings' });
    expect(classes([row('2026-03-12', -20000, 'SAVINGSHOP')], { otherAccounts })).toEqual(['new']);
    expect(classes([row('2026-03-12', -250, 'COFFEE BAR')], { otherAccounts })).toEqual(['new']);
    const [paired] = classifyRows([row('2026-03-12', -20000, 'WIRE')], { ...context, pairs: [{ transactionId: 'P', accountId: 'savings', date: '2026-03-13', amount: 20000 }] });
    expect(paired).toMatchObject({ classification: 'transfer', candidateTransactionId: 'P', counterAccountId: 'savings' });
  });
});
