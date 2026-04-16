import type { ChainId, ChainTransaction, TokenTransfer, ToolDefinition } from "../core/types.ts";

/** ERC-20 Transfer(address,address,uint256) 事件 topic。 */
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** BNB Chain 上的 WBNB 合约地址。 */
const BSC_WBNB_ADDRESS = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";

/** JSON-RPC 错误结构。 */
interface JsonRpcError {
  /** JSON-RPC 错误码。 */
  code: number;
  /** JSON-RPC 错误信息。 */
  message: string;
}

/** JSON-RPC 响应结构。 */
interface JsonRpcResponse<T> {
  /** JSON-RPC 版本。 */
  jsonrpc?: string;
  /** 请求 ID。 */
  id?: number;
  /** 成功结果。 */
  result?: T;
  /** 失败结果。 */
  error?: JsonRpcError;
}

/** eth_getTransactionByHash 返回的最小交易字段集合。 */
export interface EvmRpcTransaction {
  /** 交易哈希。 */
  hash: string;
  /** 区块高度 hex。 */
  blockNumber?: string | null;
  /** 发送方。 */
  from: string;
  /** 接收方或合约地址。 */
  to?: string | null;
  /** 原生币 value hex。 */
  value?: string;
  /** calldata。 */
  input?: string;
}

/** EVM log 的最小字段集合。 */
export interface EvmRpcLog {
  /** 产生日志的合约地址。 */
  address: string;
  /** indexed topics。 */
  topics: string[];
  /** 非 indexed data。 */
  data: string;
  /** 日志是否被 reorg 移除。 */
  removed?: boolean;
}

/** eth_getTransactionReceipt 返回的最小 receipt 字段集合。 */
export interface EvmRpcReceipt {
  /** 交易哈希。 */
  transactionHash: string;
  /** 区块高度 hex。 */
  blockNumber?: string;
  /** 日志列表。 */
  logs: EvmRpcLog[];
}

/** token 元数据覆盖项；没有元数据时会用默认 TOKEN/18。 */
export interface TokenMetadata {
  /** token 符号。 */
  symbol?: string;
  /** token decimals。 */
  decimals?: number;
}

/** 读取 RPC 交易的输入。 */
export interface RpcTransactionInput {
  /** 链 ID。 */
  chainId: ChainId;
  /** 交易哈希。 */
  txHash: string;
  /** 可选 RPC URL；不传时根据 chainId 从环境变量或默认值解析。 */
  rpcUrl?: string;
}

/** 解码 ERC-20 Transfer logs 的输入。 */
export interface DecodeErc20TransfersInput {
  /** 交易 receipt。 */
  receipt: EvmRpcReceipt;
  /** 可选 token 元数据，以小写 token 地址为 key。 */
  tokenMetadata?: Record<string, TokenMetadata>;
}

/** 归一化 EVM 交易的输入。 */
export interface NormalizeEvmTransactionInput {
  /** 链 ID。 */
  chainId: ChainId;
  /** RPC 交易对象。 */
  transaction: EvmRpcTransaction;
  /** RPC receipt。 */
  receipt: EvmRpcReceipt;
  /** 可选 token 元数据。 */
  tokenMetadata?: Record<string, TokenMetadata>;
}

/** 通过 JSON-RPC 拉取交易对象。 */
export const rpcGetTransactionTool: ToolDefinition<RpcTransactionInput, EvmRpcTransaction> = {
  name: "rpc_get_transaction",
  description: "Fetch an EVM transaction by hash through JSON-RPC.",
  async execute(input) {
    const rpcUrl = resolveRpcUrl(input.chainId, input.rpcUrl);
    if (!rpcUrl) {
      return {
        ok: false,
        error: {
          code: "invalid_input",
          message: `Missing RPC URL for chain ${input.chainId}. Set BSC_RPC_URL, ETHEREUM_RPC_URL, BASE_RPC_URL, or pass --rpc-url.`,
        },
      };
    }

    const result = await callJsonRpc<EvmRpcTransaction | null>(rpcUrl, "eth_getTransactionByHash", [input.txHash]);
    if (!result.ok) {
      return result;
    }

    if (!result.value) {
      return {
        ok: false,
        error: {
          code: "tool_failed",
          message: `Transaction not found: ${input.txHash}`,
        },
      };
    }

    return {
      ok: true,
      value: result.value,
    };
  },
};

