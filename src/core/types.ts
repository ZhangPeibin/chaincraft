/** Chaincraft 当前支持识别的链 ID；unknown 用于保留未知链输入，避免直接丢失上下文。 */
export type ChainId = "bsc-mainnet" | "ethereum-mainnet" | "base-mainnet" | "unknown";

/** 用户的风险偏好，后续会影响 Agent 的解释口径和默认保护策略。 */
export type RiskPosture = "conservative" | "balanced" | "aggressive";

/** 单次 Agent 会话状态，承载钱包、链、历史和待确认交易等上下文。 */
export interface SessionState {
  /** 会话唯一标识，方便未来落库、恢复会话或追踪多轮对话。 */
  id: string;
  /** 当前关注的钱包地址；没有钱包时仍允许只读分析。 */
  walletAddress?: string;
  /** 当前默认链，FourMeme MVP 默认使用 bsc-mainnet。 */
  chainId: ChainId;
  /** 用户关注的 token 地址列表，用于后续监控和批量分析。 */
  watchedTokens: string[];
  /** 上次扫描到的区块高度，用于后续增量监听链上事件。 */
  lastScannedBlock?: bigint;
  /** 当前会话的风险偏好。 */
  riskPosture: RiskPosture;
  /** 会话事件流水，记录用户输入、LLM 调用、工具调用和回复。 */
  history: SessionEvent[];
  /** 已构造但还需要用户确认或签名的交易。 */
  pendingTransactions: PendingTransaction[];
}

/** 会话中的一条审计事件，便于解释 Agent 做过什么。 */
export interface SessionEvent {
  /** 事件发生时间，使用 ISO 字符串便于序列化。 */
  at: string;
  /** 事件类型，覆盖用户、LLM、skill、tool 和最终回复。 */
  kind: "user_prompt" | "llm_called" | "skill_selected" | "tool_called" | "agent_reply";
  /** 给人看的简短摘要，不作为程序分支依据。 */
  summary: string;
}

/** 待用户确认的交易草稿；MVP 不自动签名或广播。 */
export interface PendingTransaction {
  /** 交易草稿 ID。 */
  id: string;
  /** 交易所在链。 */
  chainId: ChainId;
  /** 给用户确认时展示的交易摘要。 */
  summary: string;
  /** 未签名交易对象，先保持 unknown，等接钱包工具时再收窄类型。 */
  unsignedTx: unknown;
  /** 交易草稿当前状态。 */
  status: "needs_user_confirmation" | "signature_requested" | "rejected" | "signed";
}

/** 从 skills/<id>/SKILL.md 解析出的 skill 元信息和正文。 */
export interface SkillManifest {
  /** skill 目录名，也是 Agent 选择 skill 时使用的稳定 ID。 */
  id: string;
  /** SKILL.md frontmatter 中的 name。 */
  name: string;
  /** SKILL.md frontmatter 中的 description，用于 LLM 路由。 */
  description: string;
  /** skill 允许 runtime 调用的 typed tools。 */
  tools: string[];
  /** skill 声明的安全策略，用于阻止签名、广播等危险动作。 */
  safety: SkillSafetyPolicy;
  /** skill 目录绝对路径，供后续读取 references/scripts/assets。 */
  directory: string;
  /** SKILL.md 的 Markdown 正文。 */
  body: string;
}

/** skill 级安全策略；MVP 默认禁止自动签名和广播。 */
export interface SkillSafetyPolicy {
  /** 是否允许自动请求签名；MVP 默认为 false。 */
  autoSign: boolean;
  /** 是否允许自动广播交易；MVP 默认为 false。 */
  autoBroadcast: boolean;
}

/** typed tool 的统一定义：输入输出由泛型约束，执行时注入 ToolContext。 */
export interface ToolDefinition<Input, Output> {
  /** 工具名，必须稳定，LLM plan 和 Agent 编排都通过它引用。 */
  name: string;
  /** 工具能力说明，用于文档、调试和未来暴露给模型。 */
  description: string;
  /** 实际工具执行函数，所有链上事实都应该从这里产生。 */
  execute(input: Input, context: ToolContext): Promise<ToolResult<Output>>;
}

/** 工具执行上下文，先只包含 session，后续可加入 logger、RPC client、secret store。 */
export interface ToolContext {
  /** 当前 Agent 会话。 */
  session: SessionState;
}

