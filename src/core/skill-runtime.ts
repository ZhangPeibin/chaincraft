import { debugLog, type DebugLogger } from "./debug.ts";
import { recordSessionEvent } from "./session.ts";
import type {
  AgentInputContext,
  ChainTransaction,
  DecodedTransaction,
  FourMemeTokenTxExplanation,
  LlmClient,
  SessionState,
  SkillExecutionPlan,
  SkillManifest,
  SkillRuntimeResult,
  SkillToolCallResult,
} from "./types.ts";
import { ToolRegistry } from "./tools.ts";
import type { EvmRpcReceipt, EvmRpcTransaction } from "../tools/evm-rpc.ts";

/** skill runtime 的输入上下文。 */
export interface RunSkillInput {
  /** 用户原始自然语言需求。 */
  prompt: string;
  /** 当前会话上下文。 */
  session: SessionState;
  /** 已选中的 skill，包含完整 SKILL.md 正文。 */
  skill: SkillManifest;
  /** typed tools 注册表，所有事实都必须从这里产生。 */
  tools: ToolRegistry;
  /** LLM client，用于 skill 内规划和最终回答生成。 */
  llm: LlmClient;
  /** 可选归一化交易数据。 */
  transaction?: ChainTransaction;
  /** 可选本地归一化交易文件路径；runtime 可以按 skill 计划调用文件读取 tool。 */
  txPath?: string;
  /** 可选交易哈希；runtime 可以按 skill 计划调用 RPC tools 获取交易事实。 */
  txHash?: string;
  /** 可选 RPC URL；会传给 RPC tools。 */
  rpcUrl?: string;
  /** 可选 token 过滤条件。 */
  tokenAddress?: string;
  /** 路由阶段给出的计划，作为 skill runtime 的上游参考。 */
  routePlan?: unknown;
  /** ask 入口提取的协议无关输入上下文。 */
  inputContext?: AgentInputContext;
  /** debug 调用链 logger，只在 CLI/env 开启时输出。 */
  debug?: DebugLogger;
}

/** 执行选中的 skill：用完整 SKILL.md 生成计划，再按 typed tool 边界执行。 */
export async function runSkill(input: RunSkillInput): Promise<SkillRuntimeResult> {
  // skill.run.start 是进入协议工作流的边界；之后所有工具都必须受这个 skill 约束。
  debugLog(input.debug, "skill.run.start", {
    skillId: input.skill.id,
    skillName: input.skill.name,
    allowedTools: input.skill.tools,
  });
  recordSessionEvent(input.session, {
    kind: "skill_selected",
    summary: `${input.skill.name}: ${input.skill.description}`,
  });

  // 第二轮 LLM 读取完整 SKILL.md，只负责规划工具链，不直接读链或得出事实结论。
  debugLog(input.debug, "llm.skill_plan.start", {
    skillId: input.skill.id,
    maxOutputTokens: 900,
  });
  const planResponse = await input.llm.generate({
    system: buildSkillPlanSystemPrompt(input.skill),
    user: buildSkillPlanUserPrompt(input),
    maxOutputTokens: 900,
  });
  recordSessionEvent(input.session, {
    kind: "llm_called",
    summary: `${planResponse.provider}:${planResponse.model}:skill_plan`,
  });
  debugLog(input.debug, "llm.skill_plan.done", {
    provider: planResponse.provider,
    model: planResponse.model,
  });

  const plan = normalizeSkillExecutionPlan(input, parseSkillExecutionPlan(planResponse.text));
  // skill.plan.done 是 runtime 归一化后的最终执行计划，不一定完全等于模型原始输出。
  debugLog(input.debug, "skill.plan.done", {
    summary: plan.summary,
    tools: plan.toolCalls.map((call) => call.tool),
    missingInputs: plan.missingInputs,
  });
  const toolResults = plan.missingInputs.length > 0 ? [] : await executeSkillPlan(input, plan);
  const missingInputResults = toolResults.filter((result) => result.skipped && result.error?.startsWith("Missing input:"));

  if (plan.missingInputs.length > 0 || missingInputResults.length > 0) {
    return {
      skill: input.skill,
      plan,
      text: renderMissingInputsResponse(input.skill, plan, missingInputResults),
      toolCalls: [`llm:${planResponse.provider}:skill_plan`, ...toolResults.map((result) => result.tool)],
      toolResults,
      llm: {
        plan: planResponse.raw,
      },
    };
  }

  // 第三轮 LLM 只拿 typed tool facts 写回答，不能再凭空补链上事实。
  debugLog(input.debug, "llm.skill_answer.start", {
    skillId: input.skill.id,
    maxOutputTokens: 1200,
  });
  const finalResponse = await input.llm.generate({
    system: buildSkillFinalSystemPrompt(input.skill),
    user: buildSkillFinalUserPrompt(input, plan, toolResults),
    maxOutputTokens: 1200,
  });
  recordSessionEvent(input.session, {
    kind: "llm_called",
    summary: `${finalResponse.provider}:${finalResponse.model}:skill_answer`,
  });
  debugLog(input.debug, "llm.skill_answer.done", {
    provider: finalResponse.provider,
    model: finalResponse.model,
  });

  const text = finalResponse.text.trim() || renderFallbackSkillResponse(input.skill, plan, toolResults);
  recordSessionEvent(input.session, {
    kind: "agent_reply",
    summary: text.split(/\r?\n/)[0] ?? `${input.skill.name} completed.`,
  });

  return {
    skill: input.skill,
    plan,
    text,
    toolCalls: [
      `llm:${planResponse.provider}:skill_plan`,
      ...toolResults.map((result) => result.tool),
      `llm:${finalResponse.provider}:skill_answer`,
    ],
    toolResults,
    llm: {
      plan: planResponse.raw,
      final: finalResponse.raw,
    },
  };
}

