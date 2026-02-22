import { parseStringPromise } from 'xml2js';

import type { StructuredImportTransaction } from './types.js';

type DateRef = { DtTm: string } | { Dt: string };
type AmountRef = { _: string };

type Entry = {
  AcctSvcrRef?: string;
  Amt?: AmountRef;
  CdtDbtInd: 'CRDT' | 'DBIT';
  ValDt?: DateRef;
  BookgDt?: DateRef;
  NtryDtls?: EntryDetails;
  AddtlNtryInf?: string;
  NtryRef?: string;
};

type EntryDetails = {
  TxDtls: TxDetails | TxDetails[];
};

type TxDetails = {
  RltdPties?: {
    Cdtr: { Nm: string };
    Dbtr: { Nm: string };
  };
  RmtInf?: {
    Ustrd: string | string[];
  };
};

function findKeys(source: Record<string, unknown>, key: string): unknown[] {
  let result: unknown[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (name === key) {
      if (Array.isArray(value)) {
        result = result.concat(value);
      } else {
        result.push(value);
      }
    }
    if (value && typeof value === 'object') {
      result = result.concat(findKeys(value as Record<string, unknown>, key));
    }
  }
  return result;
}

function getPayeeName(details: TxDetails | undefined, isDebit: boolean): string | null {
  if (!details?.RltdPties) {
    return null;
  }
  const party = isDebit ? details.RltdPties.Cdtr : details.RltdPties.Dbtr;
  const names = findKeys(party as Record<string, unknown>, 'Nm');
  return names.length > 0 ? String(names[0]) : null;
}

function getNotes(details: TxDetails | undefined): string | null {
  if (!details?.RmtInf) {
    return null;
  }
  const value = details.RmtInf.Ustrd;
  return Array.isArray(value) ? value.join(' ') : value;
}

function parseNumber(value?: string): number | null {
  if (value == null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function toDate(dateRef?: DateRef): string | null {
  if (!dateRef) {
    return null;
  }
  if ('DtTm' in dateRef) {
    return dateRef.DtTm.slice(0, 10);
  }
  return dateRef.Dt ?? null;
}

export async function camtToJson(
  input: string,
): Promise<StructuredImportTransaction[]> {
  const data = (await parseStringPromise(input, {
    explicitArray: false,
  })) as Record<string, unknown>;
  const entries = findKeys(data, 'Ntry') as Entry[];
  const transactions: StructuredImportTransaction[] = [];

  for (const entry of entries) {
    const id = entry.AcctSvcrRef;
    const baseAmount = parseNumber(entry.Amt?._);
    const isDebit = entry.CdtDbtInd === 'DBIT';
    const date = toDate(entry.ValDt) || toDate(entry.BookgDt);

    const txDetails = entry.NtryDtls?.TxDtls;
    if (Array.isArray(txDetails)) {
      for (const sub of txDetails) {
        const subAmountNode = findKeys(sub as Record<string, unknown>, 'Amt') as AmountRef[];
        const subAmount = subAmountNode.length > 0 ? parseNumber(subAmountNode[0]._) : null;
        transactions.push({
          amount: subAmount == null ? null : isDebit ? -subAmount : subAmount,
          date,
          payee_name: getPayeeName(sub, isDebit),
          imported_payee: getPayeeName(sub, isDebit),
          notes: getNotes(sub),
        });
      }
      continue;
    }

    let payee = getPayeeName(txDetails, isDebit);
    let notes = getNotes(txDetails);
    if (!payee && entry.AddtlNtryInf) {
      payee = entry.AddtlNtryInf;
    }
    if (!notes && entry.AddtlNtryInf && entry.AddtlNtryInf !== payee) {
      notes = entry.AddtlNtryInf;
    }
    if (!payee && !notes && entry.NtryRef) {
      notes = entry.NtryRef;
    }
    if (payee && notes && payee.includes(notes)) {
      notes = null;
    }

    const transaction: StructuredImportTransaction = {
      amount: baseAmount == null ? null : isDebit ? -baseAmount : baseAmount,
      date,
      payee_name: payee,
      imported_payee: payee,
      notes,
    };
    if (id) {
      transaction.imported_id = id;
    }
    transactions.push(transaction);
  }

  return transactions.filter(
    item => item.date != null && item.amount != null,
  );
}
