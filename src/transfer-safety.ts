import { api } from './actual-api.js';

/**
 * Return transfer rows for which a category has no budgeting meaning. Actual
 * clears categories when both sides have the same on/off-budget status. For a
 * mixed transfer, only the on-budget half has budgeting meaning.
 */
export async function getCategoryIrrelevantTransferIds(
  transactions: Array<Record<string, unknown>>,
): Promise<Set<string>> {
  const transfers = transactions.filter(
    transaction => transaction.transfer_id && typeof transaction.id === 'string',
  );
  if (transfers.length === 0) {
    return new Set();
  }

  const [accounts, payees] = await Promise.all([
    api.getAccounts() as Promise<Array<Record<string, unknown>>>,
    api.getPayees() as Promise<Array<Record<string, unknown>>>,
  ]);
  const offBudgetByAccount = new Map<string, boolean>();
  for (const account of accounts) {
    if (typeof account.id === 'string') {
      offBudgetByAccount.set(account.id, Boolean(account.offbudget));
    }
  }
  const transferAccountByPayee = new Map<string, string>();
  for (const payee of payees) {
    if (typeof payee.id === 'string' && typeof payee.transfer_acct === 'string') {
      transferAccountByPayee.set(payee.id, payee.transfer_acct);
    }
  }

  const irrelevant = new Set<string>();
  for (const transaction of transfers) {
    const sourceAccount = typeof transaction.account === 'string'
      ? transaction.account
      : undefined;
    const transferAccount = typeof transaction.payee === 'string'
      ? transferAccountByPayee.get(transaction.payee)
      : undefined;
    if (!sourceAccount || !transferAccount) {
      continue;
    }
    const sourceOffBudget = offBudgetByAccount.get(sourceAccount);
    const transferOffBudget = offBudgetByAccount.get(transferAccount);
    if (
      sourceOffBudget !== undefined &&
      transferOffBudget !== undefined &&
      (sourceOffBudget === transferOffBudget || sourceOffBudget)
    ) {
      irrelevant.add(String(transaction.id));
    }
  }
  return irrelevant;
}

export async function partitionCategoryRelevantTransactions(
  transactions: Array<Record<string, unknown>>,
): Promise<{
  kept: Array<Record<string, unknown>>;
  skippedTransfers: number;
}> {
  const irrelevantIds = await getCategoryIrrelevantTransferIds(transactions);
  return {
    kept: transactions.filter(transaction => !irrelevantIds.has(String(transaction.id))),
    skippedTransfers: irrelevantIds.size,
  };
}