/** runtime 内部执行上下文，用来把前一个 tool 的输出交给后续 tool。 */
interface SkillRuntimeToolContext {
  /** 通过 RPC 或本地文件得到的归一化交易。 */
  transaction?: ChainTransaction;
  /** eth_getTransactionByHash 的结果。 */
  rpcTransaction?: EvmRpcTransaction;
  /** eth_getTransactionReceipt 的结果。 */
  rpcReceipt?: EvmRpcReceipt;
}

const transactionProducerToolNames = [
  "read_normalized_transaction_file",
  "rpc_get_transaction",
  "rpc_get_transaction_receipt",
  "normalize_evm_transaction",
] as const;
const transactionConsumerToolNames = ["decode_transaction", "fourmeme_explain_token_tx"] as const;

/** 对模型计划做 runtime 归一化：缺工具时按当前输入选择合理的工具链。 */
function normalizeSkillExecutionPlan(input: RunSkillInput, plan: SkillExecutionPlan): SkillExecutionPlan {
  const initialToolCalls = plan.toolCalls.length > 0 ? plan.toolCalls : buildFallbackToolCalls(input);
  const toolCalls = ensureTransactionProducerTools(input, initialToolCalls);
  const needsTransaction = toolCalls.some((call) => isTransactionConsumerTool(call.tool));
  const missingInputs =
    needsTransaction &&
    !input.transaction &&
    !input.txPath &&
    !input.txHash &&
    !plan.missingInputs.includes("normalizedTransactionFile or transactionHash")
      ? [...plan.missingInputs, "normalizedTransactionFile or transactionHash"]
      : plan.missingInputs;

  return {
    ...plan,
    toolCalls,
    missingInputs,
  };
}

/** 根据当前输入构造 fallback 工具链，避免模型计划为空时 skill 无法推进。 */
function buildFallbackToolCalls(input: RunSkillInput): SkillExecutionPlan["toolCalls"] {
  const allowedTools = new Set(input.skill.tools);
  const toolNames = [
    ...buildTransactionProducerToolNames(input).filter((tool) => allowedTools.has(tool)),
    ...input.skill.tools.filter((tool) => !isTransactionProducerTool(tool)),
  ];

  return toolNames.map((tool) => ({
    tool,
    reason: "Fallback from skill runtime because the model did not return a concrete tool plan.",
  }));
}

