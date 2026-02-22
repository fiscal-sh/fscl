export type OutputFormat = 'json' | 'table';

export type Config = {
  dataDir?: string;
  activeBudgetId?: string;
  serverURL?: string;
  token?: string;
};

export type GlobalOptions = {
  dataDir?: string;
  budget?: string;
  serverUrl?: string;
  json?: boolean;
  columns?: string;
};

export type SessionOptions = {
  dataDir?: string;
  budget?: string;
  serverURL?: string;
  token?: string;
  write?: boolean;
};

export type ResolvedSessionOptions = {
  dataDir: string;
  budgetId?: string;
  serverURL?: string;
  token?: string;
  write: boolean;
};

export type PrimitiveRecordValue = string | number | boolean | null | undefined;
