<img width="960" height="540" alt="fiscal-init" src="https://github.com/user-attachments/assets/92aea807-6851-482a-ac5d-f2090e278586" />

# Fiscal (fscl): Personal Finance Built For Agents

A headless CLI for [Actual Budget](https://actualbudget.org/) — no server required. Import transactions, manage your budget, and automate your finances from the terminal or through an AI agent.

### Get Started

**1. Install the CLI**
```bash
npm install -g fscl
```

**2. Set up your first budget**
```bash
fscl init
```

If you run setup via `npx fscl init`, fscl prompts to install itself globally (`npm install -g fscl`) so `fscl` is available on your PATH afterward.

At the end of interactive setup, fscl offers to install the agent skill by running:
```bash
npx skills add fiscal-sh/fscl
```

If you skip it, run that command anytime.

**3. Talk to your agent in plain language**
- "Help me set up my budget."
- "Import ~/Downloads/january-checking.ofx into my checking account and categorize everything."
- "How am I doing this month?"
- "Set up my budget for next month and increase groceries to 600."

## Documentation

- Full docs: [fiscal.sh/docs](https://fiscal.sh/docs)
- Agent skills: [fiscal.sh/docs/skills](https://fiscal.sh/docs/skills)