/** 工具调用结果采用显式 ok/error union，避免用异常做普通控制流。 */
export type ToolResult<T> =
  | {
      /** 工具成功标记。 */
      ok: true;
      /** 工具成功返回值。 */
      value: T;
    }
  | {
      /** 工具失败标记。 */
      ok: false;
      /** 结构化错误，方便 Agent 决定是否重试或向用户解释。 */
      error: ToolError;
    };

/** 工具错误使用封闭 code，避免后续靠自由文本做分支。 */
export interface ToolError {
  /** 程序可识别的错误码。 */
  code: "invalid_input" | "unsupported_transaction" | "tool_failed";
  /** 给开发者或用户看的错误说明。 */
  message: string;
}

/** 归一化后的链上交易事实，当前由 fixture 提供，后续由 RPC/decoder 工具生成。 */
export interface ChainTransaction {
  /** 交易所在链。 */
  chainId: ChainId;
  /** 交易哈希。 */
  hash: string;
  /** 区块高度，可选是因为 pending 或外部输入未必包含。 */
  blockNumber?: bigint;
  /** 交易发起地址。 */
  from: string;
  /** 交易目标地址。 */
  to?: string;
  /** 原生币 value，使用字符串避免大整数精度问题。 */
  valueWei?: string;
  /** 原始 calldata。 */
  input?: string;
  /** 已解码的方法名；没有时由工具做粗略推断。 */
  method?: string;
  /** 从 receipt/logs 中归一化出的 token 转账列表。 */
  tokenTransfers: TokenTransfer[];
}

/** ERC-20 风格的 token 转账事实。 */
export interface TokenTransfer {
  /** token 合约地址。 */
  tokenAddress: string;
  /** token 符号，来自上游解析或后续 token metadata 工具。 */
  tokenSymbol: string;
  /** token 小数位。 */
  tokenDecimals: number;
  /** token 转出地址。 */
  from: string;
  /** token 转入地址。 */
  to: string;
  /** 人类可读金额，后续可改为 rawAmount + decimals 双字段。 */
  amount: string;
  /** 上游协议 decoder 给出的可选领域提示，优先级高于简单地址方向判断。 */
  directionHint?: "buy" | "sell" | "transfer";
}

/** 基础交易解码结果，给 Agent 展示交易参与方和 token 转账事实。 */
export interface DecodedTransaction {
  /** 交易哈希。 */
  hash: string;
  /** 交易发起者。 */
  actor: string;
  /** 交易目标。 */
  target?: string;
  /** 交易方法名。 */
  method: string;
  /** token 转账条数。 */
  tokenTransferCount: number;
  /** 原生币 value。 */
  nativeValueWei: string;
  /** token 转账事实。 */
  tokenTransfers: TokenTransfer[];
}

/** 从某个关注钱包视角看的一条 token movement。 */
export interface TokenMovement {
  /** token 合约地址。 */
  tokenAddress: string;
  /** token 符号。 */
  tokenSymbol: string;
  /** 人类可读金额。 */
  amount: string;
  /** 相对关注钱包的方向：流入、流出或无关。 */
  direction: "in" | "out" | "neutral";
  /** 转出地址。 */
  from: string;
  /** 转入地址。 */
  to: string;
}

/** FourMeme 交易解释工具的结构化输出。 */
export interface FourMemeTokenTxExplanation {
  /** 协议标识，方便多协议解释结果复用同一 UI。 */
  protocol: "fourmeme";
  /** 交易哈希。 */
  txHash: string;
  /** 交易所在链。 */
  chainId: ChainId;
  /** 本次解释聚焦的钱包。 */
  walletAddress?: string;
  /** 对交易主动作的分类。 */
  primaryAction: "buy" | "sell" | "transfer_in" | "transfer_out" | "contract_interaction" | "unknown";
  /** 一句话解释。 */
  summary: string;
  /** token movement 明细。 */
  movements: TokenMovement[];
  /** 可验证事实列表。 */
  observations: string[];
  /** 风险提示列表，必须和事实/推断边界分开。 */
  riskNotes: string[];
  /** Agent 建议的后续问题。 */
  nextQuestions: string[];
}