/** 通过 JSON-RPC 拉取交易 receipt。 */
export const rpcGetTransactionReceiptTool: ToolDefinition<RpcTransactionInput, EvmRpcReceipt> = {
  name: "rpc_get_transaction_receipt",
  description: "Fetch an EVM transaction receipt by hash through JSON-RPC.",
  async execute(input) {
    const rpcUrl = resolveRpcUrl(input.chainId, input.rpcUrl);
    if (!rpcUrl) {
      return {
        ok: false,
        error: {
          code: "invalid_input",
          message: `Missing RPC URL for chain ${input.chainId}. Set BSC_RPC_URL, ETHEREUM_RPC_URL, BASE_RPC_URL, or pass --rpc-url.`,
        },
      };
    }

    const result = await callJsonRpc<EvmRpcReceipt | null>(rpcUrl, "eth_getTransactionReceipt", [input.txHash]);
    if (!result.ok) {
      return result;
    }

    if (!result.value) {
      return {
        ok: false,
        error: {
          code: "tool_failed",
          message: `Transaction receipt not found: ${input.txHash}`,
        },
      };
    }

    return {
      ok: true,
      value: result.value,
    };
  },
};

/** 解码 receipt 中的 ERC-20 Transfer logs。 */
export const decodeErc20TransfersTool: ToolDefinition<DecodeErc20TransfersInput, TokenTransfer[]> = {
  name: "decode_erc20_transfers",
  description: "Decode ERC-20 Transfer logs from an EVM transaction receipt.",
  async execute(input) {
    return {
      ok: true,
      value: decodeErc20Transfers(input),
    };
  },
};

/** 把 RPC transaction + receipt 归一化成 Chaincraft 的 ChainTransaction。 */
export const normalizeEvmTransactionTool: ToolDefinition<NormalizeEvmTransactionInput, ChainTransaction> = {
  name: "normalize_evm_transaction",
  description: "Normalize an EVM transaction and receipt into Chaincraft's chain transaction shape.",
  async execute(input) {
    return {
      ok: true,
      value: normalizeEvmTransaction(input),
    };
  },
};

/** 纯函数：从 receipt logs 解码 ERC-20 Transfer。 */
export function decodeErc20Transfers(input: DecodeErc20TransfersInput): TokenTransfer[] {
  const transfers: TokenTransfer[] = [];

  for (const log of input.receipt.logs) {
    if (log.removed || normalizeHex(log.topics[0]) !== ERC20_TRANSFER_TOPIC || log.topics.length < 3) {
      continue;
    }

    const tokenAddress = normalizeAddress(log.address);
    const metadata = input.tokenMetadata?.[tokenAddress];
    const decimals = metadata?.decimals ?? 18;
    const rawAmount = hexToBigInt(log.data);

    transfers.push({
      tokenAddress,
      tokenSymbol: metadata?.symbol ?? shortTokenSymbol(tokenAddress),
      tokenDecimals: decimals,
      from: topicToAddress(log.topics[1]),
      to: topicToAddress(log.topics[2]),
      amount: formatUnits(rawAmount, decimals),
    });
  }

  return transfers;
}

