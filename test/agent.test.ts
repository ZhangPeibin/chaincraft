import assert from "node:assert/strict";
import test from "node:test";
import { createChaincraftAgent, parseAgentPlan } from "../src/agent.ts";
import { createSession } from "../src/core/session.ts";
import type { ChainTransaction, LlmClient } from "../src/core/types.ts";

// 模型经常会把 JSON 包在 markdown code block 里，这里确保 parser 能兼容。
test("parses fenced model planning JSON", () => {
  const plan = parseAgentPlan(`\`\`\`json
{"intent":"fourmeme_tx_explain","skillId":"fourmeme","userFacingPlan":"I will inspect the transaction.","missingInputs":[]}
\`\`\``);

  assert.equal(plan.intent, "fourmeme_tx_explain");
  assert.equal(plan.skillId, "fourmeme");
  assert.deepEqual(plan.missingInputs, []);
});

// 用 mock LLM 验证 ask 入口确实先规划，再进入 FourMeme typed tools。
test("ask uses LLM planning before FourMeme tools", async () => {
  let callIndex = 0;
  const llm: LlmClient = {
    async generate(request) {
      callIndex += 1;

      if (callIndex === 1) {
        return {
          provider: "openai",
          model: "test-model",
          text: JSON.stringify({
            intent: "skill",
            skillId: "fourmeme",
            userFacingPlan: "I will route this request to the FourMeme skill.",
            missingInputs: [],
          }),
          raw: { id: "route-response" },
        };
      }

      if (callIndex === 2) {
        assert.match(request.user, /FourMeme Token Investigation/);
        assert.match(request.user, /Never call a transfer-out a sell/);
        return {
          provider: "openai",
          model: "test-model",
          text: JSON.stringify({
            summary: "Decode the transaction, then explain token movement from the focused wallet perspective.",
            toolCalls: [
              {
                tool: "decode_transaction",
                reason: "Read sender, target, method, and token transfer facts.",
              },
              {
                tool: "fourmeme_explain_token_tx",
                reason: "Classify the focused wallet movement.",
              },
            ],
            missingInputs: [],
            responseRubric: ["Separate facts from interpretation."],
          }),
          raw: { id: "skill-plan-response" },
        };
      }

      assert.equal(callIndex, 3);
      assert.match(request.user, /typedToolFacts/);
      assert.match(request.user, /transfer_out/);
      return {
        provider: "openai",
        model: "test-model",
        text: "The focused wallet transferred out 42 MEME. This is a transfer out, not a proven sell.",
        raw: { id: "skill-answer-response" },
      };
    },
  };
  // 这笔交易模拟关注钱包把 MEME 转出，用于验证解释结果。
  const transaction: ChainTransaction = {
    chainId: "bsc-mainnet",
    hash: "0xtest",
    from: "0xWallet",
    to: "0xRouter",
    tokenTransfers: [
      {
        tokenAddress: "0xToken",
        tokenSymbol: "MEME",
        tokenDecimals: 18,
        from: "0xWallet",
        to: "0xOther",
        amount: "42",
      },
    ],
  };

  const agent = createChaincraftAgent({ llm });
  const reply = await agent.ask({
    session: createSession({ walletAddress: "0xWallet" }),
    prompt: "Explain this FourMeme transaction.",
    transaction,
  });

  // 回复应该来自 skill answer writer，而工具事实仍由 typed tools 产生。
  assert.match(reply.text, /transferred out 42 MEME/);
  assert.deepEqual(reply.toolCalls, [
    "llm:openai:route",
    "llm:openai:skill_plan",
    "decode_transaction",
    "fourmeme_explain_token_tx",
    "llm:openai:skill_answer",
  ]);
  assert.equal(callIndex, 3);
});
