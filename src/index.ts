import { Command } from 'commander';

import { getConfigPath } from './config.js';
import { registerAccountCommands } from './commands/accounts.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerMonthCommands } from './commands/budget-amounts.js';
import { registerBudgetCommands } from './commands/budgets.js';
import { registerCategoryCommands } from './commands/categories.js';
import { registerInitCommand } from './commands/init.js';
import { registerPayeeCommands } from './commands/payees.js';
import { registerQueryCommand } from './commands/query.js';
import { registerRuleCommands } from './commands/rules.js';
import { registerScheduleCommands } from './commands/schedules.js';
import { registerStatusCommand } from './commands/status.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerTagCommands } from './commands/tags.js';
import { registerTransactionCommands } from './commands/transactions.js';

const program = new Command();

program
  .name('fiscal')
  .description('Headless CLI for Actual Budget')
  .showHelpAfterError()
  .configureHelp({ showGlobalOptions: true })
  .option('--data-dir <path>', 'Path to Actual data directory')
  .option('--budget <id>', 'Active budget id')
  .option('--server-url <url>', 'Actual server URL for sync mode')
  .option('--json', 'Output as JSON instead of table')
  .option('--columns <cols>', 'Comma-separated column filter for list output')
  .addHelpText(
    'after',
    `\nConfig file: ${getConfigPath()}\nEnv: FISCAL_SERVER_URL`,
  );

registerSyncCommand(program);
registerStatusCommand(program);
registerAuthCommands(program);
registerInitCommand(program);
registerBudgetCommands(program);
registerAccountCommands(program);
registerTransactionCommands(program);
registerCategoryCommands(program);
registerPayeeCommands(program);
registerMonthCommands(program);
registerRuleCommands(program);
registerScheduleCommands(program);
registerTagCommands(program);
registerQueryCommand(program);

await program.parseAsync(process.argv);