/** 如果模型直接计划了解码工具但只有 txPath/txHash，自动补上生产交易事实的前置工具。 */
function ensureTransactionProducerTools(
  input: RunSkillInput,
  toolCalls: SkillExecutionPlan["toolCalls"],
): SkillExecutionPlan["toolCalls"] {
  const consumesTransaction = toolCalls.some((call) => isTransactionConsumerTool(call.tool));
  if (!consumesTransaction || input.transaction) {
    return toolCalls;
  }

  const producerTools = buildTransactionProducerToolNames(input).map((tool) => ({
    tool,
    reason: transactionProducerReason(tool),
  }));
  const existingTools = new Set(toolCalls.map((call) => call.tool));
  const missingProducerTools = producerTools.filter((call) => !existingTools.has(call.tool));

  return [...missingProducerTools, ...toolCalls];
}

/** 根据输入形态选择能生产 normalized transaction 的工具名。 */
function buildTransactionProducerToolNames(input: RunSkillInput): string[] {
  if (input.transaction) {
    return [];
  }

  if (input.txPath) {
    return ["read_normalized_transaction_file"];
  }

  if (input.txHash) {
    return ["rpc_get_transaction", "rpc_get_transaction_receipt", "normalize_evm_transaction"];
  }

  return [];
}

/** 判断工具是否负责生产 normalized transaction。 */
function isTransactionProducerTool(tool: string): boolean {
  return transactionProducerToolNames.some((name) => name === tool);
}

/** 判断工具是否需要 normalized transaction 作为输入。 */
function isTransactionConsumerTool(tool: string): boolean {
  return transactionConsumerToolNames.some((name) => name === tool);
}

/** 给自动补齐的生产工具写稳定理由，便于 debug 调用链阅读。 */
function transactionProducerReason(tool: string): string {
  if (tool === "read_normalized_transaction_file") {
    return "Read the provided normalized transaction file before downstream transaction analysis.";
  }

  if (tool === "rpc_get_transaction") {
    return "Fetch the transaction object from the provided transaction hash before downstream analysis.";
  }

  if (tool === "rpc_get_transaction_receipt") {
    return "Fetch receipt logs needed to decode token transfers.";
  }

  if (tool === "normalize_evm_transaction") {
    return "Normalize RPC transaction and receipt into Chaincraft transaction facts.";
  }

  return "Prepare upstream facts required by the selected skill.";
}

/** 解析 skill runtime planner 输出；模型输出不可信，所以需要字段收窄和 fallback。 */
export function parseSkillExecutionPlan(text: string): SkillExecutionPlan {
  const parsed = safeJsonParse(extractJsonObject(text));
  if (!isRecord(parsed)) {
    return {
      summary: "Skill plan could not be parsed safely.",
      toolCalls: [],
      missingInputs: [],
      responseRubric: ["Explain that the skill plan could not be parsed."],
    };
  }

  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "Run the selected skill workflow.",
    toolCalls: parsePlannedToolCalls(parsed.toolCalls),
    missingInputs: parseStringArray(parsed.missingInputs),
    responseRubric: parseStringArray(parsed.responseRubric),
  };
}

