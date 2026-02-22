import type { PrimitiveRecordValue } from './types.js';

type Row = Record<string, unknown>;

let activeColumnFilter: string[] | undefined;

export function setColumnFilter(cols: string[] | undefined) {
  activeColumnFilter = cols && cols.length > 0 ? cols : undefined;
}

function toTableCell(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function buildColumns(rows: Row[], columns?: string[]): string[] {
  if (columns && columns.length > 0) {
    return columns;
  }
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
      }
    }
  }
  return [...seen];
}

function printTableRows(rows: Row[], columns?: string[]) {
  const cols = buildColumns(rows, columns);
  if (cols.length === 0) {
    return;
  }
  const widths = cols.map(col => col.length);
  const rendered = rows.map(row =>
    cols.map((col, i) => {
      const value = toTableCell(row[col]);
      widths[i] = Math.max(widths[i], value.length);
      return value;
    }),
  );

  const line = cols.map((col, i) => col.padEnd(widths[i], ' ')).join('  ');
  const sep = widths.map(width => '-'.repeat(width)).join('  ');
  console.log(line);
  console.log(sep);
  for (const row of rendered) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i], ' ')).join('  '));
  }
}

function applyColumnFilter(columns?: string[]): string[] | undefined {
  if (!activeColumnFilter || activeColumnFilter.length === 0) {
    return columns;
  }
  if (!columns || columns.length === 0) {
    return [...activeColumnFilter];
  }
  const filterSet = new Set(activeColumnFilter);
  return columns.filter(column => filterSet.has(column));
}

function projectRows(
  rows: Row[],
  columns?: string[],
): { rows: Row[]; columns?: string[] } {
  const effectiveColumns = applyColumnFilter(columns);
  if (!effectiveColumns || effectiveColumns.length === 0) {
    return { rows, columns: effectiveColumns };
  }
  return {
    rows: rows.map(row => {
      const projected: Row = {};
      for (const column of effectiveColumns) {
        const value = row[column];
        projected[column] = value === undefined ? null : value;
      }
      return projected;
    }),
    columns: effectiveColumns,
  };
}

export function printStatusOk(fields: Record<string, PrimitiveRecordValue> = {}) {
  printJson({
    status: 'ok',
    ...fields,
  });
}

export function printStatusErr(
  message: string,
  fields: Record<string, PrimitiveRecordValue> = {},
) {
  printJson({
    status: 'err',
    message,
    ...fields,
  });
}

export function printRowsTable(rows: Row[], columns?: string[]) {
  printTableRows(rows, columns);
}

export function printRows(
  format: 'json' | 'table',
  entity: string,
  rows: Row[],
  columns?: string[],
  extra: Record<string, PrimitiveRecordValue> = {},
) {
  const projected = projectRows(rows, columns);
  if (format === 'table') {
    printRowsTable(projected.rows, projected.columns);
    return;
  }
  printJson({
    status: 'ok',
    entity,
    count: projected.rows.length,
    ...extra,
    data: projected.rows,
  });
}

export function printErrorMessages(errors: string[]): void {
  if (errors.length === 0) {
    return;
  }
  printJson({
    status: 'err',
    entity: 'errors',
    count: errors.length,
    errors,
  });
}

export function printDraftValidationErrors(
  entity: string,
  errors: Array<{ path: string; message: string }>,
): void {
  printJson({
    status: 'err',
    entity,
    count: errors.length,
    errors,
  });
}

export function printObject(object: Record<string, unknown>): void {
  printJson(object);
}
