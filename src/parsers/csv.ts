import { parse } from 'csv-parse/sync';

import type { CsvTransaction } from './types.js';

export type CsvFieldMappings = {
  date: string | null;
  amount: string | null;
  payee: string | null;
  notes: string | null;
  category: string | null;
  outflow: string | null;
  inflow: string | null;
  inOut: string | null;
};

type CsvParseOptions = {
  hasHeaderRow?: boolean;
  delimiter?: string;
};

export function parseCsv(
  contents: string,
  options: CsvParseOptions = {},
): CsvTransaction[] {
  return parse(contents, {
    columns: options.hasHeaderRow,
    bom: true,
    delimiter: options.delimiter || ',',
    quote: '"',
    trim: true,
    relax_column_count: true,
    skip_empty_lines: true,
  }) as CsvTransaction[];
}

export function normalizeFieldRef(
  ref: string | number | null | undefined,
): string | null {
  if (ref == null) {
    return null;
  }
  return String(ref).trim() || null;
}

function objectKeys(row: CsvTransaction): string[] {
  if (Array.isArray(row)) {
    return row.map((_, index) => String(index));
  }
  return Object.keys(row);
}

export function readCsvCell(
  row: CsvTransaction,
  ref: string | null | undefined,
): unknown {
  if (ref == null) {
    return undefined;
  }

  const trimmed = ref.trim();
  if (Array.isArray(row)) {
    const index = Number(trimmed);
    return Number.isInteger(index) ? row[index] : undefined;
  }

  if (trimmed in row) {
    return row[trimmed];
  }

  const index = Number(trimmed);
  if (Number.isInteger(index)) {
    const keys = Object.keys(row);
    const key = keys[index];
    return key ? row[key] : undefined;
  }

  return undefined;
}

function keyFromEntries(
  entries: Array<[string, string]>,
  match: (name: string, value: string) => boolean,
): string | null {
  const found = entries.find(([name, value]) => match(name, value));
  return found ? found[0] : null;
}

export function detectCsvMappings(transactions: CsvTransaction[]): CsvFieldMappings {
  if (transactions.length === 0) {
    return {
      date: null,
      amount: null,
      payee: null,
      notes: null,
      category: null,
      outflow: null,
      inflow: null,
      inOut: null,
    };
  }

  const first = transactions[0];
  const entries: Array<[string, string]> = objectKeys(first).map(key => [
    key,
    String(readCsvCell(first, key) ?? ''),
  ]);

  const date = keyFromEntries(
    entries,
    (name, value) =>
      name.toLowerCase().includes('date') ||
      /^\d+[-/]\d+[-/]\d+$/.test(value),
  );
  const amount = keyFromEntries(
    entries,
    (name, value) =>
      name.toLowerCase().includes('amount') || /^-?[.,\d]+$/.test(value),
  );
  const category = keyFromEntries(
    entries,
    name => name.toLowerCase().includes('category'),
  );
  const payee = keyFromEntries(
    entries,
    name => name.toLowerCase().includes('payee'),
  );
  const notes = keyFromEntries(
    entries,
    name => name.toLowerCase().includes('note') || name.toLowerCase().includes('memo'),
  );
  const outflow = keyFromEntries(
    entries,
    name => name.toLowerCase().includes('outflow') || name.toLowerCase().includes('debit'),
  );
  const inflow = keyFromEntries(
    entries,
    name => name.toLowerCase().includes('inflow') || name.toLowerCase().includes('credit'),
  );
  const inOut = keyFromEntries(entries, name => name.toLowerCase().includes('in/out'));

  return {
    date,
    amount,
    payee,
    notes,
    category,
    outflow,
    inflow,
    inOut,
  };
}

export function applyLineSkips(
  contents: string,
  skipStartLines = 0,
  skipEndLines = 0,
): string {
  const start = Math.max(0, skipStartLines);
  const end = Math.max(0, skipEndLines);
  if (start === 0 && end === 0) {
    return contents;
  }

  const lines = contents.split(/\r?\n/);
  if (start + end >= lines.length) {
    throw new Error(
      `Cannot skip ${start + end} lines from file with ${lines.length} lines`,
    );
  }

  const startLine = start;
  const endLine = end > 0 ? lines.length - end : lines.length;
  return lines.slice(startLine, endLine).join('\r\n');
}
