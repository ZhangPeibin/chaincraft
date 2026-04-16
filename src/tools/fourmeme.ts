import type {
  ChainTransaction,
  DecodedTransaction,
  FourMemeTokenTxExplanation,
  TokenMovement,
  ToolDefinition,
} from "../core/types.ts";

/** FourMeme 交易解释工具的输入。 */
export interface FourMemeExplainInput {
  /** 已归一化的链上交易事实。 */
  transaction: ChainTransaction;
  /** 关注钱包；提供后才能判断 token 是流入还是流出。 */
  walletAddress?: string;
  /** 可选 token 过滤条件，适合一笔交易包含多个 token movement 的情况。 */
  tokenAddress?: string;
}

/** 基础交易解码工具：把归一化交易转换成 Agent 可展示的核心事实。 */
export const decodeTransactionTool: ToolDefinition<ChainTransaction, DecodedTransaction> = {
  name: "decode_transaction",
  description: "Decode a normalized chain transaction into method, actor, target, native value, and token transfer facts.",
  async execute(transaction) {
    // 工具边界先做最小输入校验，避免下游分析拿到空 hash/from。
    if (!transaction || typeof transaction.hash !== "string" || typeof transaction.from !== "string") {
      return {
        ok: false,
        error: {
          code: "invalid_input",
          message: "Expected a normalized transaction with hash and from fields.",
        },
      };
    }

    return {
      ok: true,
      value: {
        hash: transaction.hash,
        actor: transaction.from,
        target: transaction.to,
        // 如果上游没有提供 ABI 解码结果，先给出粗粒度方法分类。
        method: transaction.method ?? inferMethod(transaction.input),
        tokenTransferCount: transaction.tokenTransfers.length,
        nativeValueWei: transaction.valueWei ?? "0",
        tokenTransfers: transaction.tokenTransfers,
      },
    };
  },
};

/** FourMeme 领域解释工具：从 token transfer 事实推断关注钱包的动作。 */
export const fourMemeExplainTokenTxTool: ToolDefinition<FourMemeExplainInput, FourMemeTokenTxExplanation> = {
  name: "fourmeme_explain_token_tx",
  description: "Explain a FourMeme token transaction from normalized transfers and optional wallet focus.",
  async execute(input) {
    return {
      ok: true,
      value: analyzeFourMemeTokenTx(input),
    };
  },
};

/** 核心分析函数，保持纯函数形态，方便测试和未来复用到 Web UI。 */
export function analyzeFourMemeTokenTx(input: FourMemeExplainInput): FourMemeTokenTxExplanation {
  // 用户只问“这个 tx 是啥意思”时，默认从交易发起者视角解释，避免输出一堆 neutral movement。
  const focusedWallet = input.walletAddress ?? input.transaction.from;
  const normalizedWallet = normalizeAddress(focusedWallet);
  const normalizedToken = normalizeAddress(input.tokenAddress);
  const relevantTransfers = input.transaction.tokenTransfers.filter((transfer) => {
    // 没有指定 token 时分析全部 token transfer。
    if (!normalizedToken) {
      return true;
    }

    return normalizeAddress(transfer.tokenAddress) === normalizedToken;
  });

  const movements: TokenMovement[] = relevantTransfers.map((transfer) => {
    // 方向是相对关注钱包而言；没有关注钱包时只能标记为 neutral。
    const direction = normalizedWallet
      ? movementDirectionForWallet(transfer.from, transfer.to, normalizedWallet)
      : "neutral";

    return {
      tokenAddress: transfer.tokenAddress,
      tokenSymbol: transfer.tokenSymbol,
      amount: transfer.amount,
      direction,
      from: transfer.from,
      to: transfer.to,
    };
  });

  const primaryAction = inferPrimaryAction(movements, relevantTransfers);
  const summary = buildSummary(input.transaction.hash, primaryAction, movements);
  const observations = buildObservations(input.transaction, movements);
  const riskNotes = buildRiskNotes(input.transaction, primaryAction, movements);

  // 输出同时包含事实、推断、风险提示和下一步问题，便于 UI 分区展示。
  return {
    protocol: "fourmeme",
    txHash: input.transaction.hash,
    chainId: input.transaction.chainId,
    walletAddress: focusedWallet,
    primaryAction,
    summary,
    movements,
    observations,
    riskNotes,
    nextQuestions: [
      "Should I inspect the sender's recent token history?",
      "Should I compare this movement with holder concentration and pool liquidity?",
      "Should I watch the token for the next block range?",
    ],
  };
}

