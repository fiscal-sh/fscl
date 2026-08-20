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
  offline?: boolean;
  fresh?: boolean;
};

export type SessionOptions = {
  dataDir?: string;
  budget?: string;
  serverURL?: string;
  token?: string;
  write?: boolean;
  offline?: boolean;
  fresh?: boolean;
};

export type ResolvedSessionOptions = {
  dataDir: string;
  budgetId?: string;
  serverURL?: string;
  token?: string;
  write: boolean;
  offline: boolean;
  fresh: boolean;
};
