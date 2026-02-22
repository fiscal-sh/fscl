type Division = {
  category?: string;
  subcategory?: string;
  description?: string;
  amount?: number;
};

type QifTransaction = {
  date?: string;
  amount?: string;
  number?: string;
  memo?: string;
  address?: string[];
  clearedStatus?: string;
  category?: string;
  subcategory?: string;
  payee?: string;
  division?: Division[];
};

export function qifToJson(
  input: string,
  options: { dateFormat?: string } = {},
): {
  dateFormat: string | undefined;
  type?: string;
  transactions: QifTransaction[];
} {
  const lines = input.split('\n').filter(Boolean);
  let line = lines.shift();
  const typeMatch = /!Type:([^$]*)$/.exec((line || '').trim());
  const data = {
    dateFormat: options.dateFormat,
    transactions: [] as QifTransaction[],
    type: typeMatch?.[1],
  };

  if (!typeMatch || typeMatch.length === 0) {
    throw new Error(`File does not appear to be a valid qif file: ${line}`);
  }

  let transaction: QifTransaction = {};
  let division: Division = {};

  while ((line = lines.shift())) {
    line = line.trim();
    if (line === '^') {
      data.transactions.push(transaction);
      transaction = {};
      continue;
    }

    switch (line[0]) {
      case 'D':
        transaction.date = line.slice(1);
        break;
      case 'T':
        transaction.amount = line.slice(1);
        break;
      case 'N':
        transaction.number = line.slice(1);
        break;
      case 'M':
        transaction.memo = line.slice(1);
        break;
      case 'A':
        transaction.address = (transaction.address || []).concat(line.slice(1));
        break;
      case 'P':
        transaction.payee = line.slice(1).replace(/&amp;/g, '&');
        break;
      case 'L': {
        const parts = line.slice(1).split(':');
        transaction.category = parts[0];
        if (parts[1] !== undefined) {
          transaction.subcategory = parts[1];
        }
        break;
      }
      case 'C':
        transaction.clearedStatus = line.slice(1);
        break;
      case 'S': {
        const parts = line.slice(1).split(':');
        division.category = parts[0];
        if (parts[1] !== undefined) {
          division.subcategory = parts[1];
        }
        break;
      }
      case 'E':
        division.description = line.slice(1);
        break;
      case '$':
        division.amount = parseFloat(line.slice(1));
        if (!Array.isArray(transaction.division)) {
          transaction.division = [];
        }
        transaction.division.push(division);
        division = {};
        break;
      default:
        throw new Error(`Unknown Detail Code: ${line[0]}`);
    }
  }

  if (Object.keys(transaction).length > 0) {
    data.transactions.push(transaction);
  }

  return data;
}
