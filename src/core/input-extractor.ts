import type { AgentInputContext, ChainTransaction, SessionState } from "./types.ts";

/** 构造输入上下文需要的原始输入，来源可以是 CLI、session 或上游工具。 */
export interface ExtractInputContextInput {
  /** 当前会话上下文。 */
  session: SessionState;
  /** 用户原始自然语言需求。 */
  prompt: string;
  /** 调用方已经准备好的归一化交易对象。 */
  transaction?: ChainTransaction;
  /** 归一化交易文件路径。 */
  txPath?: string;
  /** 显式交易哈希；优先级高于 prompt 自动识别。 */
  txHash?: string;
  /** 可选 token 过滤条件。 */
  tokenAddress?: string;
}

/** 从自然语言和显式参数中提取通用链上上下文，ask 入口不再写协议专用判断。 */
export function extractInputContext(input: ExtractInputContextInput): AgentInputContext {
  const transactionHash = input.txHash ?? extractTransactionHashFromPrompt(input.prompt);
  const addresses = extractEvmAddresses(input.prompt);
  const protocolHints = inferProtocolHints(input.prompt, transactionHash);
  const actionHints = inferActionHints(input.prompt, transactionHash, input.txPath, input.transaction);
  const inputTypes = inferInputTypes({
    transactionHash,
    txPath: input.txPath,
    transaction: input.transaction,
    tokenAddress: input.tokenAddress,
    walletAddress: input.session.walletAddress,
    addresses,
  });

  return {
    prompt: input.prompt,
    chainId: input.session.chainId,
    walletAddress: input.session.walletAddress,
    transactionHash,
    transactionFilePath: input.txPath,
    hasNormalizedTransaction: input.transaction !== undefined,
    tokenAddress: input.tokenAddress,
    addresses,
    protocolHints,
    actionHints,
    inputTypes,
  };
}

/** 从自然语言里识别 EVM 交易哈希；这属于 Agent 输入理解，不属于 CLI 参数校验。 */
export function extractTransactionHashFromPrompt(prompt: string): string | undefined {
  return prompt.match(/0x[a-fA-F0-9]{64}/)?.[0];
}

/** 提取 prompt 里的 EVM 地址，并排除已经被交易哈希覆盖的片段。 */
function extractEvmAddresses(prompt: string): string[] {
  const txHashRanges = [...prompt.matchAll(/0x[a-fA-F0-9]{64}/g)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const addresses: string[] = [];

  for (const match of prompt.matchAll(/0x[a-fA-F0-9]{40}/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const insideHash = txHashRanges.some((range) => start >= range.start && end <= range.end);
    if (!insideHash) {
      addresses.push(match[0]);
    }
  }

  return [...new Set(addresses)];
}

/** 根据 prompt 里的协议词和输入形态推断协议提示，供本地 skill 候选匹配。 */
function inferProtocolHints(prompt: string, transactionHash: string | undefined): string[] {
  const normalized = prompt.toLowerCase();
  const hints: string[] = [];

  // 有交易哈希时，至少说明这是 EVM 交易分析入口；具体协议再由后续 skill 或工具收窄。
  if (transactionHash) {
    hints.push("evm");
  }

  const protocolPatterns: Array<{ protocol: string; pattern: RegExp }> = [
    { protocol: "fourmeme", pattern: /\bfourmeme\b|\bfour\.meme\b|四 meme|四meme/i },
    { protocol: "uniswap", pattern: /\buniswap\b/i },
    { protocol: "aave", pattern: /\baave\b/i },
    { protocol: "curve", pattern: /\bcurve\b/i },
    { protocol: "pendle", pattern: /\bpendle\b/i },
    { protocol: "lido", pattern: /\blido\b/i },
    { protocol: "gmx", pattern: /\bgmx\b/i },
    { protocol: "compound", pattern: /\bcompound\b/i },
  ];

  for (const item of protocolPatterns) {
    if (item.pattern.test(normalized)) {
      hints.push(item.protocol);
    }
  }

  return [...new Set(hints)];
}

/** 将自然语言意图压成稳定 action hint，后续新增 DApp 不需要改 ask 主流程。 */
function inferActionHints(
  prompt: string,
  transactionHash: string | undefined,
  txPath: string | undefined,
  transaction: ChainTransaction | undefined,
): string[] {
  const normalized = prompt.toLowerCase();
  const hints: string[] = [];

  if (
    transactionHash ||
    txPath ||
    transaction ||
    /\btx\b|\btransaction\b|交易|哈希|hash|什么意思|看下|分析|解释/i.test(normalized)
  ) {
    hints.push("explain_transaction");
  }

  if (/\bswap\b|兑换|换成|买入|卖出|\bbuy\b|\bsell\b/i.test(normalized)) {
    hints.push("swap_or_trade");
  }

  if (/\bsupply\b|\bwithdraw\b|\bborrow\b|\brepay\b|存入|借款|还款|取出/i.test(normalized)) {
    hints.push("lending_position");
  }

  if (/\bholder\b|持有人|持仓|筹码|集中度/i.test(normalized)) {
    hints.push("inspect_holders");
  }

  return [...new Set(hints)];
}

/** 根据显式输入和 prompt 识别结果生成输入类型标签。 */
function inferInputTypes(input: {
  transactionHash?: string;
  txPath?: string;
  transaction?: ChainTransaction;
  tokenAddress?: string;
  walletAddress?: string;
  addresses: string[];
}): string[] {
  const types: string[] = [];

  if (input.transactionHash) {
    types.push("transactionHash");
  }

  if (input.txPath) {
    types.push("normalizedTransactionFile");
  }

  if (input.transaction) {
    types.push("normalizedTransaction");
  }

  if (input.walletAddress) {
    types.push("walletAddress");
  }

  if (input.tokenAddress) {
    types.push("tokenAddress");
  }

  if (input.addresses.length > 0) {
    types.push("evmAddress");
  }

  return [...new Set(types)];
}
