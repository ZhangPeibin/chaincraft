import path from "node:path";
import { fileURLToPath } from "node:url";
import { debugLog, noopDebugLogger, type DebugLogger } from "./core/debug.ts";
import { extractInputContext } from "./core/input-extractor.ts";
import { loadSkills } from "./core/skill-loader.ts";
import { buildSkillCandidates } from "./core/skill-matcher.ts";
import { runSkill } from "./core/skill-runtime.ts";
import { recordSessionEvent } from "./core/session.ts";
import type {
  AgentAskReply,
  AgentInputContext,
  AgentPlan,
  AgentReply,
  ChainTransaction,
  FourMemeTokenTxExplanation,
  LlmClient,
  SessionState,
  SkillCandidate,
  SkillManifest,
} from "./core/types.ts";
import { ToolRegistry } from "./core/tools.ts";
import {
  decodeErc20TransfersTool,
  normalizeEvmTransactionTool,
  rpcGetTransactionReceiptTool,
  rpcGetTransactionTool,
} from "./tools/evm-rpc.ts";
import { decodeTransactionTool, fourMemeExplainTokenTxTool } from "./tools/fourmeme.ts";
import { readNormalizedTransactionFileTool } from "./tools/transaction-file.ts";

export { extractTransactionHashFromPrompt } from "./core/input-extractor.ts";

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
  /** 可选本地归一化交易文件路径；ask 路径会交给 skill runtime 决定是否读取。 */
  txPath?: string;
  /** 可选交易哈希；ask 路径会把它交给 skill runtime，由 AI 计划是否调用 RPC tools。 */
  txHash?: string;
  /** 可选 RPC URL；传给 skill runtime 的 RPC tool adapter。 */
  rpcUrl?: string;
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
  registry.register(readNormalizedTransactionFileTool);
  registry.register(rpcGetTransactionTool);
  registry.register(rpcGetTransactionReceiptTool);
  registry.register(decodeErc20TransfersTool);
  registry.register(normalizeEvmTransactionTool);
  registry.register(decodeTransactionTool);
  registry.register(fourMemeExplainTokenTxTool);
  return registry;
}

