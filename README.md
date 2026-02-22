# fscl

A command-line interface for [Actual Budget](https://actualbudget.org/) that works without running a server.

Fiscal uses `@actual-app/api` directly to manage your budget data locally. Import bank transactions, manage accounts and categories, and automate your budgeting workflow from the terminal. Optionally sync with an existing Actual Budget server when you want a visual dashboard.

## Documentation

- Full docs: [fiscal.sh/docs](https://fiscal.sh/docs)
- Skills docs: [fiscal.sh/docs/skills](https://fiscal.sh/docs/skills)

## Features

- Create and manage budgets, accounts, categories, payees, tags, and transactions
- Import financial files (CSV, QIF, OFX, QFX, CAMT) with full rule processing and deduplication
- Agent-first defaults: goal templates + rule templating/formulas are automatically enabled
- Works completely offline with no server required
- Sync with an existing Actual Budget server to view your data in the web UI
- Output designed for scripting and AI agent workflows

## Quick start

### Prerequisites

- Node.js 20+
- Optional: a running [Actual Budget server](https://actualbudget.org/docs/installing/) for sync mode

### Install

```bash
npm install -g fscl
```

### Get started

```bash
# Show help
fscl --help

# Initialize fscl (interactive)
fscl init

# Or initialize non-interactively
fscl init --non-interactive --mode local --budget-name "My Budget"

# Orientation snapshot (active budget, connectivity, key counts)
fscl status

# View available budgets
fscl budgets list

# Create an account and import transactions
fscl accounts create "Checking" --balance 1000.00
fscl transactions import <account-id> ./january.ofx
```

Both `fscl` and `fiscal` point to the same CLI binary.

### Choose init mode

- `local`: creates a budget on your machine (no server required)
- `remote`: pulls a budget that already exists on an [Actual Budget server](https://actualbudget.org/docs/installing/)

If you start in `local` mode and later want the Actual web UI, run:

```bash
fscl budgets push --server-url http://localhost:5006 --password your-password
```

### Install agent skills (optional)

If you use an AI coding agent, install the fscl skills so the agent can run budgeting workflows without you memorizing commands:

```bash
npx skills add fiscal-sh/fscl
```

Skills docs: [fiscal.sh/docs/skills](https://fiscal.sh/docs/skills)

### Talk to your agent in plain language

Example prompts:

- "Help me set up my budget with fscl."
- "Import ~/Downloads/january-checking.ofx into my checking account and categorize everything."
- "How am I doing this month?"
- "Set up my budget for next month and increase groceries to 600."

## Configuration

Fiscal stores its config at `~/.config/fscl/config.json`:

```json
{
  "dataDir": "/path/to/budget-data",
  "activeBudgetId": "your-budget-id"
}
```

### Syncing with an Actual server

To sync your data with an Actual Budget server (so you can view it in the web UI), add server credentials to your config:

```json
{
  "dataDir": "/path/to/budget-data",
  "activeBudgetId": "your-budget-id",
  "serverURL": "http://localhost:5006",
  "password": "your-password"
}
```

When a server is configured, write operations automatically sync after each change. You can also sync explicitly:

```bash
fscl sync
```

To pull down a budget that already exists on the server:

```bash
fscl budgets pull <sync-id>
```

Or use init to configure + pull in one step:

```bash
fscl init --non-interactive --mode remote \
  --server-url http://localhost:5006 --password your-password \
  --sync-id <sync-id>
```

If you want to create a new budget and sync it to the server:

```bash
fscl init --non-interactive --mode local --budget-name "My Budget"
fscl budgets push --server-url http://localhost:5006 --password your-password
```

Server credentials can also be set via CLI flags or environment variables:

| Method | Server URL | Password |
|---|---|---|
| CLI flag | `--server-url` | `--password` |
| Environment variable | `FISCAL_SERVER_URL` | `FISCAL_PASSWORD` |
| Config file | `serverURL` | `password` |

Precedence: CLI flags > environment variables > config file.

If you pass `--server-url` and/or `--password` on a successful command, fscl saves those values to config for future runs.

### Agent feature defaults

When a budget is loaded, fscl enforces this experimental-feature baseline for AI-agent workflows:

- Enabled: `goalTemplatesEnabled`, `goalTemplatesUIEnabled`, `actionTemplating`, `formulaMode`
- Disabled: `budgetAnalysisReport`, `crossoverReport`, `customThemes`

If a server is configured, any first-run flag changes are synced automatically.

## Output format

- Default: human-readable table
- Machine-readable: `--json`

## Exit codes

- `0`: success
- `1`: failure (including validation errors and partial import failures)

## Command reference

For guided workflows and examples, start with [fiscal.sh/docs](https://fiscal.sh/docs).

### Global options

```
--data-dir <path>        Path to Actual data directory
--budget <id>            Active budget id
--server-url <url>       Actual server URL for sync mode
--password <password>    Actual server password
--json                   Output as JSON instead of table
-h, --help               Show help
```

### Budgets

```
fscl budgets list                              List all budgets
fscl budgets create <name>                     Create a new budget
fscl budgets use <id>                          Set the active budget
fscl budgets delete <id> --yes                 Delete a local budget copy
fscl budgets pull <syncId>                     Download a budget from an Actual server
fscl budgets push                              Upload a local budget to an Actual server
```

### Sync

```
fscl sync                                      Push/pull changes with the configured server
```

### Status

```
fscl status                                    Show active budget, connectivity, and summary metrics
  [--compact]                                      Print reduced status fields for agent check-ins
```

Status includes:

- active budget identity and remote linkage (if any)
- server configured/reachable/version fields
- uncategorized transaction count
- account/category/payee/rule/schedule counts
- transaction date range for quick orientation

Status format options:

- `fscl status` (default table output)
- `fscl status --compact` (minimal keys for orientation)
- `fscl status --json` (structured JSON)

### Init

```
fscl init                                      Interactive first-run setup
fscl init --non-interactive                    Non-interactive setup (requires flags)
  --mode <local|remote>
  [--budget-name <name>]                         Required for local
  [--sync-id <id>]                               Optional for remote (required if multiple remote budgets)
  # If an active budget already exists, init warns but proceeds
```

Mode behavior:

- `local`: create local budget + set `activeBudgetId`
- `remote`: pull an existing remote budget + set `activeBudgetId`

Config written by init:

- always: `dataDir`, `activeBudgetId`
- remote mode: `serverURL`, `password`

On success, `fscl init` prints the same orientation snapshot as `fscl status`.

If config already has an `activeBudgetId`, init warns but proceeds, updating the active budget.

### Accounts

```
fscl accounts list                             List all accounts
fscl accounts create <name>                    Create an account
  [--offbudget]                                    Mark as off-budget
  [--balance <amount>]                             Initial balance (e.g. 1500.00)
fscl accounts create-batch <json>              Create multiple accounts from JSON
fscl accounts update <id>                      Update an account
  [--name <name>]
  [--offbudget]                                    Mark as off-budget
  [--no-offbudget]                                 Mark as on-budget
fscl accounts close <id>                       Close an account
  [--transfer-to <accountId>]                      Transfer remaining balance
  [--transfer-category <categoryId>]               Category for the transfer
fscl accounts reopen <id>                      Reopen a closed account
fscl accounts delete <id>                      Delete an account
  --yes                                            Confirm deletion
fscl accounts balance <id>                     Get account balance
  [--cutoff <date>]                                Balance as of date (YYYY-MM-DD)
```

### Transactions

```
fscl transactions list <accountId>             List transactions for an account within a date range
  --start <date>                                   Start date (YYYY-MM-DD)
  --end <date>                                     End date (YYYY-MM-DD)
fscl transactions uncategorized                List uncategorized transactions across all accounts
  [--account <id>]                                 Filter by account
  [--start <date>] [--end <date>]                  Optional date range (YYYY-MM-DD)
fscl transactions categorize draft             Generate categorize draft JSON from uncategorized transactions
  [--account <id>]                                 Filter by account
  [--start <date>] [--end <date>]                  Optional date range (YYYY-MM-DD)
  [--limit <n>]                                    Max rows
fscl transactions categorize apply             Apply categorize draft JSON
  [--dry-run]                                      Preview only
fscl transactions add <accountId>              Add a transaction
  --date <date>                                    Date (YYYY-MM-DD)
  --amount <amount>                                Amount (e.g. -45.99)
  [--payee <name>]                                 Payee name
  [--category <id>]                                Category ID
  [--notes <text>]                                 Notes
  [--cleared]                                      Mark as cleared
fscl transactions edit draft                   Generate edit draft JSON from matching transactions
  [--account <id>] [--category <id>]               Filter scope (at least one filter required)
  [--start <date>] [--end <date>]                  Optional date range (YYYY-MM-DD)
  [--limit <n>]                                    Max rows
fscl transactions edit apply                   Apply edit draft JSON
  [--dry-run]                                      Preview only
fscl transactions delete <id>                  Delete a transaction
  --yes                                            Confirm deletion
```

### Import

```
fscl transactions import <accountId> <file>    Import transactions from a file
  [--no-reconcile]                                 Disable reconciliation/rule processing
  [--dry-run]                                      Preview without committing
  [--show-rows]                                    Print imported rows
  [--report]                                       Print compact import report row
  [--no-clear]                                     Do not set cleared=true by default
  [--no-import-notes]                              Skip memo/notes field
  [--date-format <fmt>]                            Date format (yyyy mm dd | yy mm dd | mm dd yyyy | mm dd yy | dd mm yyyy | dd mm yy)
  [--fallback-payee-to-memo]                       OFX: use memo when payee is missing
  [--multiplier <n>]                               Multiply parsed amounts (default: 1)
  [--flip-amount]                                  Negate all amounts

  CSV-specific options:
  [--no-csv-header]                                CSV has no header row
  [--csv-delimiter <char>]                         Delimiter (default: ,)
  [--csv-date-col <name|index>]                    Date column
  [--csv-amount-col <name|index>]                  Signed amount column
  [--csv-payee-col <name|index>]                   Payee column
  [--csv-notes-col <name|index>]                   Notes column
  [--csv-category-col <name|index>]                Category column
  [--csv-inflow-col <name|index>]                  Inflow column (alternative to amount)
  [--csv-outflow-col <name|index>]                 Outflow column (alternative to amount)
  [--csv-inout-col <name|index>]                   In/out marker column
  [--csv-out-value <value>]                        Value treated as outflow in --csv-inout-col
  [--csv-skip-start <n>]                           Skip N lines at start
  [--csv-skip-end <n>]                             Skip N lines at end
```

Import status now includes `uncategorized_count` so you can immediately see remaining uncategorized transactions for that account.

### Categories

```
fscl categories list                           List category groups with their categories
fscl categories create <name>                  Create a category
  --group <groupId>                                Parent category group
  [--income]                                       Mark as income category
fscl categories draft                           Generate editable categories draft JSON
fscl categories apply                           Validate and apply categories draft JSON
  [--dry-run]                                      Preview only
fscl categories find <name>                    Find categories/groups by name
fscl categories update <id>                    Update a category
  [--name <name>]
fscl categories delete <id>                    Delete a category
  [--transfer-to <categoryId>]                     Reassign transactions to another category
  --yes                                            Confirm deletion
fscl categories create-group <name>            Create a category group
  [--income]                                       Mark as income group
fscl categories update-group <id>              Update a category group
  [--name <name>]
fscl categories delete-group <id>              Delete a category group
  [--transfer-to <categoryId>]                     Reassign transactions to another category
  --yes                                            Confirm deletion
```

### Payees

```
fscl payees list                               List all payees
fscl payees find <names...>                    Find payees by one or more name fragments
fscl payees stats                              Show per-payee transaction statistics
  [--since <yyyy-mm-dd>]                           Include transactions on/after date
  [--min-count <n>]                                Minimum number of transactions
  [--extended]                                     Include avg_amount and last_amount
fscl payees create <name>                      Create a payee
fscl payees update <id> --name <name>          Update a payee
fscl payees delete <id>                        Delete a payee
  --yes                                            Confirm deletion
fscl payees merge <targetId> <mergeIds...>     Merge payees into target
```

### Month (Budget Amounts)

```
fscl month list                                List months with budget data
fscl month status                              Show computed budget status fields
  [--month <yyyy-mm>]                              Target month (default: current)
  [--compare <n>]                                  Compare spent against previous N months
  [--only <over|under|on>]                         Filter by status
fscl month show <month>                        Show budget for a month (YYYY-MM)
fscl month draft <month>                       Generate a budget draft JSON for the month
fscl month apply <month>                       Apply budget draft JSON for the month
  [--dry-run]                                      Preview only
fscl month set <month> <categoryId> <amount>   Set budgeted amount
fscl month set-carryover <month> <categoryId> <true|false>
                                                 Toggle carryover for a category
fscl month cleanup <month>                     Run end-of-month cleanup

fscl month templates check                     Validate configured templates
fscl month templates draft                     Generate editable template draft JSON
fscl month templates apply                     Validate and apply template draft JSON
  [--dry-run]                                      Preview only
fscl month templates run <month>               Run templates for a month
  [--category <id>]                                Run only one category template
```

### Rules

```
fscl rules list                                List all rules
fscl rules validate <ruleJson>                 Validate rule JSON without saving
fscl rules preview <ruleJson>                  Preview transactions that match a rule
fscl rules run                                 Run rules retroactively on uncategorized transactions
  [--rule <id>]                                    Run only one rule
  [--dry-run]                                      Preview only
  [--and-commit]                                   Preview then commit
fscl rules create <ruleJson>                   Create a rule from JSON
  [--run]                                          Run created rule retroactively
fscl rules update <ruleJsonWithId>             Update full rule object from JSON (must include id)
fscl rules delete <id>                         Delete a rule
  --yes                                            Confirm deletion
fscl rules draft                               Generate editable rules draft JSON
fscl rules apply                               Validate and apply rules draft JSON
  [--dry-run]                                      Preview only
```

`rules run --dry-run` includes `payee_before`/`payee_after`, `category_before`/`category_after`, and `matched_rule` columns.

### Schedules

```
fscl schedules list                            List all schedules
fscl schedules find <names...>                 Find schedules by name
fscl schedules upcoming                        Show upcoming scheduled transactions
  [--days <n>]                                     Look-ahead window (default: 7)
fscl schedules missed                          Show missed scheduled transactions
  [--days <n>]                                     Look-back window (default: 7)
fscl schedules summary                         Show all recurring costs with monthly/annual equivalents
fscl schedules history <id>                    Show transaction history for a schedule
  [--limit <n>]                                    Max rows
fscl schedules review <id> <json>              Record a review decision for a schedule
fscl schedules reviews                         Show schedule review status
  [--due]                                          Show only due reviews
fscl schedules create <json>                   Create a schedule from JSON
fscl schedules update <id> <json>              Update a schedule
fscl schedules delete <id>                     Delete a schedule
  --yes                                            Confirm deletion
```

### Tags

```
fscl tags list                                 List all tags
fscl tags find <names...>                      Find tags by name
fscl tags create <name>                        Create a tag
  [--color <hex>]                                  Color (e.g. #ff0000)
  [--description <text>]                           Description
fscl tags update <id>                          Update a tag
  [--name <name>] [--color <hex>] [--description <text>]
fscl tags delete <id>                          Delete a tag
  --yes                                            Confirm deletion
```

### Query

```
fscl query --module <path>                     Run an ActualQL query module
fscl query --inline <expr>                     Run an inline ActualQL expression
```

Use exactly one of `--module` or `--inline`.

The module form loads an ESM/CJS module that builds a query using Actual's `q` helper. The module should export a default function that receives `q` and returns a query:

```javascript
// food-transactions.mjs
export default (q) =>
  q('transactions')
    .filter({ 'category.name': 'Food' })
    .select(['date', 'amount', 'payee.name']);
```

```bash
fscl query --module ./food-transactions.mjs
```