/** 按计划执行工具；这里是 runtime 的安全闸门，不信任 LLM 计划本身。 */
async function executeSkillPlan(input: RunSkillInput, plan: SkillExecutionPlan): Promise<SkillToolCallResult[]> {
  const results: SkillToolCallResult[] = [];
  const allowedTools = new Set(input.skill.tools);
  const availableTools = new Set(input.tools.list().map((tool) => tool.name));
  const context: SkillRuntimeToolContext = {
    transaction: input.transaction,
  };

  for (const plannedCall of plan.toolCalls) {
    if (!allowedTools.has(plannedCall.tool)) {
      results.push({
        tool: plannedCall.tool,
        reason: plannedCall.reason,
        ok: false,
        skipped: true,
        error: `Tool is not allowed by ${input.skill.id} skill frontmatter.`,
      });
      // skip 表示 runtime 主动拦截了模型计划，工具没有被执行。
      debugLog(input.debug, `tool.${plannedCall.tool}.skip`, {
        tool: plannedCall.tool,
        reason: plannedCall.reason,
        error: `Tool is not allowed by ${input.skill.id} skill frontmatter.`,
      });
      continue;
    }

    if (!availableTools.has(plannedCall.tool)) {
      results.push({
        tool: plannedCall.tool,
        reason: plannedCall.reason,
        ok: false,
        skipped: true,
        error: "Tool is allowed by skill but not registered in ToolRegistry.",
      });
      // 注册表没有该工具时也记为 skip，说明 skill 声明和运行时能力不一致。
      debugLog(input.debug, `tool.${plannedCall.tool}.skip`, {
        tool: plannedCall.tool,
        reason: plannedCall.reason,
        error: "Tool is allowed by skill but not registered in ToolRegistry.",
      });
      continue;
    }

    // tool.<name>.start 只打印输入摘要；完整 receipt/logs 不进 debug，避免刷屏和泄露。
    debugLog(input.debug, `tool.${plannedCall.tool}.start`, {
      tool: plannedCall.tool,
      reason: plannedCall.reason,
      input: summarizeKnownToolInput(input, context, plannedCall.tool),
    });
    const result = await executeKnownSkillTool(input, context, plannedCall.tool, plannedCall.reason);
    updateRuntimeToolContext(context, plannedCall.tool, result);
    results.push(result);
    // 成功用 done，工具执行失败用 error；两者都保留同一组摘要字段。
    debugLog(input.debug, `tool.${plannedCall.tool}.${result.ok ? "done" : "error"}`, {
      tool: plannedCall.tool,
      ok: result.ok,
      skipped: result.skipped,
      output: result.ok ? summarizeKnownToolOutput(plannedCall.tool, result.value) : undefined,
      error: result.error,
    });

    if (!result.skipped) {
      recordSessionEvent(input.session, {
        kind: "tool_called",
        summary: plannedCall.tool,
      });
    }
  }

  return results;
}

/** debug 只打印工具输入摘要，避免把完整 receipt/logs 或大对象打满屏。 */
function summarizeKnownToolInput(
  input: RunSkillInput,
  context: SkillRuntimeToolContext,
  tool: string,
): unknown {
  if (tool === "read_normalized_transaction_file") {
    return {
      txPath: input.txPath,
    };
  }

  if (tool === "rpc_get_transaction" || tool === "rpc_get_transaction_receipt") {
    return {
      txHash: input.txHash,
      chainId: input.session.chainId,
      hasCustomRpcUrl: input.rpcUrl !== undefined,
    };
  }

  if (tool === "normalize_evm_transaction") {
    return {
      chainId: input.session.chainId,
      txHash: context.rpcTransaction?.hash,
      receiptHash: context.rpcReceipt?.transactionHash,
      logCount: context.rpcReceipt?.logs.length,
    };
  }

  if (tool === "decode_erc20_transfers") {
    return {
      receiptHash: context.rpcReceipt?.transactionHash,
      logCount: context.rpcReceipt?.logs.length,
    };
  }

  if (tool === "decode_transaction") {
    return summarizeChainTransaction(context.transaction);
  }

  if (tool === "fourmeme_explain_token_tx") {
    return {
      transaction: summarizeChainTransaction(context.transaction),
      walletAddress: input.session.walletAddress,
      tokenAddress: input.tokenAddress,
    };
  }

  return undefined;
}

