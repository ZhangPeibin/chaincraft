import assert from "node:assert/strict";
import test from "node:test";
import { analyzeFourMemeTokenTx } from "../src/tools/fourmeme.ts";
import type { ChainTransaction } from "../src/core/types.ts";

// 关注钱包是 transfer 的 from 时，应被解释为 token 流出。
test("classifies focused wallet transfer out", () => {
  const transaction: ChainTransaction = {
    chainId: "bsc-mainnet",
    hash: "0xtest",
    from: "0xWallet",
    to: "0xRouter",
    tokenTransfers: [
      {
        tokenAddress: "0xToken",
        tokenSymbol: "MEME",
        tokenDecimals: 18,
        from: "0xWallet",
        to: "0xOther",
        amount: "42",
      },
    ],
  };

  const explanation = analyzeFourMemeTokenTx({
    transaction,
    walletAddress: "0xWallet",
  });

  assert.equal(explanation.primaryAction, "transfer_out");
  assert.equal(explanation.movements[0]?.direction, "out");
});

// 用户只问“这个 tx 是啥意思”时，没有显式 wallet，也应默认从交易发起者视角解释。
test("defaults focus wallet to transaction sender", () => {
  const transaction: ChainTransaction = {
    chainId: "bsc-mainnet",
    hash: "0xtest",
    from: "0xWallet",
    to: "0xRouter",
    tokenTransfers: [
      {
        tokenAddress: "0xToken",
        tokenSymbol: "MEME",
        tokenDecimals: 18,
        from: "0xWallet",
        to: "0xOther",
        amount: "42",
      },
    ],
  };

  const explanation = analyzeFourMemeTokenTx({
    transaction,
  });

  assert.equal(explanation.walletAddress, "0xWallet");
  assert.equal(explanation.primaryAction, "transfer_out");
  assert.equal(explanation.movements[0]?.direction, "out");
});

// 协议 decoder 给出的买入/卖出 hint 优先于通用转账方向判断。
test("honors domain direction hints when present", () => {
  const transaction: ChainTransaction = {
    chainId: "bsc-mainnet",
    hash: "0xtest",
    from: "0xWallet",
    to: "0xRouter",
    tokenTransfers: [
      {
        tokenAddress: "0xToken",
        tokenSymbol: "MEME",
        tokenDecimals: 18,
        from: "0xRouter",
        to: "0xWallet",
        amount: "42",
        directionHint: "buy",
      },
    ],
  };

  const explanation = analyzeFourMemeTokenTx({
    transaction,
    walletAddress: "0xWallet",
  });

  assert.equal(explanation.primaryAction, "buy");
  assert.equal(explanation.movements[0]?.direction, "in");
});

// 摘要应优先展示和关注钱包有关的 movement，而不是第一条 neutral movement。
test("summary prefers focused wallet movement over neutral movement", () => {
  const transaction: ChainTransaction = {
    chainId: "bsc-mainnet",
    hash: "0xtest",
    from: "0xWallet",
    to: "0xRouter",
    tokenTransfers: [
      {
        tokenAddress: "0xWbnb",
        tokenSymbol: "WBNB",
        tokenDecimals: 18,
        from: "0xRouter",
        to: "0xPair",
        amount: "0.0495",
      },
      {
        tokenAddress: "0xToken",
        tokenSymbol: "MEME",
        tokenDecimals: 18,
        from: "0xPair",
        to: "0xWallet",
        amount: "454127.1",
      },
    ],
  };

  const explanation = analyzeFourMemeTokenTx({
    transaction,
    walletAddress: "0xWallet",
  });

  assert.equal(explanation.primaryAction, "transfer_in");
  assert.match(explanation.summary, /454127\.1 MEME in/);
});