export function createChaincraftAgent(
  input: { skillsRoot?: string; tools?: ToolRegistry; llm?: LlmClient; debug?: DebugLogger } = {},
): ChaincraftAgent {
  // tools 和 skillsRoot 都允许注入，方便测试和未来插件系统替换默认实现。
  const tools = input.tools ?? createDefaultToolRegistry();
  const skillsRoot = input.skillsRoot ?? path.join(projectRoot(), "skills");
  const debug = input.debug ?? noopDebugLogger;

  return {
    async listSkills() {
      return loadSkills(skillsRoot);
    },

    async ask({ session, prompt, transaction, txPath, txHash, rpcUrl, tokenAddress }) {
      // ask 是真正的 LLM Agent 入口；没有 LLM 时不能假装已经理解自然语言。
      if (!input.llm) {
        throw new Error("No LLM client configured. Use chaincraft ask with OPENAI_API_KEY or ANTHROPIC_API_KEY.");
      }

      // 输入提取是协议无关层：只识别链上通用信号，不在 ask 里决定 FourMeme/Uniswap/Aave。
      const inputContext = extractInputContext({
        session,
        prompt,
        transaction,
        txPath,
        txHash,
        tokenAddress,
      });
      debugLog(debug, "agent.ask.start", {
        sessionId: session.id,
        chainId: session.chainId,
        walletAddress: session.walletAddress,
        hasTxPath: txPath !== undefined,
        hasTxHash: inputContext.transactionHash !== undefined,
        hasTokenAddress: tokenAddress !== undefined,
      });
      debugLog(debug, "input.extract.done", {
        chainId: inputContext.chainId,
        txHash: inputContext.transactionHash,
        protocolHints: inputContext.protocolHints,
        actionHints: inputContext.actionHints,
        inputTypes: inputContext.inputTypes,
        addressCount: inputContext.addresses.length,
      });

      recordSessionEvent(session, {
        kind: "user_prompt",
        summary: prompt,
      });

      // LLM 只负责计划和路由，不直接产生链上事实。
      const skills = await loadSkills(skillsRoot);
      // skill.load.done 只说明本地 skill 清单已加载，不代表已经选择某个协议。
      debugLog(debug, "skill.load.done", {
        count: skills.length,
        skills: skills.map((skill) => skill.id),
      });
      const candidates = buildSkillCandidates(skills, inputContext);
      // skill.candidates.done 是本地候选收窄结果；LLM router 只在这个短名单里判断。
      debugLog(debug, "skill.candidates.done", {
        count: candidates.length,
        candidates: candidates.map((candidate) => ({
          skillId: candidate.skill.id,
          score: candidate.score,
          reasons: candidate.reasons,
        })),
      });

      // 第一轮 LLM 只做 intent/skill 路由，不允许在这里编造链上事实。
      debugLog(debug, "llm.route.start", {
        maxOutputTokens: 700,
      });
      const llmResponse = await input.llm.generate({
        system: buildPlannerSystemPrompt(),
        user: buildPlannerUserPrompt({
          prompt,
          session,
          inputContext,
          candidates,
          hasTransaction: transaction !== undefined,
          hasTxPath: txPath !== undefined,
        }),
        maxOutputTokens: 700,
      });
      recordSessionEvent(session, {
        kind: "llm_called",
        summary: `${llmResponse.provider}:${llmResponse.model}`,
      });
      debugLog(debug, "llm.route.done", {
        provider: llmResponse.provider,
        model: llmResponse.model,
      });

      // 只有解析成安全的结构化计划后，Agent 才会进入工具执行阶段。
      const plan = parseAgentPlan(llmResponse.text);
      // route.done 记录模型给出的结构化路由结果，后续仍会经过本地 skill 查找。
      debugLog(debug, "agent.route.done", {
        intent: plan.intent,
        skillId: plan.skillId,
        missingInputs: plan.missingInputs,
        candidateSkillIds: candidates.map((candidate) => candidate.skill.id),
      });
      const selectedSkill = selectSkillFromRoutePlan(plan, candidates, skills);
      // skill_select.done 记录最终采用的 skill；source 用来区分 LLM 路由还是本地兜底。
      debugLog(debug, "agent.skill_select.done", {
        skillId: selectedSkill?.id,
        skillName: selectedSkill?.name,
        source: plan.skillId ? "llm_route" : selectedSkill ? "local_candidate" : "none",
      });

      if (selectedSkill) {
        // 真正的 skill runtime：完整 SKILL.md 参与二次规划、工具执行和最终回答。
        const skillResult = await runSkill({
          skill: selectedSkill,
          session,
          prompt,
          tools,
          llm: input.llm,
          transaction,
          txPath,
          txHash: inputContext.transactionHash,
          rpcUrl,
          tokenAddress,
          routePlan: plan,
          inputContext,
          debug,
        });

        return {
          text: skillResult.text,
          skill: selectedSkill,
          toolCalls: [`llm:${llmResponse.provider}:route`, ...skillResult.toolCalls],
          data: {
            routePlan: plan,
            inputContext,
            skillCandidates: candidates.map(summarizeSkillCandidate),
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
        data: {
          plan,
          inputContext,
          skillCandidates: candidates.map(summarizeSkillCandidate),
          llm: llmResponse.raw,
        },
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
      // direct explain 不经过 LLM route，但仍复用同一套 skill/tool debug 事件。
      debugLog(debug, "agent.skill_select.done", {
        skillId: skill.id,
        skillName: skill.name,
        source: "direct_explain",
      });
      recordSessionEvent(session, {
        kind: "skill_selected",
        summary: `${skill.name}: ${skill.description}`,
      });

      // 第一步先把交易归一化为基础事实。
      // direct explain 的工具事件也使用 tool.<name>.<status>，保持和 SkillRuntime 一致。
      debugLog(debug, "tool.decode_transaction.start", {
        tool: "decode_transaction",
        input: summarizeToolInput("decode_transaction", transaction),
      });
      const decoded = await tools.call("decode_transaction", transaction, session);
      debugLog(debug, "tool.decode_transaction.done", {
        tool: "decode_transaction",
        ok: decoded.ok,
        output: decoded.ok ? summarizeToolOutput("decode_transaction", decoded.value) : undefined,
        error: decoded.ok ? undefined : decoded.error.message,
      });
      recordSessionEvent(session, {
        kind: "tool_called",
        summary: "decode_transaction",
      });

      if (!decoded.ok) {
        throw new Error(decoded.error.message);
      }

      // 第二步调用 FourMeme 领域工具，从关注钱包视角解释 token movement。
      debugLog(debug, "tool.fourmeme_explain_token_tx.start", {
        tool: "fourmeme_explain_token_tx",
        input: {
          txHash: transaction.hash,
          walletAddress: session.walletAddress,
          tokenAddress,
        },
      });
      const explained = await tools.call<FourMemeTokenTxExplanation>(
        "fourmeme_explain_token_tx",
        {
          transaction,
          walletAddress: session.walletAddress,
          tokenAddress,
        },
        session,
      );
      debugLog(debug, "tool.fourmeme_explain_token_tx.done", {
        tool: "fourmeme_explain_token_tx",
        ok: explained.ok,
        output: explained.ok ? summarizeToolOutput("fourmeme_explain_token_tx", explained.value) : undefined,
        error: explained.ok ? undefined : explained.error.message,
      });
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

/** debug 输出只展示工具输入摘要，不直接打印完整链上对象。 */
function summarizeToolInput(tool: string, input: unknown): unknown {
  if (tool === "decode_transaction" && isChainTransactionLike(input)) {
    return {
      txHash: input.hash,
      chainId: input.chainId,
      transferCount: input.tokenTransfers.length,
    };
  }

  return input;
}

/** debug 输出只展示工具结果摘要，避免控制台被完整 receipt/logs 刷屏。 */
function summarizeToolOutput(tool: string, output: unknown): unknown {
  if (tool === "decode_transaction" && isRecord(output)) {
    return {
      hash: output.hash,
      method: output.method,
      tokenTransferCount: output.tokenTransferCount,
    };
  }

  if (tool === "fourmeme_explain_token_tx" && isRecord(output)) {
    return {
      txHash: output.txHash,
      primaryAction: output.primaryAction,
      movementCount: Array.isArray(output.movements) ? output.movements.length : undefined,
    };
  }

  return output;
}

/** 收窄 ChainTransaction 摘要需要的字段。 */
function isChainTransactionLike(value: unknown): value is ChainTransaction {
  return isRecord(value) && typeof value.hash === "string" && Array.isArray(value.tokenTransfers);
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
    parsed.intent === "skill" || parsed.intent === "general_chat" || parsed.intent === "unsupported"
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

/** 根据 LLM route 和本地候选决定最终 skill，兜底只使用本地最高分候选。 */
function selectSkillFromRoutePlan(
  plan: AgentPlan,
  candidates: SkillCandidate[],
  skills: SkillManifest[],
): SkillManifest | undefined {
  if (plan.intent !== "skill") {
    return undefined;
  }

  if (plan.skillId) {
    return skills.find((skill) => skill.id === plan.skillId);
  }

  const topCandidate = candidates[0];
  if (!topCandidate || topCandidate.score <= 0) {
    return undefined;
  }

  return topCandidate.skill;
}

/** skill candidate 的 debug/data 摘要，避免把完整 SKILL.md body 塞进返回数据。 */
function summarizeSkillCandidate(candidate: SkillCandidate): unknown {
  return {
    skillId: candidate.skill.id,
    skillName: candidate.skill.name,
    score: candidate.score,
    reasons: candidate.reasons,
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

Your job is to understand the user's natural-language request, choose from the candidate skills, and produce a concise routing plan.

Security policy:
- Never claim a chain fact unless it comes from a typed tool result.
- Never request a wallet signature unless the user explicitly asks to build or sign a transaction.
- Never broadcast a transaction.
- Skills are playbooks, not execution power. Tools produce facts and actions.
- This routing step should not decide tool details. The selected skill runtime will read the full SKILL.md and plan tools.
- Prefer the most specific candidate skill when the user explicitly names a protocol. Use generic EVM skills when the user only provides a transaction hash.

Return only JSON with this exact shape:
{
  "intent": "skill" | "general_chat" | "unsupported",
  "skillId": "candidate skill id or null",
  "userFacingPlan": "short routing reason",
  "missingInputs": ["input name"]
}`;
}

/** 把用户 prompt、session 和可用 skill 压成稳定 JSON，降低 prompt 漂移。 */
function buildPlannerUserPrompt(input: {
  prompt: string;
  session: SessionState;
  inputContext: AgentInputContext;
  candidates: SkillCandidate[];
  hasTransaction: boolean;
  hasTxPath: boolean;
}): string {
  const candidateSkills = input.candidates.map((candidate) => ({
    id: candidate.skill.id,
    name: candidate.skill.name,
    description: candidate.skill.description,
    domains: candidate.skill.domains,
    protocols: candidate.skill.protocols,
    chains: candidate.skill.chains,
    actions: candidate.skill.actions,
    inputs: candidate.skill.inputs,
    tools: candidate.skill.tools,
    safety: candidate.skill.safety,
    match: {
      score: candidate.score,
      reasons: candidate.reasons,
    },
  }));

  return JSON.stringify(
    {
      userPrompt: input.prompt,
      session: {
        walletAddress: input.session.walletAddress,
        chainId: input.session.chainId,
        riskPosture: input.session.riskPosture,
      },
      extractedInputContext: {
        chainId: input.inputContext.chainId,
        transactionHash: input.inputContext.transactionHash,
        transactionFilePath: input.inputContext.transactionFilePath,
        hasNormalizedTransaction: input.inputContext.hasNormalizedTransaction,
        tokenAddress: input.inputContext.tokenAddress,
        addressCount: input.inputContext.addresses.length,
        protocolHints: input.inputContext.protocolHints,
        actionHints: input.inputContext.actionHints,
        inputTypes: input.inputContext.inputTypes,
      },
      candidateSkills,
      availableInputs: {
        normalizedTransaction: input.hasTransaction,
        normalizedTransactionFile: input.hasTxPath,
        transactionHash: input.inputContext.transactionHash !== undefined,
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