/** debug 只打印工具输出摘要，保留调用链可读性。 */
function summarizeKnownToolOutput(tool: string, value: unknown): unknown {
  if (tool === "rpc_get_transaction" && isRecord(value)) {
    return {
      txHash: value.hash,
      from: value.from,
      to: value.to,
    };
  }

  if (tool === "rpc_get_transaction_receipt" && isRecord(value)) {
    return {
      txHash: value.transactionHash,
      logCount: Array.isArray(value.logs) ? value.logs.length : undefined,
    };
  }

  if (tool === "normalize_evm_transaction" || tool === "read_normalized_transaction_file") {
    return summarizeChainTransaction(value);
  }

  if (tool === "decode_erc20_transfers" && Array.isArray(value)) {
    return {
      transferCount: value.length,
    };
  }

  if (tool === "decode_transaction" && isRecord(value)) {
    return {
      txHash: value.hash,
      method: value.method,
      tokenTransferCount: value.tokenTransferCount,
    };
  }

  if (tool === "fourmeme_explain_token_tx" && isRecord(value)) {
    return {
      txHash: value.txHash,
      primaryAction: value.primaryAction,
      movementCount: Array.isArray(value.movements) ? value.movements.length : undefined,
    };
  }

  return value;
}

/** ChainTransaction 摘要，避免完整 token movement 列表过长。 */
function summarizeChainTransaction(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    txHash: value.hash,
    chainId: value.chainId,
    from: value.from,
    to: value.to,
    transferCount: Array.isArray(value.tokenTransfers) ? value.tokenTransfers.length : undefined,
  };
}

/** MVP 阶段的工具输入 adapter；后续新 tool 应该在这里或插件 runtime 中声明输入映射。 */
async function executeKnownSkillTool(
  input: RunSkillInput,
  context: SkillRuntimeToolContext,
  tool: string,
  reason: string,
): Promise<SkillToolCallResult> {
  if (tool === "read_normalized_transaction_file") {
    if (!input.txPath) {
      return createMissingInputResult(tool, reason, "normalizedTransactionFile");
    }

    const result = await input.tools.call<ChainTransaction>(
      tool,
      {
        txPath: input.txPath,
      },
      input.session,
    );
    return normalizeToolResult(tool, reason, result);
  }

  if (tool === "rpc_get_transaction") {
    if (!input.txHash) {
      return createMissingInputResult(tool, reason, "transactionHash");
    }

    const result = await input.tools.call<EvmRpcTransaction>(
      tool,
      {
        txHash: input.txHash,
        chainId: input.session.chainId,
        rpcUrl: input.rpcUrl,
      },
      input.session,
    );
    return normalizeToolResult(tool, reason, result);
  }

  if (tool === "rpc_get_transaction_receipt") {
    if (!input.txHash) {
      return createMissingInputResult(tool, reason, "transactionHash");
    }

    const result = await input.tools.call<EvmRpcReceipt>(
      tool,
      {
        txHash: input.txHash,
        chainId: input.session.chainId,
        rpcUrl: input.rpcUrl,
      },
      input.session,
    );
    return normalizeToolResult(tool, reason, result);
  }

  if (tool === "normalize_evm_transaction") {
    if (!context.rpcTransaction) {
      return createMissingInputResult(tool, reason, "rpcTransaction");
    }

    if (!context.rpcReceipt) {
      return createMissingInputResult(tool, reason, "rpcReceipt");
    }

    const result = await input.tools.call<ChainTransaction>(
      tool,
      {
        chainId: input.session.chainId,
        transaction: context.rpcTransaction,
        receipt: context.rpcReceipt,
      },
      input.session,
    );
    return normalizeToolResult(tool, reason, result);
  }

  if (tool === "decode_erc20_transfers") {
    if (!context.rpcReceipt) {
      return createMissingInputResult(tool, reason, "rpcReceipt");
    }

    const result = await input.tools.call(tool, { receipt: context.rpcReceipt }, input.session);
    return normalizeToolResult(tool, reason, result);
  }

  if (tool === "decode_transaction") {
    if (!context.transaction) {
      return createMissingInputResult(tool, reason, "normalizedTransaction");
    }

    const result = await input.tools.call<DecodedTransaction>(tool, context.transaction, input.session);
    return normalizeToolResult(tool, reason, result);
  }

  if (tool === "fourmeme_explain_token_tx") {
    if (!context.transaction) {
      return createMissingInputResult(tool, reason, "normalizedTransaction");
    }

    const result = await input.tools.call<FourMemeTokenTxExplanation>(
      tool,
      {
        transaction: context.transaction,
        walletAddress: input.session.walletAddress,
        tokenAddress: input.tokenAddress,
      },
      input.session,
    );
    return normalizeToolResult(tool, reason, result);
  }

  return {
    tool,
    reason,
    ok: false,
    skipped: true,
    error: "No runtime input adapter exists for this tool yet.",
  };
}

