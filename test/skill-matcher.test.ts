import assert from "node:assert/strict";
import test from "node:test";
import { extractInputContext } from "../src/core/input-extractor.ts";
import { loadSkills } from "../src/core/skill-loader.ts";
import { buildSkillCandidates } from "../src/core/skill-matcher.ts";
import { createSession } from "../src/core/session.ts";

// 只有 tx hash、没有协议名时，应该优先匹配通用 EVM transaction skill。
test("prefers generic EVM skill for a bare transaction hash", async () => {
  const txHash = "0xaf68c69ff4f160e126e70934792dd1b4370db6f6e1a9fefcf4be9fd29b58937a";
  const skills = await loadSkills("skills");
  const context = extractInputContext({
    session: createSession(),
    prompt: `帮我看下这个 tx ${txHash} 是啥意思`,
  });
  const candidates = buildSkillCandidates(skills, context);

  assert.equal(candidates[0]?.skill.id, "evm-transaction");
});

// 用户明确说 FourMeme 时，协议专用 skill 应该排在通用 EVM skill 前面。
test("prefers FourMeme skill when protocol is explicit", async () => {
  const skills = await loadSkills("skills");
  const context = extractInputContext({
    session: createSession(),
    prompt: "Explain this FourMeme token transaction. Did the wallet sell?",
  });
  const candidates = buildSkillCandidates(skills, context);

  assert.equal(candidates[0]?.skill.id, "fourmeme");
  assert.ok(candidates[0]?.reasons.includes("protocol:fourmeme"));
});
