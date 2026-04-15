import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkills } from "./core/skill-loader.ts";
import { runSkill } from "./core/skill-runtime.ts";
import { recordSessionEvent } from "./core/session.ts";
import type {
  AgentAskReply,
  AgentPlan,
  AgentReply,
  ChainTransaction,
  FourMemeTokenTxExplanation,
  LlmClient,
  SessionState,
  SkillManifest,
} from "./core/types.ts";
import { ToolRegistry } from "./core/tools.ts";
import { decodeTransactionTool, fourMemeExplainTokenTxTool } from "./tools/fourmeme.ts";

/** Chaincraft Agent 对外暴露的能力集合。 */
export interface ChaincraftAgent {
  /** 列出当前项目可用的 skills。 */
  listSkills(): Promise<SkillManifest[]>;
  /** 自然语言入口：先由 LLM 规划，再根据计划调用 typed tools。 */
  ask(input: AskInput): Promise<AgentAskReply>;
  /** 直接执行 FourMeme 交易解释，不经过 LLM planner。 */
  explainFourMemeTokenTx(input: ExplainFourMemeTokenTxInput): Promise<AgentReply>;
}

/** ask 命令传给 Agent 的输入。 */
export interface AskInput {
  /** 当前会话上下文。 */
  session: SessionState;
  /** 用户自然语言需求。 */
  prompt: string;
  /** 可选的归一化交易数据；当前 FourMeme MVP 需要它才能产出链上事实。 */
  transaction?: ChainTransaction;
  /** 可选 token 过滤条件，用于多 token 转账交易。 */
  tokenAddress?: string;
}

/** 直接解释 FourMeme 交易时需要的输入。 */
export interface ExplainFourMemeTokenTxInput {
  /** 当前会话上下文。 */
  session: SessionState;
  /** 已归一化交易。 */
  transaction: ChainTransaction;
  /** 可选用户原始 prompt，用于写入 session history。 */
  prompt?: string;
  /** 可选 token 过滤条件。 */
  tokenAddress?: string;
}

/** 注册 MVP 阶段默认可用的 typed tools。 */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(decodeTransactionTool);
  registry.register(fourMemeExplainTokenTxTool);
  return registry;
}

export function createChaincraftAgent(
  input: { skillsRoot?: string; tools?: ToolRegistry; llm?: LlmClient } = {},
): ChaincraftAgent {
  // tools 和 skillsRoot 都允许注入，方便测试和未来插件系统替换默认实现。
  const tools = input.tools ?? createDefaultToolRegistry();
  const skillsRoot = input.skillsRoot ?? path.join(projectRoot(), "skills");

  return {
    async listSkills() {
      return loadSkills(skillsRoot);
    },

    async ask({ session, prompt, transaction, tokenAddress }) {
      // ask 是真正的 LLM Agent 入口；没有 LLM 时不能假装已经理解自然语言。
      if (!input.llm) {
        throw new Error("No LLM client configured. Use chaincraft ask with OPENAI_API_KEY or ANTHROPIC_API_KEY.");
      }

      recordSessionEvent(session, {
        kind: "user_prompt",
        summary: prompt,
      });

      // LLM 只负责计划和路由，不直接产生链上事实。
      const skills = await loadSkills(skillsRoot);
      const llmResponse = await input.llm.generate({
        system: buildPlannerSystemPrompt(),
        user: buildPlannerUserPrompt({
          prompt,
          session,
          skills,
          hasTransaction: transaction !== undefined,
        }),
        maxOutputTokens: 700,
      });
      recordSessionEvent(session, {
        kind: "llm_called",
        summary: `${llmResponse.provider}:${llmResponse.model}`,
      });

      // 只有解析成安全的结构化计划后，Agent 才会进入工具执行阶段。
      const plan = parseAgentPlan(llmResponse.text);
      const selectedSkillId = plan.skillId ?? (plan.intent === "fourmeme_tx_explain" ? "fourmeme" : undefined);
      const selectedSkill = selectedSkillId ? skills.find((skill) => skill.id === selectedSkillId) : undefined;

      if (selectedSkill) {
        // 真正的 skill runtime：完整 SKILL.md 参与二次规划、工具执行和最终回答。
        const skillResult = await runSkill({
          skill: selectedSkill,
          session,
          prompt,
          tools,
          llm: input.llm,
          transaction,
          tokenAddress,
          routePlan: plan,
        });

        return {
          text: skillResult.text,
          skill: selectedSkill,
          toolCalls: [`llm:${llmResponse.provider}:route`, ...skillResult.toolCalls],
          data: {
            routePlan: plan,
            skillPlan: skillResult.plan,
            toolResults: skillResult.toolResults,
            llm: {
              route: llmResponse.raw,
              skill: skillResult.llm,
            },
          },
        };
      }

      // 暂不支持的意图只返回 LLM plan，不调用链上工具。
      const suffix =
        plan.missingInputs.length > 0 ? `\n\nMissing inputs: ${plan.missingInputs.join(", ")}` : "";

      return {
        text: `${plan.userFacingPlan}${suffix}`,
        toolCalls: [`llm:${llmResponse.provider}:route`],
        data: { plan, llm: llmResponse.raw },
      };
    },

    async explainFourMemeTokenTx({ session, transaction, prompt, tokenAddress }) {
      // direct explain 路径用于测试、脚本和确定性 CLI demo，可以不依赖 LLM。
      if (prompt) {
        recordSessionEvent(session, {
          kind: "user_prompt",
          summary: prompt,
        });
      }

      const skill = await selectSkill(skillsRoot, "fourmeme");
      recordSessionEvent(session, {
        kind: "skill_selected",
        summary: `${skill.name}: ${skill.description}`,
      });

      // 第一步先把交易归一化为基础事实。
      const decoded = await tools.call("decode_transaction", transaction, session);
      recordSessionEvent(session, {
        kind: "tool_called",
        summary: "decode_transaction",
      });

      if (!decoded.ok) {
        throw new Error(decoded.error.message);
      }

      // 第二步调用 FourMeme 领域工具，从关注钱包视角解释 token movement。
      const explained = await tools.call<FourMemeTokenTxExplanation>(
        "fourmeme_explain_token_tx",
        {
          transaction,
          walletAddress: session.walletAddress,
          tokenAddress,
        },
        session,
      );
      recordSessionEvent(session, {
        kind: "tool_called",
        summary: "fourmeme_explain_token_tx",
      });

      if (!explained.ok) {
        throw new Error(explained.error.message);
      }

      const text = renderFourMemeExplanation(skill, explained.value);
      recordSessionEvent(session, {
        kind: "agent_reply",
        summary: explained.value.summary,
      });

      return {
        skill,
        text,
        toolCalls: ["decode_transaction", "fourmeme_explain_token_tx"],
        data: {
          decoded: decoded.value,
          explanation: explained.value,
        },
      };
    },
  };
}

