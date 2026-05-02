const actualApiPackage = '@actual-app/api';

export type ActualInternalApi = {
  send(name: string, args?: unknown): Promise<unknown>;
};

type QueryBuilder = {
  filter(expr: unknown): QueryBuilder;
  unfilter(exprs: unknown): QueryBuilder;
  select(exprs?: unknown): QueryBuilder;
  calculate(expr: unknown): QueryBuilder;
  groupBy(exprs: unknown): QueryBuilder;
  orderBy(exprs: unknown): QueryBuilder;
  limit(count: number): QueryBuilder;
};

export type ActualInitConfig = {
  dataDir: string;
  verbose?: boolean;
  serverURL?: string;
  sessionToken?: string;
};

export type ActualApi = {
  internal: ActualInternalApi | null;
  init(config: ActualInitConfig): Promise<ActualInternalApi>;
  shutdown(): Promise<void>;
  sync(): Promise<unknown>;
  loadBudget(budgetId: string): Promise<unknown>;
  downloadBudget(syncId: string, options?: { password?: string }): Promise<unknown>;
  runImport(name: string, fn: () => Promise<void>): Promise<unknown>;

  getBudgets(): Promise<unknown[]>;
  getAccounts(): Promise<unknown[]>;
  getAccountBalance(id: string, cutoff?: Date): Promise<number>;
  createAccount(account: Record<string, unknown>, initialBalance?: number): Promise<string>;
  updateAccount(id: string, fields: Record<string, unknown>): Promise<unknown>;
  closeAccount(id: string, transferAccountId?: string, transferCategoryId?: string): Promise<unknown>;
  reopenAccount(id: string): Promise<unknown>;
  deleteAccount(id: string): Promise<unknown>;

  getCategories(): Promise<unknown[]>;
  getCategoryGroups(): Promise<unknown[]>;
  createCategory(category: Record<string, unknown>): Promise<string>;
  createCategoryGroup(group: Record<string, unknown>): Promise<string>;
  updateCategory(id: string, fields: Record<string, unknown>): Promise<unknown>;
  updateCategoryGroup(id: string, fields: Record<string, unknown>): Promise<unknown>;
  deleteCategory(id: string, transferCategoryId?: string): Promise<unknown>;
  deleteCategoryGroup(id: string, transferCategoryId?: string): Promise<unknown>;

  getPayees(): Promise<unknown[]>;
  getCommonPayees(): Promise<unknown[]>;
  createPayee(payee: Record<string, unknown>): Promise<string>;
  updatePayee(id: string, fields: Record<string, unknown>): Promise<unknown>;
  deletePayee(id: string): Promise<unknown>;
  mergePayees(targetId: string, mergeIds: string[]): Promise<unknown>;

  getTransactions(accountId: string, startDate: string, endDate: string): Promise<unknown[]>;
  addTransactions(accountId: string, transactions: unknown[], options?: Record<string, unknown>): Promise<unknown>;
  importTransactions(accountId: string, transactions: unknown[], options?: Record<string, unknown>): Promise<unknown>;
  deleteTransaction(id: string): Promise<unknown>;

  getRules(): Promise<unknown[]>;
  createRule(rule: Record<string, unknown>): Promise<string>;
  updateRule(rule: Record<string, unknown>): Promise<unknown>;
  deleteRule(id: string): Promise<unknown>;

  getSchedules(): Promise<unknown[]>;
  createSchedule(schedule: Record<string, unknown>): Promise<string>;
  updateSchedule(id: string, fields: Record<string, unknown>): Promise<unknown>;
  deleteSchedule(id: string): Promise<unknown>;

  getBudgetMonth(month: string): Promise<unknown>;
  getBudgetMonths(): Promise<string[]>;
  setBudgetAmount(month: string, categoryId: string, amount: number): Promise<unknown>;
  setBudgetCarryover(month: string, categoryId: string, value: boolean): Promise<unknown>;
  holdBudgetForNextMonth(month: string, amount: number): Promise<unknown>;

  q(table: string): QueryBuilder;
  aqlQuery(query: QueryBuilder): Promise<unknown>;

  utils: {
    amountToInteger(value: number): number;
    integerToAmount(value: number): number;
  };
};

export const api = (await import(actualApiPackage)) as ActualApi;
