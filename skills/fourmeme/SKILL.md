---
name: FourMeme Token Investigation
description: Investigate FourMeme token transactions, wallet exposure changes, transfer-vs-sell ambiguity, and follow-up risk checks from normalized BNB Chain transaction data.
tools:
  - decode_transaction
  - fourmeme_explain_token_tx
safety:
  autoSign: false
  autoBroadcast: false
---

# FourMeme Token Investigation

Use this skill when the user asks about a FourMeme token transaction, token holder movement, whether an address bought, sold, accumulated, distributed, or transferred tokens, or what follow-up checks are useful before copying a trade.

## Operating Policy

- Read-only analysis is allowed.
- Do not request a wallet signature.
- Do not broadcast transactions.
- Treat the skill as a workflow guide. Actual chain reads, decoding, simulation, and transaction building must happen through typed tools/plugins.
- Never call a transfer-out a sell unless router/pair evidence or a domain decoder supports that inference.
- Separate on-chain facts from interpretation. If a tool cannot prove something, say what is still unknown.

## Required Inputs

- Transaction hash or normalized transaction data.
- Focus wallet address when the user asks whether a wallet increased or reduced exposure.
- Token address when the transaction includes multiple token movements and the user cares about one token.

## Workflow

1. Decode the normalized transaction with `decode_transaction`.
2. Explain token movements from the focused wallet perspective with `fourmeme_explain_token_tx`.
3. Classify the focused wallet movement as buy, sell, transfer in, transfer out, contract interaction, or unknown.
4. Check transfer-vs-sell ambiguity:
   - If the focused wallet sends tokens to a plain recipient and no router/pair evidence is available, classify it as transfer out, not sell.
   - If a domain decoder provides a buy/sell hint, explain that the hint came from protocol-level decoding.
   - If the token moved through a router, pair, launchpad, burn address, or exchange, identify that as a follow-up verification need unless a tool already proved it.
5. Separate facts from inference:
   - Facts: sender, target, token transfer amount, from/to addresses.
   - Inference: whether the movement looks like accumulation, distribution, routing, or a wallet-to-wallet transfer.
6. Always include risk notes:
   - This is not a rug-risk verdict.
   - Check recipient identity for transfer-out cases.
   - Check liquidity and holder concentration before copying buys.
   - Check whether sells are large holder exits or routine profit taking.

## Output Rubric

- Start with a direct classification: buy, sell, transfer in, transfer out, contract interaction, or unknown.
- Include a short "Facts" section with the sender, target, token movement, and focused wallet direction.
- Include an "Interpretation" section that explains what can and cannot be inferred.
- Include a "Risk notes" section that does not overstate certainty.
- Include "Next checks" with the most useful typed tools or data sources to add next.
- If required inputs are missing, ask for those inputs instead of guessing.

## Useful Follow Ups

- Inspect recent sender history.
- Compare holder concentration before and after the transaction.
- Check liquidity and price impact around the transaction block.
- Watch the token for a user-defined block range.
