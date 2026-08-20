import { api } from './actual-api.js';

import { CliError, ErrorCodes } from './cli.js';

export type TransactionUpdate = {
  id: string;
  [field: string]: unknown;
};

type PlanTransactionUpdatesOptions = {
  includeTransfers?: boolean;
};

export type TransactionUpdatePlan = {
  currentById: Map<string, Record<string, unknown>>;
  updates: TransactionUpdate[];
  unchangedIds: Set<string>;
};

function valuesEqual(left: unknown, right: unknown): boolean {
  return left === right || (left == null && right == null);
}

/**
 * Validate transaction mutation targets and reduce each payload to fields that
 * actually changed. Actual treats transfer payees as structural data: changing
 * one unlinks the transfer and deletes its counterpart, so require an explicit
 * opt-in for that operation.
 */
export async function planTransactionUpdates(
  requested: TransactionUpdate[],
  options: PlanTransactionUpdatesOptions = {},
): Promise<TransactionUpdatePlan> {
  const duplicateIds = requested
    .map(update => update.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    throw new CliError(
      `Duplicate transaction IDs in mutation payload: ${[...new Set(duplicateIds)].join(', ')}`,
      ErrorCodes.INVALID_INPUT,
    );
  }

  const result = await api.aqlQuery(
    api.q('transactions').select(['*']) as Parameters<typeof api.aqlQuery>[0],
  );
  const rows = ((result as { data?: unknown }).data ?? []) as Array<
    Record<string, unknown>
  >;
  const currentById = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (typeof row.id === 'string' && row.id) {
      currentById.set(row.id, row);
    }
  }

  const updates: TransactionUpdate[] = [];
  const unchangedIds = new Set<string>();
  for (const requestedUpdate of requested) {
    const current = currentById.get(requestedUpdate.id);
    if (!current) {
      throw new CliError(
        `Transaction '${requestedUpdate.id}' not found. Run 'fscl transactions list <account-id>' to see available transactions.`,
        ErrorCodes.ENTITY_NOT_FOUND,
      );
    }

    const changed: TransactionUpdate = { id: requestedUpdate.id };
    for (const [field, value] of Object.entries(requestedUpdate)) {
      if (field === 'id' || valuesEqual(current[field], value)) {
        continue;
      }
      if (
        field === 'payee' &&
        current.transfer_id &&
        !options.includeTransfers
      ) {
        throw new CliError(
          `Refusing to change the payee on transfer-linked transaction '${requestedUpdate.id}': Actual would delete the linked transaction '${String(current.transfer_id)}'. Re-run with --include-transfers only if that destructive unlink is intentional.`,
          ErrorCodes.INVALID_INPUT,
        );
      }
      changed[field] = value;
    }

    if (Object.keys(changed).length === 1) {
      unchangedIds.add(requestedUpdate.id);
    } else {
      updates.push(changed);
    }
  }

  return { currentById, updates, unchangedIds };
}