/** 把工具输出写回 runtime context，供后续工具使用。 */
function updateRuntimeToolContext(
  context: SkillRuntimeToolContext,
  tool: string,
  result: SkillToolCallResult,
): void {
  if (!result.ok || result.value === undefined) {
    return;
  }

  if (tool === "rpc_get_transaction") {
    context.rpcTransaction = result.value as EvmRpcTransaction;
    return;
  }

  if (tool === "rpc_get_transaction_receipt") {
    context.rpcReceipt = result.value as EvmRpcReceipt;
    return;
  }

  if (tool === "normalize_evm_transaction") {
    context.transaction = result.value as ChainTransaction;
    return;
  }

  if (tool === "read_normalized_transaction_file") {
    context.transaction = result.value as ChainTransaction;
  }
}

/** 把 ToolResult union 转成 skill runtime 统一的工具结果。 */
function normalizeToolResult(
  tool: string,
  reason: string,
  result: { ok: true; value: unknown } | { ok: false; error: { message: string } },
): SkillToolCallResult {
  if (result.ok) {
    return {
      tool,
      reason,
      ok: true,
      value: result.value,
    };
  }

  return {
    tool,
    reason,
    ok: false,
    error: result.error.message,
  };
}

/** 创建缺输入的跳过结果。 */
function createMissingInputResult(tool: string, reason: string, inputName: string): SkillToolCallResult {
  return {
    tool,
    reason,
    ok: false,
    skipped: true,
    error: `Missing input: ${inputName}`,
  };
}

/** skill runtime planner 的 system prompt，强调 SKILL.md 是运行时操作手册。 */
function buildSkillPlanSystemPrompt(skill: SkillManifest): string {
  return `You are the Chaincraft Skill Runtime planner.

You must use the selected SKILL.md as the protocol playbook. The skill controls workflow, tool policy, risk boundaries, and output expectations.

Security policy:
- Skills are instructions, not execution power.
- Only plan tools listed in the skill frontmatter.
- Never plan wallet signature or broadcast actions when autoSign/autoBroadcast are false.
- Never claim chain facts yourself. Chain facts must come from typed tool results.

Selected skill:
- id: ${skill.id}
- name: ${skill.name}
- allowed tools: ${skill.tools.join(", ") || "none"}
- autoSign: ${String(skill.safety.autoSign)}
- autoBroadcast: ${String(skill.safety.autoBroadcast)}

Return only JSON with this exact shape:
{
  "summary": "short skill-specific execution plan",
  "toolCalls": [
    {"tool": "tool_name", "reason": "why this tool is needed"}
  ],
  "missingInputs": ["input name"],
  "responseRubric": ["final answer requirement"]
}`;
}

/** skill runtime planner 的 user prompt，包含完整 SKILL.md 正文和当前输入。 */
function buildSkillPlanUserPrompt(input: RunSkillInput): string {
  return stringifyForPrompt({
    userPrompt: input.prompt,
    routePlan: input.routePlan,
    inputContext: input.inputContext,
    session: {
      walletAddress: input.session.walletAddress,
      chainId: input.session.chainId,
      riskPosture: input.session.riskPosture,
    },
    availableInputs: {
      normalizedTransaction: input.transaction !== undefined,
      normalizedTransactionFile: input.txPath !== undefined,
      transactionHash: input.txHash !== undefined,
      tokenAddress: input.tokenAddress !== undefined,
    },
    availableTools: input.tools.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
    skill: {
      id: input.skill.id,
      name: input.skill.name,
      description: input.skill.description,
      tools: input.skill.tools,
      safety: input.skill.safety,
      body: input.skill.body,
    },
  });
}

