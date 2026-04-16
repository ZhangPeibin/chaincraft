import assert from "node:assert/strict";
import test from "node:test";
import { decodeErc20Transfers, getDefaultTokenMetadata, normalizeEvmTransaction } from "../src/tools/evm-rpc.ts";
import type { EvmRpcReceipt, EvmRpcTransaction } from "../src/tools/evm-rpc.ts";

const from = "0x1111111111111111111111111111111111111111";
const to = "0x2222222222222222222222222222222222222222";
const token = "0x3333333333333333333333333333333333333333";
const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// indexed address 在 topic 的最后 20 bytes；测试确保 ERC-20 Transfer 能被解出来。
test("decodes ERC-20 transfer logs", () => {
  const receipt: EvmRpcReceipt = {
    transactionHash: "0xtx",
    blockNumber: "0x10",
    logs: [
      {
        address: token,
        topics: [transferTopic, addressTopic(from), addressTopic(to)],
        data: uint256Topic(1_000_000_000_000_000_000n),
      },
    ],
  };

  const transfers = decodeErc20Transfers({
    receipt,
    tokenMetadata: {
      [token]: {
        symbol: "MEME",
        decimals: 18,
      },
    },
  });

  assert.equal(transfers.length, 1);
  assert.equal(transfers[0]?.from, from);
  assert.equal(transfers[0]?.to, to);
  assert.equal(transfers[0]?.tokenSymbol, "MEME");
  assert.equal(transfers[0]?.amount, "1");
});

// 归一化工具把 RPC transaction + receipt 转成现有 skill runtime 能理解的 ChainTransaction。
test("normalizes EVM transaction and receipt into ChainTransaction", () => {
  const transaction: EvmRpcTransaction = {
    hash: "0xtx",
    blockNumber: "0x10",
    from,
    to: "0x4444444444444444444444444444444444444444",
    value: "0xde0b6b3a7640000",
    input: "0x",
  };
  const receipt: EvmRpcReceipt = {
    transactionHash: "0xtx",
    blockNumber: "0x10",
    logs: [
      {
        address: token,
        topics: [transferTopic, addressTopic(from), addressTopic(to)],
        data: uint256Topic(2_500_000_000_000_000_000n),
      },
    ],
  };

  const normalized = normalizeEvmTransaction({
    chainId: "bsc-mainnet",
    transaction,
    receipt,
    tokenMetadata: {
      [token]: {
        symbol: "MEME",
        decimals: 18,
      },
    },
  });

  assert.equal(normalized.blockNumber, 16n);
  assert.equal(normalized.valueWei, "1000000000000000000");
  assert.equal(normalized.tokenTransfers[0]?.amount, "2.5");
});

// BSC 默认元数据应该识别 WBNB，避免真实交易输出 TOKEN(bb4c...095c)。
test("provides default BSC WBNB metadata", () => {
  const metadata = getDefaultTokenMetadata("bsc-mainnet");

  assert.equal(metadata["0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"]?.symbol, "WBNB");
});

/** 把地址编码成 ERC-20 Transfer indexed topic。 */
function addressTopic(address: string): string {
  return `0x${address.slice(2).padStart(64, "0")}`;
}

/** 把 uint256 编码成 32 bytes hex data。 */
function uint256Topic(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}
