# Chaincraft

Chaincraft is an agent workbench for on-chain decisions.

The first MVP is intentionally read-only. It can load protocol skills, keep a session, use an LLM to route a natural-language request, call typed tools, and explain a FourMeme-style token transaction from structured transaction data. It does not auto-sign or auto-broadcast transactions.

## Why FourMeme First

FourMeme transaction explanation is a better first slice than Uniswap execution because it proves the core Agent + Session + Skill + Tool shape without forcing wallet signing, swaps, routing, approvals, or MEV-sensitive execution into day one.

Uniswap is the right second skill because it naturally adds quote, simulation, transaction building, and user confirmation once the typed tool boundary is in place.

## Architecture

```text
user
  -> command/router
  -> agent
  -> session
  -> skill
  -> typed tools/plugins
  -> chain/wallet/dapp
```

Core boundaries:

- Agent: uses an LLM to understand intent, selects a skill, orchestrates typed tool calls, explains results.
- Session: stores wallet, chain, watched tokens, risk posture, cursor state, and pending transaction summaries.
- Skill: protocol playbook and runtime contract. A skill is a directory with `SKILL.md` plus optional `scripts/`, `references/`, and `assets/`. `SKILL.md` declares allowed tools and safety policy in frontmatter, then describes workflow and output rules in Markdown.
- Skill runtime: reads the full selected `SKILL.md`, asks the LLM for a skill-specific execution plan, validates that planned tools are allowed and registered, runs typed tools, then asks the LLM to write the final answer from tool facts.
- Tool/plugin: execution boundary for chain reads, decoding, quote, simulation, transaction building, signing requests, and broadcast.
- LLM provider: selected through the LLM factory. Built-in aliases include `gpt`/`openai`/`chatgpt` and `claude`/`anthropic`. The model plans; tools produce chain facts.

## Try It

```sh
node src/cli.ts skills
node src/cli.ts explain --tx fixtures/fourmeme-transfer.json --wallet 0xWallet000000000000000000000000000000000001
```

Or:

```sh
pnpm demo
pnpm test
```

For the natural-language agent path:

```sh
cp .env.example .env
# Edit .env and set CHAINCRAFT_LLM_PROVIDER=gpt plus OPENAI_API_KEY.
node src/cli.ts ask "Explain this FourMeme transaction" --tx fixtures/fourmeme-transfer.json --wallet 0xWallet000000000000000000000000000000000001
```

Anthropic is also supported:

```sh
# Edit .env and set CHAINCRAFT_LLM_PROVIDER=claude plus ANTHROPIC_API_KEY, or override provider in CLI.
node src/cli.ts ask "What can you do for FourMeme monitoring?" --provider claude
```

The CLI automatically loads `.env` from the project root. Shell environment variables still win over `.env`, so you can temporarily override a provider, model, or key:

```sh
CHAINCRAFT_LLM_PROVIDER=gpt CHAINCRAFT_LLM_MODEL=gpt-5.4 node src/cli.ts ask "..."
```

If your region cannot reach OpenAI or Anthropic directly, set a Clash Verge HTTP or mixed port in `.env`:

```env
CHAINCRAFT_PROXY_URL=http://127.0.0.1:7890
```

If `7890` is not your Clash Verge port, check the Clash Verge settings page and use its HTTP or mixed port. The CLI also honors `HTTPS_PROXY`, `HTTP_PROXY`, and `ALL_PROXY`, but `CHAINCRAFT_PROXY_URL` has the highest priority.

The project uses Node 22 TypeScript type stripping and keeps runtime dependencies out of the first MVP.

## Skill Shape

```text
skills/fourmeme/
├── SKILL.md
├── references/
│   └── fourmeme-token-tx.md
└── scripts/
    └── explain_tx.ts
```

`SKILL.md` uses YAML frontmatter with at least `name` and `description`, followed by Markdown instructions for the agent.

Current runtime frontmatter supports:

```yaml
---
name: FourMeme Token Investigation
description: Investigate FourMeme token transactions.
tools:
  - decode_transaction
  - fourmeme_explain_token_tx
safety:
  autoSign: false
  autoBroadcast: false
---
```

The LLM can plan tool calls, but the runtime only executes tools that are both listed in `tools` and registered in `ToolRegistry`.

## Current Safety Policy

- Query, explain, quote, simulate, and build unsigned transactions are allowed.
- Signing must be an explicit wallet request.
- Broadcasting is disabled for MVP unless a later tool adds a separate confirmation gate.
- Skills never execute chain actions by themselves. They only instruct the agent how to use typed tools.

## Code Comment Policy

- New code should include Chinese comments by default.
- Public interfaces, modules, safety boundaries, and non-obvious branches should be commented.
- Comments should explain intent and constraints, not repeat the code line by line.
