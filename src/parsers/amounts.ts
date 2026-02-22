const MAX_SAFE_NUMBER = Number.MAX_SAFE_INTEGER;
const MIN_SAFE_NUMBER = Number.MIN_SAFE_INTEGER;

function safeNumber(value: number): number | null {
  if (Number.isNaN(value)) {
    return null;
  }
  const centValue = value * 100;
  if (centValue > MAX_SAFE_NUMBER || centValue < MIN_SAFE_NUMBER) {
    return null;
  }
  return value;
}

export function looselyParseAmount(input: string): number | null {
  if (typeof input !== 'string') {
    return null;
  }

  let amount = input.trim();
  if (!amount) {
    return null;
  }

  if (amount.startsWith('(') && amount.endsWith(')')) {
    amount = amount.replace(/\u2212/g, '');
    amount = amount.replace('(', '-').replace(')', '');
  } else {
    amount = amount.replace(/\u2212/g, '-');
  }

  const extractNumbers = (value: string): string => value.replace(/[^0-9-]/g, '');
  const match = amount.match(/[.,]([^.,]{4,9}|[^.,]{1,2})$/);
  if (!match || match.index == null) {
    return safeNumber(parseFloat(extractNumbers(amount)));
  }

  const left = extractNumbers(amount.slice(0, match.index));
  const right = extractNumbers(amount.slice(match.index + 1));
  return safeNumber(parseFloat(`${left}.${right}`));
}

export function parseOfxAmount(rawAmount: string): number | null {
  if (!rawAmount || typeof rawAmount !== 'string') {
    return null;
  }

  let cleaned = rawAmount.trim();
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    cleaned = '-' + cleaned.slice(1, -1);
  }

  cleaned = cleaned.replace(/[^\d.-]/g, '');
  const decimalIndex = cleaned.indexOf('.');
  if (decimalIndex !== -1) {
    const beforeDecimal = cleaned.slice(0, decimalIndex);
    const afterDecimal = cleaned.slice(decimalIndex + 1).replace(/\./g, '');
    cleaned = `${beforeDecimal}.${afterDecimal}`;
  }

  if (!cleaned || cleaned === '-' || cleaned === '.') {
    return null;
  }

  const parsed = parseFloat(cleaned);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseAmount(
  value: number | string | null | undefined,
  mapper: (parsed: number) => number,
): number | null {
  if (value == null) {
    return null;
  }
  const parsed = typeof value === 'string' ? looselyParseAmount(value) : value;
  if (parsed == null) {
    return null;
  }
  return mapper(parsed);
}

export function parseAmountFields(
  transaction: Partial<Record<string, unknown>>,
  splitMode: boolean,
  inOutMode: boolean,
  outValue: string,
  flipAmount: boolean,
  multiplierAmount: string,
): { amount: number | null; outflow: number | null; inflow: number | null } {
  const multiplier = parseFloat(multiplierAmount) || 1;
  const value = { outflow: 0, inflow: 0 };

  if (splitMode && !inOutMode) {
    value.outflow =
      parseAmount(transaction.outflow as number | string | null, n => -Math.abs(n)) || 0;
    value.inflow = value.outflow
      ? 0
      : parseAmount(transaction.inflow as number | string | null, n => Math.abs(n)) || 0;
  } else {
    const amount =
      parseAmount(transaction.amount as number | string | null, n => n) || 0;
    if (amount >= 0) {
      value.inflow = amount;
    } else {
      value.outflow = amount;
    }
  }

  if (inOutMode) {
    const transactionValue = value.outflow || value.inflow;
    if (String(transaction.inOut ?? '') === outValue) {
      value.outflow = -Math.abs(transactionValue);
      value.inflow = 0;
    } else {
      value.inflow = Math.abs(transactionValue);
      value.outflow = 0;
    }
  }

  if (flipAmount) {
    const oldInflow = value.inflow;
    value.inflow = Math.abs(value.outflow);
    value.outflow = -Math.abs(oldInflow);
  }

  value.inflow *= multiplier;
  value.outflow *= multiplier;

  if (splitMode) {
    return {
      amount: value.outflow || value.inflow,
      outflow: value.outflow,
      inflow: value.inflow,
    };
  }
  return {
    amount: value.outflow || value.inflow,
    outflow: null,
    inflow: null,
  };
}
