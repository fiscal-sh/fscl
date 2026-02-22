import { readFileSync } from 'node:fs';

import { parseCsv, applyLineSkips } from './csv.js';
import { looselyParseAmount, parseOfxAmount } from './amounts.js';
import { camtToJson } from './camt.js';
import { ofxToJson } from './ofx.js';
import { qifToJson } from './qif.js';
import type {
  ParseFileOptions,
  ParseFileResult,
  StructuredImportTransaction,
} from './types.js';

function extension(filePath: string): string {
  const match = filePath.match(/\.[^.]*$/);
  return match ? match[0].toLowerCase() : '';
}

export async function parseFile(
  filePath: string,
  options: ParseFileOptions = {},
): Promise<ParseFileResult> {
  const errors = [] as ParseFileResult['errors'];
  const ext = extension(filePath);

  if (ext === '.csv' || ext === '.tsv') {
    try {
      let contents = readFileSync(filePath, 'utf8');
      contents = applyLineSkips(
        contents,
        options.skipStartLines,
        options.skipEndLines,
      );
      const transactions = parseCsv(contents, {
        hasHeaderRow: options.hasHeaderRow,
        delimiter: options.delimiter || (ext === '.tsv' ? '\t' : ','),
      });
      return { errors, transactions, fileType: 'csv' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      errors.push({ message: `Failed parsing CSV: ${message}`, internal: message });
      return { errors, transactions: [], fileType: 'csv' };
    }
  }

  if (ext === '.qif') {
    try {
      const contents = readFileSync(filePath, 'utf8');
      const parsed = qifToJson(contents);
      const transactions = parsed.transactions
        .map(
          tx =>
            ({
              amount:
                tx.amount != null ? looselyParseAmount(String(tx.amount)) : null,
              date: tx.date ?? null,
              payee_name: tx.payee ?? null,
              imported_payee: tx.payee ?? null,
              notes: options.importNotes ? tx.memo || null : null,
            }) satisfies StructuredImportTransaction,
        )
        .filter(tx => tx.date != null && tx.amount != null);
      return { errors, transactions, fileType: 'qif' };
    } catch (error) {
      const stack = error instanceof Error ? error.stack || error.message : '';
      errors.push({
        message: "Failed parsing: doesn't look like a valid QIF file.",
        internal: stack,
      });
      return { errors, transactions: [], fileType: 'qif' };
    }
  }

  if (ext === '.ofx' || ext === '.qfx') {
    try {
      const contents = readFileSync(filePath, 'utf8');
      const parsed = await ofxToJson(contents);
      const transactions = parsed.transactions.map(tx => {
        const amount = parseOfxAmount(tx.amount);
        if (amount == null) {
          errors.push({
            message: `Invalid amount format: ${tx.amount}`,
            internal: `Failed to parse amount: ${tx.amount}`,
          });
        }
        const payee =
          tx.name || (options.fallbackMissingPayeeToMemo ? tx.memo : null);
        return {
          amount: amount ?? 0,
          imported_id: tx.fitId || undefined,
          date: tx.date,
          payee_name: payee,
          imported_payee: payee,
          notes: options.importNotes ? tx.memo || null : null,
        } satisfies StructuredImportTransaction;
      });
      return { errors, transactions, fileType: 'ofx' };
    } catch (error) {
      const stack = error instanceof Error ? error.stack || error.message : '';
      errors.push({ message: 'Failed importing OFX file', internal: stack });
      return { errors, transactions: [], fileType: 'ofx' };
    }
  }

  if (ext === '.xml') {
    try {
      const contents = readFileSync(filePath, 'utf8');
      const transactions = await camtToJson(contents);
      return {
        errors,
        transactions: transactions.map(tx => ({
          ...tx,
          notes: options.importNotes ? tx.notes : null,
        })),
        fileType: 'camt',
      };
    } catch (error) {
      const stack = error instanceof Error ? error.stack || error.message : '';
      errors.push({ message: 'Failed importing CAMT file', internal: stack });
      return { errors, transactions: [], fileType: 'camt' };
    }
  }

  errors.push({ message: 'Invalid file type', internal: '' });
  return { errors, transactions: [], fileType: 'unknown' };
}
