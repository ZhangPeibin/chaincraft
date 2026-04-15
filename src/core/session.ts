import type { ChainId, RiskPosture, SessionEvent, SessionState } from "./types.ts";

/** 创建会话时允许从 CLI 或未来 Web UI 传入的初始上下文。 */
export interface CreateSessionInput {
  /** 可选的会话 ID；不传则自动生成。 */
  id?: string;
  /** 用户当前关注的钱包地址。 */
  walletAddress?: string;
  /** 会话默认链。 */
  chainId?: ChainId;
  /** 用户风险偏好。 */
  riskPosture?: RiskPosture;
  /** 初始关注 token 列表。 */
  watchedTokens?: string[];
}

/** 创建一个内存态 session；后续接数据库时可以把这个函数变成默认值归一化入口。 */
export function createSession(input: CreateSessionInput = {}): SessionState {
  return {
    id: input.id ?? `session_${Date.now().toString(36)}`,
    walletAddress: input.walletAddress,
    chainId: input.chainId ?? "bsc-mainnet",
    watchedTokens: input.watchedTokens ?? [],
    riskPosture: input.riskPosture ?? "conservative",
    history: [],
    pendingTransactions: [],
  };
}

/** 记录 session 事件，形成 Agent 行为审计流水。 */
export function recordSessionEvent(session: SessionState, event: Omit<SessionEvent, "at">): void {
  session.history.push({
    at: new Date().toISOString(),
    ...event,
  });
}
