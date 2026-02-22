import { parseStringPromise } from 'xml2js';

import { dayFromDate } from './dates.js';

type OfxTransaction = {
  amount: string;
  fitId: string;
  name: string;
  date: string;
  memo: string;
  type: string;
};

type OfxParseResult = {
  headers: Record<string, unknown>;
  transactions: OfxTransaction[];
};

function sgmlToXml(sgml: string): string {
  return sgml
    .replace(/&/g, '&#038;')
    .replace(/&amp;/g, '&#038;')
    .replace(/>\s+</g, '><')
    .replace(/\s+</g, '<')
    .replace(/>\s+/g, '>')
    .replace(/\.(?=[^<>]*>)/g, '')
    .replace(/<(\w+?)>([^<]+)/g, '<$1>$2</<added>$1>')
    .replace(/<\/<added>(\w+?)>(<\/\1>)?/g, '</$1>');
}

function htmlToPlain(value?: string): string {
  return (
    value
      ?.replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/(&amp;|&#038;)/g, '&') || ''
  );
}

async function parseXml(content: string): Promise<unknown> {
  return parseStringPromise(content, {
    explicitArray: false,
    trim: true,
  });
}

function asArray<T>(value: T | T[] | undefined): T[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function getStmtTransactions(parsed: Record<string, unknown>): unknown[] {
  const ofx = parsed['OFX'] as Record<string, unknown> | undefined;
  if (!ofx) {
    return [];
  }
  if (ofx['CREDITCARDMSGSRSV1'] != null) {
    const msg = ofx['CREDITCARDMSGSRSV1'] as Record<string, unknown>;
    const stmtResponses = asArray<Record<string, unknown>>(
      msg['CCSTMTTRNRS'] as
        | Record<string, unknown>
        | Record<string, unknown>[]
        | undefined,
    );
    return stmtResponses.flatMap(response => {
      const stmt = response['CCSTMTRS'] as Record<string, unknown>;
      const list = stmt?.['BANKTRANLIST'] as Record<string, unknown>;
      return asArray<Record<string, unknown>>(
        list?.['STMTTRN'] as
          | Record<string, unknown>
          | Record<string, unknown>[]
          | undefined,
      );
    });
  }
  if (ofx['INVSTMTMSGSRSV1'] != null) {
    const msg = ofx['INVSTMTMSGSRSV1'] as Record<string, unknown>;
    const stmtResponses = asArray<Record<string, unknown>>(
      msg['INVSTMTTRNRS'] as
        | Record<string, unknown>
        | Record<string, unknown>[]
        | undefined,
    );
    return stmtResponses.flatMap(response => {
      const stmt = response['INVSTMTRS'] as Record<string, unknown>;
      const list = stmt?.['INVTRANLIST'] as Record<string, unknown>;
      const invBankTrn = asArray<Record<string, unknown>>(
        list?.['INVBANKTRAN'] as
          | Record<string, unknown>
          | Record<string, unknown>[]
          | undefined,
      );
      return invBankTrn.flatMap(item =>
        asArray<Record<string, unknown>>(
          item?.['STMTTRN'] as
            | Record<string, unknown>
            | Record<string, unknown>[]
            | undefined,
        ),
      );
    });
  }

  const msg = ofx['BANKMSGSRSV1'] as Record<string, unknown> | undefined;
  const stmtResponses = asArray<Record<string, unknown>>(
    msg?.['STMTTRNRS'] as
      | Record<string, unknown>
      | Record<string, unknown>[]
      | undefined,
  );
  return stmtResponses.flatMap(response => {
    const stmt = response['STMTRS'] as Record<string, unknown>;
    const list = stmt?.['BANKTRANLIST'] as Record<string, unknown>;
    return asArray<Record<string, unknown>>(
      list?.['STMTTRN'] as
        | Record<string, unknown>
        | Record<string, unknown>[]
        | undefined,
    );
  });
}

function mapOfxTransaction(transaction: Record<string, unknown>): OfxTransaction {
  const dtPosted = transaction['DTPOSTED'] as string | undefined;
  const txDate = dtPosted
    ? new Date(
        Number(dtPosted.substring(0, 4)),
        Number(dtPosted.substring(4, 6)) - 1,
        Number(dtPosted.substring(6, 8)),
      )
    : null;

  return {
    amount: String(transaction['TRNAMT'] ?? ''),
    type: String(transaction['TRNTYPE'] ?? ''),
    fitId: String(transaction['FITID'] ?? ''),
    date: txDate ? dayFromDate(txDate) : '',
    name: htmlToPlain(String(transaction['NAME'] ?? '')),
    memo: htmlToPlain(String(transaction['MEMO'] ?? '')),
  };
}

export async function ofxToJson(input: string): Promise<OfxParseResult> {
  const parts = input.split(/<OFX\s?>/, 2);

  const headerString = (parts[0] || '').split(/\r?\n/);
  const headers: Record<string, unknown> = {};
  for (const line of headerString) {
    if (!line) {
      continue;
    }
    const header = line.split(/:/, 2);
    headers[header[0]] = header[1];
  }

  const content = `<OFX>${parts[1] || ''}`;
  let parsed: Record<string, unknown>;
  try {
    parsed = (await parseXml(content)) as Record<string, unknown>;
  } catch {
    parsed = (await parseXml(sgmlToXml(content))) as Record<string, unknown>;
  }

  return {
    headers,
    transactions: getStmtTransactions(parsed).map(item =>
      mapOfxTransaction(item as Record<string, unknown>),
    ),
  };
}