/** 最终回答的 system prompt，要求模型只基于工具事实组织用户可读输出。 */
function buildSkillFinalSystemPrompt(skill: SkillManifest): string {
  return `You are Chaincraft's skill answer writer.

Use the selected SKILL.md output guidance and the typed tool facts to answer the user.

Rules:
- Do not invent chain facts.
- Clearly separate facts, inferences, risk notes, and next steps when the skill asks for it.
- If a tool was skipped or failed, say what is missing instead of pretending the result exists.
- Do not ask for wallet signatures or broadcast transactions when the skill safety policy forbids it.
- Keep the answer concise and useful.

Selected skill: ${skill.name}`;
}

/** 最终回答的 user prompt，包含 skill 正文、计划和工具事实。 */
function buildSkillFinalUserPrompt(
  input: RunSkillInput,
  plan: SkillExecutionPlan,
  toolResults: SkillToolCallResult[],
): string {
  return stringifyForPrompt({
    userPrompt: input.prompt,
    inputContext: input.inputContext,
    session: {
      walletAddress: input.session.walletAddress,
      chainId: input.session.chainId,
      riskPosture: input.session.riskPosture,
    },
    skill: {
      id: input.skill.id,
      name: input.skill.name,
      description: input.skill.description,
      tools: input.skill.tools,
      safety: input.skill.safety,
      body: input.skill.body,
    },
    executionPlan: plan,
    typedToolFacts: toolResults,
  });
}

/** 缺输入时的 deterministic 响应，不再额外调用 final LLM。 */
function renderMissingInputsResponse(
  skill: SkillManifest,
  plan: SkillExecutionPlan,
  missingInputResults: SkillToolCallResult[],
): string {
  const missingInputs = [
    ...plan.missingInputs,
    ...missingInputResults
      .map((result) => result.error?.replace("Missing input: ", ""))
      .filter((value): value is string => Boolean(value)),
  ];
  const uniqueMissingInputs = [...new Set(missingInputs)];

  return [
    `Skill: ${skill.name}`,
    `Plan: ${plan.summary}`,
    "",
    "Missing inputs:",
    ...(uniqueMissingInputs.length > 0 ? uniqueMissingInputs.map((input) => `- ${input}`) : ["- normalizedTransaction"]),
  ].join("\n");
}

/** final LLM 返回空文本时的兜底输出。 */
function renderFallbackSkillResponse(
  skill: SkillManifest,
  plan: SkillExecutionPlan,
  toolResults: SkillToolCallResult[],
): string {
  return [
    `Skill: ${skill.name}`,
    `Plan: ${plan.summary}`,
    "",
    "Typed tool facts:",
    stringifyForPrompt(toolResults),
  ].join("\n");
}

/** 解析 toolCalls 数组，只保留 tool/reason 都是字符串的项。 */
function parsePlannedToolCalls(value: unknown): SkillExecutionPlan["toolCalls"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!isRecord(item) || typeof item.tool !== "string") {
        return undefined;
      }

      return {
        tool: item.tool,
        reason: typeof item.reason === "string" ? item.reason : "Required by skill workflow.",
      };
    })
    .filter((item): item is SkillExecutionPlan["toolCalls"][number] => item !== undefined);
}

/** 从模型输出字段中读取字符串数组。 */
function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

/** 从模型回复里提取 JSON 对象，兼容纯 JSON 和 fenced code block。 */
function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return text;
  }

  return text.slice(start, end + 1);
}

/** JSON 解析失败时返回 undefined，让调用方走安全 fallback。 */
function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** unknown 到对象字典的类型窄化工具。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** JSON.stringify 包装：把 bigint 转成字符串，避免工具事实无法序列化。 */
function stringifyForPrompt(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}
