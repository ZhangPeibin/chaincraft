import type { AgentInputContext, SkillCandidate, SkillManifest } from "./types.ts";

/** 候选匹配参数；maxCandidates 控制送给 LLM router 的 skill 数量。 */
export interface BuildSkillCandidatesOptions {
  /** 最多返回多少个候选 skill。 */
  maxCandidates?: number;
}

/** 根据通用输入上下文生成 skill 候选清单；这里只做排序，不直接产出链上事实。 */
export function buildSkillCandidates(
  skills: SkillManifest[],
  context: AgentInputContext,
  options: BuildSkillCandidatesOptions = {},
): SkillCandidate[] {
  const maxCandidates = options.maxCandidates ?? 5;
  const prompt = context.prompt.toLowerCase();
  const candidates = skills
    .map((skill) => scoreSkill(skill, context, prompt))
    .filter((candidate) => candidate.score > 0)
    .sort(compareSkillCandidates);

  // 如果没有任何 metadata 命中，仍保留少量 skill 给 LLM 判断，但分数为 0 时不会被本地兜底选中。
  const fallback =
    candidates.length > 0
      ? candidates
      : skills
          .map((skill) => ({ skill, score: 0, reasons: ["fallback:available"] }))
          .sort(compareSkillCandidates);

  return fallback.slice(0, maxCandidates);
}

/** 本地候选分数只用于缩小路由空间，最终是否选择仍由 Agent router 决定。 */
function scoreSkill(skill: SkillManifest, context: AgentInputContext, prompt: string): SkillCandidate {
  const reasons: string[] = [];
  let score = 0;

  for (const protocol of context.protocolHints) {
    if (matchesStringSet(skill.protocols, protocol)) {
      score += 8;
      reasons.push(`protocol:${protocol}`);
    }
  }

  for (const action of context.actionHints) {
    if (matchesStringSet(skill.actions, action)) {
      score += 5;
      reasons.push(`action:${action}`);
    }
  }

  for (const inputType of context.inputTypes) {
    if (matchesStringSet(skill.inputs, inputType)) {
      score += 3;
      reasons.push(`input:${inputType}`);
    }
  }

  if (skill.chains.length === 0 || skill.chains.includes(context.chainId)) {
    score += 1;
    reasons.push(`chain:${context.chainId}`);
  }

  for (const trigger of skill.triggers) {
    const normalizedTrigger = trigger.toLowerCase();
    if (normalizedTrigger && prompt.includes(normalizedTrigger)) {
      score += 2;
      reasons.push(`trigger:${trigger}`);
    }
  }

  return { skill, score, reasons };
}

/** 稳定排序：分数高优先，分数相同按 skill id，避免 prompt 顺序漂移。 */
function compareSkillCandidates(left: SkillCandidate, right: SkillCandidate): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }

  return left.skill.id.localeCompare(right.skill.id);
}

/** 小写集合匹配，frontmatter 允许大小写但 runtime 内部统一按小写比较。 */
function matchesStringSet(values: string[], expected: string): boolean {
  const normalizedExpected = expected.toLowerCase();
  return values.some((value) => value.toLowerCase() === normalizedExpected);
}