/** 直接工具编排路径的 Agent 回复。 */
export interface AgentReply {
  /** 本次使用的 skill。 */
  skill: SkillManifest;
  /** 给用户展示的回复文本。 */
  text: string;
  /** 已调用的工具名列表。 */
  toolCalls: string[];
  /** 结构化调试数据，方便测试和未来 UI 展示。 */
  data: unknown;
}

/** LLM provider 规范名；内置 openai/anthropic，后续注册新厂商时可扩展为自定义字符串。 */
export type LlmProviderName = "openai" | "anthropic" | (string & {});

/** 发给 LLM 的统一请求格式。 */
export interface LlmRequest {
  /** system prompt，定义 Agent 角色、安全边界和输出格式。 */
  system: string;
  /** user prompt，包含用户原始需求和必要上下文。 */
  user: string;
  /** 最大输出 token 数，避免 planner 过度展开。 */
  maxOutputTokens?: number;
}

/** LLM 的统一响应格式，屏蔽不同厂商的返回结构差异。 */
export interface LlmResponse {
  /** 实际 provider。 */
  provider: LlmProviderName;
  /** 实际模型名。 */
  model: string;
  /** 抽取后的纯文本输出。 */
  text: string;
  /** 原始响应体，保留给调试和未来 tracing。 */
  raw: unknown;
}

/** LLM 客户端接口，Agent 只依赖这个抽象，不直接依赖具体厂商 SDK。 */
export interface LlmClient {
  /** 生成一次模型回复。 */
  generate(request: LlmRequest): Promise<LlmResponse>;
}

/** planner 目前能识别的意图集合。 */
export type AgentIntent = "skill" | "fourmeme_tx_explain" | "general_chat" | "unsupported";

/** LLM planner 输出的安全计划，必须先解析成结构化对象再执行工具。 */
export interface AgentPlan {
  /** 用户请求意图。 */
  intent: AgentIntent;
  /** 建议使用的 skill ID。 */
  skillId?: string;
  /** 给用户看的简短计划说明。 */
  userFacingPlan: string;
  /** 执行计划仍缺少的输入。 */
  missingInputs: string[];
}

/** 自然语言 ask 路径的 Agent 回复，可能只有 LLM plan，也可能包含工具结果。 */
export interface AgentAskReply {
  /** 给用户展示的回复文本。 */
  text: string;
  /** 本次选择的 skill；无法选择时为空。 */
  skill?: SkillManifest;
  /** LLM 和工具调用列表。 */
  toolCalls: string[];
  /** 结构化调试数据，包含 plan、LLM 原始响应和工具数据。 */
  data: unknown;
}

/** skill runtime 生成的结构化执行计划。 */
export interface SkillExecutionPlan {
  /** 给用户看的简短计划摘要。 */
  summary: string;
  /** runtime 准备执行的工具调用序列。 */
  toolCalls: SkillPlannedToolCall[];
  /** 执行前仍缺少的输入。 */
  missingInputs: string[];
  /** 最终回答需要遵守的输出要点。 */
  responseRubric: string[];
}

/** skill runtime 计划中的单个工具调用。 */
export interface SkillPlannedToolCall {
  /** 工具名，必须在 skill.tools 和 ToolRegistry 中同时存在。 */
  tool: string;
  /** 为什么需要调用这个工具。 */
  reason: string;
}

/** skill runtime 实际执行或跳过后的工具结果。 */
export interface SkillToolCallResult {
  /** 工具名。 */
  tool: string;
  /** 计划中的调用理由。 */
  reason: string;
  /** 是否实际成功产出事实。 */
  ok: boolean;
  /** 成功时的工具返回值。 */
  value?: unknown;
  /** 失败或跳过时的说明。 */
  error?: string;
  /** true 表示因为安全、缺输入或无 adapter 而没有调用工具。 */
  skipped?: boolean;
}

/** skill runtime 的完整执行结果。 */
export interface SkillRuntimeResult {
  /** 被执行的 skill。 */
  skill: SkillManifest;
  /** skill runtime 的结构化计划。 */
  plan: SkillExecutionPlan;
  /** 给用户展示的最终文本。 */
  text: string;
  /** LLM 和工具调用流水。 */
  toolCalls: string[];
  /** 工具事实和跳过信息。 */
  toolResults: SkillToolCallResult[];
  /** 原始 LLM 响应，保留给调试和 tracing。 */
  llm: {
    plan: unknown;
    final?: unknown;
  };
}