/** 解析 LLM planner 输出；模型输出不可信，所以这里做宽容解析和字段收窄。 */
export function parseAgentPlan(text: string): AgentPlan {
  const parsed = safeJsonParse(extractJsonObject(text));
  if (!isRecord(parsed)) {
    return {
      intent: "unsupported",
      userFacingPlan: "I could not parse a safe plan from the model response.",
      missingInputs: [],
    };
  }

  const intent =
    parsed.intent === "skill" ||
    parsed.intent === "fourmeme_tx_explain" ||
    parsed.intent === "general_chat" ||
    parsed.intent === "unsupported"
      ? parsed.intent
      : "unsupported";
  const skillId = typeof parsed.skillId === "string" ? parsed.skillId : undefined;
  const userFacingPlan = typeof parsed.userFacingPlan === "string" ? parsed.userFacingPlan : "I need more detail.";
  const missingInputs = Array.isArray(parsed.missingInputs)
    ? parsed.missingInputs.filter((value): value is string => typeof value === "string")
    : [];

  return {
    intent,
    skillId,
    userFacingPlan,
    missingInputs,
  };
}

/** 按 ID 选择 skill；找不到说明项目配置和 planner 结果不一致。 */
async function selectSkill(skillsRoot: string, id: string): Promise<SkillManifest> {
  const skills = await loadSkills(skillsRoot);
  const skill = skills.find((candidate) => candidate.id === id);
  if (!skill) {
    throw new Error(`Skill not found: ${id}`);
  }

  return skill;
}

/** 把 FourMeme 结构化解释渲染成当前 CLI 使用的文本格式。 */
function renderFourMemeExplanation(skill: SkillManifest, explanation: FourMemeTokenTxExplanation): string {
  const lines = [
    `Skill: ${skill.name}`,
    `Action: ${explanation.primaryAction.replaceAll("_", " ")}`,
    `Summary: ${explanation.summary}`,
    "",
    "Observations:",
    ...explanation.observations.map((observation) => `- ${observation}`),
    "",
    "Risk notes:",
    ...explanation.riskNotes.map((note) => `- ${note}`),
    "",
    "Next questions:",
    ...explanation.nextQuestions.map((question) => `- ${question}`),
  ];

  return lines.join("\n");
}

/** planner 的 system prompt：明确模型只能规划，不能越过 typed tools 编造链上事实。 */
function buildPlannerSystemPrompt(): string {
  return `You are Chaincraft, an on-chain agent workbench for DeFi users.

Your job is to understand the user's natural-language request, choose an available skill, and produce a concise routing plan.

Security policy:
- Never claim a chain fact unless it comes from a typed tool result.
- Never request a wallet signature unless the user explicitly asks to build or sign a transaction.
- Never broadcast a transaction.
- Skills are playbooks, not execution power. Tools produce facts and actions.
- This routing step should not decide tool details. The selected skill runtime will read the full SKILL.md and plan tools.

Return only JSON with this exact shape:
{
  "intent": "skill" | "general_chat" | "unsupported",
  "skillId": "available skill id or null",
  "userFacingPlan": "short routing reason",
  "missingInputs": ["input name"]
}`;
}

/** 把用户 prompt、session 和可用 skill 压成稳定 JSON，降低 prompt 漂移。 */
function buildPlannerUserPrompt(input: {
  prompt: string;
  session: SessionState;
  skills: SkillManifest[];
  hasTransaction: boolean;
}): string {
  const skills = input.skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tools: skill.tools,
    safety: skill.safety,
  }));

  return JSON.stringify(
    {
      userPrompt: input.prompt,
      session: {
        walletAddress: input.session.walletAddress,
        chainId: input.session.chainId,
        riskPosture: input.session.riskPosture,
      },
      availableSkills: skills,
      availableInputs: {
        normalizedTransaction: input.hasTransaction,
      },
    },
    undefined,
    2,
  );
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

/** 计算项目根目录，便于源码模式下直接读取 skills/。 */
function projectRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}