/** 没有 ABI 解码结果时，使用 calldata 是否为空做最小方法推断。 */
function inferMethod(input?: string): string {
  if (!input || input === "0x") {
    return "native_transfer";
  }

  return "contract_call";
}

/** 判断一条 token transfer 相对关注钱包是流入、流出还是无关。 */
function movementDirectionForWallet(from: string, to: string, wallet: string): "in" | "out" | "neutral" {
  if (normalizeAddress(to) === wallet) {
    return "in";
  }

  if (normalizeAddress(from) === wallet) {
    return "out";
  }

  return "neutral";
}

/** 推断交易主动作：协议 decoder 的 directionHint 优先，其次看钱包方向。 */
function inferPrimaryAction(
  movements: TokenMovement[],
  transfers: ChainTransaction["tokenTransfers"],
): FourMemeTokenTxExplanation["primaryAction"] {
  const hintedBuy = transfers.some((transfer) => transfer.directionHint === "buy");
  const hintedSell = transfers.some((transfer) => transfer.directionHint === "sell");

  // 领域 adapter 如果已经识别买卖，应优先于通用转账方向。
  if (hintedBuy) {
    return "buy";
  }

  if (hintedSell) {
    return "sell";
  }

  if (movements.some((movement) => movement.direction === "in")) {
    return "transfer_in";
  }

  if (movements.some((movement) => movement.direction === "out")) {
    return "transfer_out";
  }

  // 有 token movement 但和关注钱包无关，说明仍是合约交互事实。
  if (transfers.length > 0) {
    return "contract_interaction";
  }

  return "unknown";
}

/** 生成一句话摘要，CLI 和未来 UI 卡片都可以复用。 */
function buildSummary(
  txHash: string,
  primaryAction: FourMemeTokenTxExplanation["primaryAction"],
  movements: TokenMovement[],
): string {
  // 优先展示和关注钱包有关的 movement，避免 neutral movement 抢走摘要主语。
  const primaryMovement = movements.find((movement) => movement.direction !== "neutral") ?? movements[0];
  const movementText = primaryMovement
    ? `${primaryMovement.amount} ${primaryMovement.tokenSymbol} ${primaryMovement.direction}`
    : "no token transfer detected";

  return `${txHash} looks like ${primaryAction.replaceAll("_", " ")}: ${movementText}.`;
}

/** 生成事实观察列表，只放可从交易数据验证的信息。 */
function buildObservations(transaction: ChainTransaction, movements: TokenMovement[]): string[] {
  const observations = [
    `Transaction actor: ${transaction.from}`,
    `Target contract/address: ${transaction.to ?? "none"}`,
    `Token transfer count: ${movements.length.toString()}`,
  ];

  for (const movement of movements) {
    observations.push(`${movement.tokenSymbol}: ${movement.amount} moved from ${movement.from} to ${movement.to}.`);
  }

  return observations;
}

/** 生成风险提示，明确这些不是完整投资建议或 rug-risk 结论。 */
function buildRiskNotes(
  transaction: ChainTransaction,
  primaryAction: FourMemeTokenTxExplanation["primaryAction"],
  movements: TokenMovement[],
): string[] {
  const notes = [
    "This is an explanation from normalized transaction data, not a full profitability or rug-risk verdict.",
  ];

  // FourMeme MVP 默认面向 BNB Chain，其他链需要额外确认协议上下文。
  if (transaction.chainId !== "bsc-mainnet") {
    notes.push("The FourMeme MVP expects BNB Chain data; verify the chain before acting.");
  }

  // 转出不等于卖出，必须提醒用户检查接收方身份。
  if (primaryAction === "transfer_out" || movements.some((movement) => movement.direction === "out")) {
    notes.push("The focused wallet sent tokens out; check whether the recipient is an exchange, router, burn address, or fresh wallet.");
  }

  if (primaryAction === "buy") {
    notes.push("For buys, compare price impact, pool liquidity, and holder concentration before copying the trade.");
  }

  if (primaryAction === "sell") {
    notes.push("For sells, inspect whether this is profit taking, liquidity migration, or a large holder exit.");
  }

  return notes;
}

/** 地址统一小写比较；MVP 暂不做 checksum 校验。 */
function normalizeAddress(address?: string): string | undefined {
  return address?.toLowerCase();
}
