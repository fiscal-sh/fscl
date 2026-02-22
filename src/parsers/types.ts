export type ParseError = {
  message: string;
  internal?: string;
};

export type StructuredImportTransaction = {
  amount?: number | null;
  date?: string | null;
  payee_name?: string | null;
  imported_payee?: string | null;
  notes?: string | null;
  category?: string | null;
  imported_id?: string;
  [key: string]: unknown;
};

export type CsvTransaction = Record<string, string> | string[];

export type ParsedTransaction = StructuredImportTransaction | CsvTransaction;

export type ParseFileOptions = {
  hasHeaderRow?: boolean;
  delimiter?: string;
  fallbackMissingPayeeToMemo?: boolean;
  skipStartLines?: number;
  skipEndLines?: number;
  importNotes?: boolean;
};

export type ParseFileResult = {
  errors: ParseError[];
  transactions: ParsedTransaction[];
  fileType: 'csv' | 'qif' | 'ofx' | 'camt' | 'unknown';
};
