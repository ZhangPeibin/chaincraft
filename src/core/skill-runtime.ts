import { recordSessionEvent } from "./session.ts";
import type {
  ChainTransaction,
  DecodedTransaction,
  FourMemeTokenTxExplanation,
  LlmClient,
  LlmResponse,
  SessionState,
  SkillExecutionPlan,
  SkillManifest,
  SkillRuntimeResult,
  SkillToolCallResult,
} from "./types.ts";
import { ToolRegistry } from "./tools.ts";

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
  /** 可选 token 过滤条件。 */
  tokenAddress?: string;
  /** 路由阶段给出的计划，作为 skill runtime 的上游参考。 */
  routePlan?: unknown;
}

/** 执行选中的 skill：用完整 SKILL.md 生成计划，再按 typed tool 边界执行。 */
export async function runSkill(input: RunSkillInput): Promise<SkillRuntimeResult> {
  recordSessionEvent(input.session, {
    kind: "skill_selected",
    summary: `${input.skill.name}: ${input.skill.description}`,
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

  const plan = normalizeSkillExecutionPlan(input, parseSkillExecutionPlan(planResponse.text));
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

  const finalResponse = await input.llm.generate({
    system: buildSkillFinalSystemPrompt(input.skill),
    user: buildSkillFinalUserPrompt(input, plan, toolResults),
    maxOutputTokens: 1200,
  });
  recordSessionEvent(input.session, {
    kind: "llm_called",
    summary: `${finalResponse.provider}:${finalResponse.model}:skill_answer`,
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

/** 对模型计划做 runtime 归一化：缺工具时回退到 skill frontmatter 声明的工具顺序。 */
function normalizeSkillExecutionPlan(input: RunSkillInput, plan: SkillExecutionPlan): SkillExecutionPlan {
  const toolCalls =
    plan.toolCalls.length > 0
      ? plan.toolCalls
      : input.skill.tools.map((tool) => ({
          tool,
          reason: "Fallback from skill frontmatter because the model did not return a concrete tool plan.",
        }));
  const needsTransaction = toolCalls.some((call) =>
    call.tool === "decode_transaction" || call.tool === "fourmeme_explain_token_tx"
  );
  const missingInputs =
    needsTransaction && !input.transaction && !plan.missingInputs.includes("normalizedTransaction")
      ? [...plan.missingInputs, "normalizedTransaction"]
      : plan.missingInputs;

  return {
    ...plan,
    toolCalls,
    missingInputs,
  };
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

  for (const plannedCall of plan.toolCalls) {
    if (!allowedTools.has(plannedCall.tool)) {
      results.push({
        tool: plannedCall.tool,
        reason: plannedCall.reason,
        ok: false,
        skipped: true,
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
      continue;
    }

    const result = await executeKnownSkillTool(input, plannedCall.tool, plannedCall.reason);
    results.push(result);

    if (!result.skipped) {
      recordSessionEvent(input.session, {
        kind: "tool_called",
        summary: plannedCall.tool,
      });
    }
  }

  return results;
}

/** MVP 阶段的工具输入 adapter；后续新 tool 应该在这里或插件 runtime 中声明输入映射。 */
async function executeKnownSkillTool(
  input: RunSkillInput,
  tool: string,
  reason: string,
): Promise<SkillToolCallResult> {
  if (tool === "decode_transaction") {
    if (!input.transaction) {
      return createMissingInputResult(tool, reason, "normalizedTransaction");
    }

    const result = await input.tools.call<DecodedTransaction>(tool, input.transaction, input.session);
    return normalizeToolResult(tool, reason, result);
  }

  if (tool === "fourmeme_explain_token_tx") {
    if (!input.transaction) {
      return createMissingInputResult(tool, reason, "normalizedTransaction");
    }

    const result = await input.tools.call<FourMemeTokenTxExplanation>(
      tool,
      {
        transaction: input.transaction,
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
    session: {
      walletAddress: input.session.walletAddress,
      chainId: input.session.chainId,
      riskPosture: input.session.riskPosture,
    },
    availableInputs: {
      normalizedTransaction: input.transaction !== undefined,
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