/** 纯函数：归一化 EVM 交易，供 CLI 和测试复用。 */
export function normalizeEvmTransaction(input: NormalizeEvmTransactionInput): ChainTransaction {
  const blockNumberHex = input.transaction.blockNumber ?? input.receipt.blockNumber;
  const tokenMetadata = {
    ...getDefaultTokenMetadata(input.chainId),
    ...input.tokenMetadata,
  };

  return {
    chainId: input.chainId,
    hash: input.transaction.hash,
    blockNumber: blockNumberHex ? hexToBigInt(blockNumberHex) : undefined,
    from: normalizeAddress(input.transaction.from),
    to: input.transaction.to ? normalizeAddress(input.transaction.to) : undefined,
    valueWei: hexToBigInt(input.transaction.value ?? "0x0").toString(),
    input: input.transaction.input,
    tokenTransfers: decodeErc20Transfers({
      receipt: input.receipt,
      tokenMetadata,
    }),
  };
}

/** 返回链级默认 token 元数据；只放极高确定性的基础资产，避免误标长尾 token。 */
export function getDefaultTokenMetadata(chainId: ChainId): Record<string, TokenMetadata> {
  if (chainId === "bsc-mainnet") {
    return {
      [BSC_WBNB_ADDRESS]: {
        symbol: "WBNB",
        decimals: 18,
      },
    };
  }

  return {};
}

/** 根据链 ID 解析 RPC URL；BSC 主网提供一个无 key 默认值，其他链要求显式配置。 */
export function resolveRpcUrl(chainId: ChainId, explicitRpcUrl?: string): string | undefined {
  if (explicitRpcUrl?.trim()) {
    return explicitRpcUrl.trim();
  }

  if (chainId === "bsc-mainnet") {
    return process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org/";
  }

  if (chainId === "ethereum-mainnet") {
    return process.env.ETHEREUM_RPC_URL;
  }

  if (chainId === "base-mainnet") {
    return process.env.BASE_RPC_URL;
  }

  return undefined;
}

/** 发起 JSON-RPC 请求并返回 ToolResult。 */
async function callJsonRpc<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      error: {
        code: "tool_failed";
        message: string;
      };
    }
> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });
  const payload = (await response.json().catch(() => undefined)) as JsonRpcResponse<T> | undefined;

  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: "tool_failed",
        message: `RPC HTTP ${response.status}: ${JSON.stringify(payload)}`,
      },
    };
  }

  if (!payload) {
    return {
      ok: false,
      error: {
        code: "tool_failed",
        message: "RPC returned a non-JSON response.",
      },
    };
  }

  if (payload.error) {
    return {
      ok: false,
      error: {
        code: "tool_failed",
        message: `RPC ${payload.error.code}: ${payload.error.message}`,
      },
    };
  }

  return {
    ok: true,
    value: payload.result as T,
  };
}

/** topic 的最后 20 bytes 是 indexed address。 */
function topicToAddress(topic: string): string {
  const normalized = normalizeHex(topic);
  return `0x${normalized.slice(-40)}`.toLowerCase();
}

/** hex 字符串转 bigint，兼容空 data。 */
function hexToBigInt(value: string): bigint {
  const normalized = normalizeHex(value);
  if (normalized === "0x" || normalized === "0x0") {
    return 0n;
  }

  return BigInt(normalized);
}

/** 归一化 hex 字符串。 */
function normalizeHex(value: string | undefined): string {
  const normalized = value?.toLowerCase() ?? "0x";
  return normalized.startsWith("0x") ? normalized : `0x${normalized}`;
}

/** 归一化地址到小写。 */
function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

/** 没有 token metadata 时，用地址短符号占位，避免误导为真实 symbol。 */
function shortTokenSymbol(tokenAddress: string): string {
  return `TOKEN(${tokenAddress.slice(2, 6)}...${tokenAddress.slice(-4)})`;
}

/** 按 decimals 格式化 token 数量，并去掉多余 0。 */
function formatUnits(value: bigint, decimals: number): string {
  if (decimals <= 0) {
    return value.toString();
  }

  const base = 10n ** BigInt(decimals);
  const integer = value / base;
  const fraction = value % base;
  if (fraction === 0n) {
    return integer.toString();
  }

  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${integer.toString()}.${fractionText}`;
}
