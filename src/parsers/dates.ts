import { isValid, parseISO } from 'date-fns';

export type DateFormat =
  | 'yyyy mm dd'
  | 'yy mm dd'
  | 'mm dd yyyy'
  | 'mm dd yy'
  | 'dd mm yyyy'
  | 'dd mm yy';

export const dateFormats: DateFormat[] = [
  'yyyy mm dd',
  'yy mm dd',
  'mm dd yyyy',
  'mm dd yy',
  'dd mm yyyy',
  'dd mm yy',
];

export function dayFromDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function parseDate(
  value: string | number | null | Array<unknown> | object,
  order: DateFormat,
): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const source = value.trim();
  if (!source) {
    return null;
  }

  const withMonthDigits = source
    .replace(/\bjan(\.|uary)?\b/i, '01')
    .replace(/\bfeb(\.|ruary)?\b/i, '02')
    .replace(/\bmar(\.|ch)?\b/i, '03')
    .replace(/\bapr(\.|il)?\b/i, '04')
    .replace(/\bmay\.?\b/i, '05')
    .replace(/\bjun(\.|e)?\b/i, '06')
    .replace(/\bjul(\.|y)?\b/i, '07')
    .replace(/\baug(\.|ust)?\b/i, '08')
    .replace(/\bsep(\.|tember)?\b/i, '09')
    .replace(/\boct(\.|ober)?\b/i, '10')
    .replace(/\bnov(\.|ember)?\b/i, '11')
    .replace(/\bdec(\.|ember)?\b/i, '12');

  const digits = withMonthDigits.split(/[^\d]+/).filter(Boolean);

  const fallbackDigits = withMonthDigits.replace(/[^\d]/g, '');
  const fromLayout = (a: number, b: number): string[] => {
    if (digits.length >= 3) {
      return digits.slice(0, 3);
    }
    return [
      fallbackDigits.slice(0, a),
      fallbackDigits.slice(a, a + b),
      fallbackDigits.slice(a + b),
    ];
  };

  let year = '';
  let month = '';
  let day = '';

  switch (order) {
    case 'dd mm yyyy': {
      const parts = fromLayout(2, 2);
      day = parts[0];
      month = parts[1];
      year = parts[2];
      break;
    }
    case 'dd mm yy': {
      const parts = fromLayout(2, 2);
      day = parts[0];
      month = parts[1];
      year = `20${parts[2]}`;
      break;
    }
    case 'yyyy mm dd': {
      const parts = fromLayout(4, 2);
      year = parts[0];
      month = parts[1];
      day = parts[2];
      break;
    }
    case 'yy mm dd': {
      const parts = fromLayout(2, 2);
      year = `20${parts[0]}`;
      month = parts[1];
      day = parts[2];
      break;
    }
    case 'mm dd yy': {
      const parts = fromLayout(2, 2);
      month = parts[0];
      day = parts[1];
      year = `20${parts[2]}`;
      break;
    }
    default: {
      const parts = fromLayout(2, 2);
      month = parts[0];
      day = parts[1];
      year = parts[2];
      break;
    }
  }

  const normalized = `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  if (!isValid(parseISO(normalized))) {
    return null;
  }
  return normalized;
}

export function detectDateFormat(
  sample: string | undefined | null,
): DateFormat | null {
  if (!sample) {
    return null;
  }
  for (const format of dateFormats) {
    if (parseDate(sample, format) != null) {
      return format;
    }
  }
  return null;
}
