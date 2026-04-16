---
name: EVM Transaction Explain
description: Explain generic EVM transactions from a hash, normalized transaction file, or normalized transaction data without assuming a specific DeFi protocol.
domains:
  - evm
  - transaction-analysis
protocols:
  - evm
chains:
  - bsc-mainnet
  - ethereum-mainnet
  - base-mainnet
actions:
  - explain_transaction
triggers:
  - tx
  - transaction
  - hash
  - 交易
  - 哈希
  - 分析
  - 解释
inputs:
  - transactionHash
  - normalizedTransactionFile
  - normalizedTransaction
  - walletAddress
  - evmAddress
tools:
  - read_normalized_transaction_file
  - rpc_get_transaction
  - rpc_get_transaction_receipt
  - normalize_evm_transaction
  - decode_transaction
safety:
  autoSign: false
  autoBroadcast: false
---

# EVM Transaction Explain

Use this skill when the user asks what an EVM transaction means, provides a transaction hash without naming a specific protocol, or wants a neutral explanation of sender, target, value, calldata shape, and token transfer facts.

## Operating Policy

- Read-only analysis is allowed.
- Do not request a wallet signature.
- Do not broadcast transactions.
- Treat this skill as a generic transaction explanation layer. Do not infer protocol-specific buy, sell, liquidation, bridge, or staking semantics unless a typed tool proves them.
- Separate direct facts from interpretation.

## Required Inputs

- Transaction hash, normalized transaction file, or already-normalized transaction data.
- Wallet address is optional. If present, explain token movement relative to that wallet.

## Workflow

1. If the user provides a normalized transaction file, read it with `read_normalized_transaction_file`.
2. If the user provides only a transaction hash, fetch the raw transaction with `rpc_get_transaction`.
3. If the user provides only a transaction hash, fetch the receipt with `rpc_get_transaction_receipt`.
4. If raw transaction and receipt are available, normalize them with `normalize_evm_transaction`.
5. Decode the normalized transaction with `decode_transaction`.
6. Explain only the facts the tools returned:
   - sender
   - target
   - native value
   - method category
   - token transfer count
   - token transfer direction when a wallet is known
7. If the transaction appears to involve a known protocol but this skill has no protocol decoder result, recommend the relevant protocol skill as a next step instead of guessing.

## Output Rubric

- Start with a short plain-language summary.
- Include a "Facts" section with sender, target, value, method, and token transfers.
- Include an "Interpretation" section that states what is unknown.
- Include "Next checks" when protocol-specific analysis would require another skill or tool.
