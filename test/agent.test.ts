import assert from "node:assert/strict";
import test from "node:test";
import { createChaincraftAgent, extractTransactionHashFromPrompt, parseAgentPlan } from "../src/agent.ts";
import { createSession } from "../src/core/session.ts";
import { ToolRegistry } from "../src/core/tools.ts";
import type { ChainTransaction, DecodedTransaction, FourMemeTokenTxExplanation, LlmClient } from "../src/core/types.ts";
import type { EvmRpcReceipt, EvmRpcTransaction } from "../src/tools/evm-rpc.ts";

// 模型经常会把 JSON 包在 markdown code block 里，这里确保 parser 能兼容。
test("parses fenced model planning JSON", () => {
  const plan = parseAgentPlan(`\`\`\`json
{"intent":"skill","skillId":"fourmeme","userFacingPlan":"I will inspect the transaction.","missingInputs":[]}
\`\`\``);

  assert.equal(plan.intent, "skill");
  assert.equal(plan.skillId, "fourmeme");
  assert.deepEqual(plan.missingInputs, []);
});

// 真实用户会把 hash 写在一句话里，Agent 需要自己识别，而不是要求 --tx-hash。
test("extracts transaction hash from natural language prompt", () => {
  const txHash = "0xaf68c69ff4f160e126e70934792dd1b4370db6f6e1a9fefcf4be9fd29b58937a";

  assert.equal(extractTransactionHashFromPrompt(`帮我看下这个 tx ${txHash} 是啥意思`), txHash);
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

// debug 模式应该能看到 LLM、skill 和 tool 的调用链，而不是只看到最终回答。
test("ask emits debug call chain events when debug logger is enabled", async () => {
  const debugEvents: Array<{ event: string; fields?: Record<string, unknown> }> = [];
  const debug = {
    enabled: true,
    log(event: string, fields?: Record<string, unknown>) {
      debugEvents.push({ event, fields });
    },
  };
  let callIndex = 0;
  const llm: LlmClient = {
    async generate() {
      callIndex += 1;

      if (callIndex === 1) {
        return {
          provider: "openai",
          model: "debug-route-model",
          text: JSON.stringify({
            intent: "skill",
            skillId: "fourmeme",
            userFacingPlan: "Route to FourMeme skill.",
            missingInputs: [],
          }),
          raw: { id: "route-response" },
        };
      }

      if (callIndex === 2) {
        return {
          provider: "openai",
          model: "debug-skill-plan-model",
          text: JSON.stringify({
            summary: "Decode and explain.",
            toolCalls: [
              {
                tool: "decode_transaction",
                reason: "Decode facts.",
              },
              {
                tool: "fourmeme_explain_token_tx",
                reason: "Explain movement.",
              },
            ],
            missingInputs: [],
            responseRubric: ["Use typed facts only."],
          }),
          raw: { id: "skill-plan-response" },
        };
      }

      return {
        provider: "openai",
        model: "debug-answer-model",
        text: "Debug answer.",
        raw: { id: "answer-response" },
      };
    },
  };
  const transaction: ChainTransaction = {
    chainId: "bsc-mainnet",
    hash: "0xdebug",
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
  const agent = createChaincraftAgent({ llm, debug });

  await agent.ask({
    session: createSession({ walletAddress: "0xWallet" }),
    prompt: "Explain this transaction.",
    transaction,
  });

  const eventNames = debugEvents.map((event) => event.event);
  assert.ok(eventNames.includes("llm.route.done"));
  assert.ok(eventNames.includes("agent.skill_select.done"));
  assert.ok(eventNames.includes("llm.skill_plan.done"));
  assert.ok(eventNames.includes("llm.skill_answer.done"));
  assert.equal(
    debugEvents.find((event) => event.event === "llm.route.done")?.fields?.model,
    "debug-route-model",
  );
  assert.deepEqual(
    debugEvents
      .filter((event) => event.event.startsWith("tool.") && event.event.endsWith(".start"))
      .map((event) => event.fields?.tool),
    ["decode_transaction", "fourmeme_explain_token_tx"],
  );
  assert.deepEqual(
    debugEvents
      .filter((event) => event.event.startsWith("tool.") && event.event.endsWith(".done"))
      .map((event) => event.fields?.tool),
    ["decode_transaction", "fourmeme_explain_token_tx"],
  );
});

// 当用户只提供 txHash 时，ask 不应由 CLI 预先读取链上数据；skill runtime 应按计划调用 RPC tools。
test("ask lets skill runtime fetch and normalize transaction from tx hash", async () => {
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
            userFacingPlan: "Route to FourMeme skill.",
            missingInputs: [],
          }),
          raw: { id: "route-response" },
        };
      }

      if (callIndex === 2) {
        assert.match(request.user, /"transactionHash": true/);
        return {
          provider: "openai",
          model: "test-model",
          text: JSON.stringify({
            summary: "Use RPC tools, normalize the transaction, then explain token movement.",
            toolCalls: [
              {
                tool: "decode_transaction",
                reason: "Decode normalized transaction facts.",
              },
              {
                tool: "fourmeme_explain_token_tx",
                reason: "Classify focused wallet movement.",
              },
            ],
            missingInputs: [],
            responseRubric: ["Use typed facts only."],
          }),
          raw: { id: "skill-plan-response" },
        };
      }

      assert.match(request.user, /rpc_get_transaction/);
      assert.match(request.user, /normalize_evm_transaction/);
      return {
        provider: "openai",
        model: "test-model",
        text: "The runtime fetched the transaction by hash and classified it as transfer in.",
        raw: { id: "skill-answer-response" },
      };
    },
  };
  const tools = createFakeRuntimeTools();
  const agent = createChaincraftAgent({ llm, tools });
  const reply = await agent.ask({
    session: createSession({ walletAddress: "0xWallet" }),
    prompt: "Explain this transaction hash.",
    txHash: "0xtest",
  });

  assert.match(reply.text, /runtime fetched/);
  assert.deepEqual(reply.toolCalls, [
    "llm:openai:route",
    "llm:openai:skill_plan",
    "rpc_get_transaction",
    "rpc_get_transaction_receipt",
    "normalize_evm_transaction",
    "decode_transaction",
    "fourmeme_explain_token_tx",
    "llm:openai:skill_answer",
  ]);
});

// 用户只发自然语言和 tx hash 时，Agent 应先抽取 hash，再让 skill runtime 调 RPC tools。
test("ask extracts tx hash from prompt before skill runtime execution", async () => {
  const txHash = "0xaf68c69ff4f160e126e70934792dd1b4370db6f6e1a9fefcf4be9fd29b58937a";
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
            userFacingPlan: "Route to FourMeme skill.",
            missingInputs: [],
          }),
          raw: { id: "route-response" },
        };
      }

      if (callIndex === 2) {
        assert.match(request.user, /"transactionHash": true/);
        return {
          provider: "openai",
          model: "test-model",
          text: JSON.stringify({
            summary: "Fetch the transaction from the hash in the user's prompt, then explain it.",
            toolCalls: [
              {
                tool: "decode_transaction",
                reason: "Decode normalized transaction facts.",
              },
              {
                tool: "fourmeme_explain_token_tx",
                reason: "Classify focused wallet movement.",
              },
            ],
            missingInputs: [],
            responseRubric: ["Use typed facts only."],
          }),
          raw: { id: "skill-plan-response" },
        };
      }

      assert.match(request.user, /rpc_get_transaction/);
      return {
        provider: "openai",
        model: "test-model",
        text: "The Agent extracted the tx hash from the prompt and analyzed it.",
        raw: { id: "skill-answer-response" },
      };
    },
  };
  const tools = createFakeRuntimeTools({ expectedTxHash: txHash });
  const agent = createChaincraftAgent({ llm, tools });
  const reply = await agent.ask({
    session: createSession({ walletAddress: "0xWallet" }),
    prompt: `帮我看下这个 tx ${txHash} 是啥意思`,
  });

  assert.match(reply.text, /extracted the tx hash/);
  assert.deepEqual(reply.toolCalls, [
    "llm:openai:route",
    "llm:openai:skill_plan",
    "rpc_get_transaction",
    "rpc_get_transaction_receipt",
    "normalize_evm_transaction",
    "decode_transaction",
    "fourmeme_explain_token_tx",
    "llm:openai:skill_answer",
  ]);
});

// 当用户只提供 txPath 时，ask 入口只传路径；skill runtime 应通过 typed file tool 读取归一化交易。
test("ask lets skill runtime read normalized transaction file from tx path", async () => {
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
            userFacingPlan: "Route to FourMeme skill.",
            missingInputs: [],
          }),
          raw: { id: "route-response" },
        };
      }

      if (callIndex === 2) {
        assert.match(request.user, /"normalizedTransactionFile": true/);
        return {
          provider: "openai",
          model: "test-model",
          text: JSON.stringify({
            summary: "Read the provided normalized transaction file, then explain token movement.",
            toolCalls: [
              {
                tool: "decode_transaction",
                reason: "Decode normalized transaction facts.",
              },
              {
                tool: "fourmeme_explain_token_tx",
                reason: "Classify focused wallet movement.",
              },
            ],
            missingInputs: [],
            responseRubric: ["Use typed facts only."],
          }),
          raw: { id: "skill-plan-response" },
        };
      }

      assert.match(request.user, /read_normalized_transaction_file/);
      assert.match(request.user, /decode_transaction/);
      return {
        provider: "openai",
        model: "test-model",
        text: "The runtime read the normalized transaction file and classified it as transfer in.",
        raw: { id: "skill-answer-response" },
      };
    },
  };
  const tools = createFakeRuntimeTools({ expectedTxPath: "fixtures/fourmeme-transfer.json" });
  const agent = createChaincraftAgent({ llm, tools });
  const reply = await agent.ask({
    session: createSession({ walletAddress: "0xWallet" }),
    prompt: "Explain this transaction file.",
    txPath: "fixtures/fourmeme-transfer.json",
  });

  assert.match(reply.text, /normalized transaction file/);
  assert.deepEqual(reply.toolCalls, [
    "llm:openai:route",
    "llm:openai:skill_plan",
    "read_normalized_transaction_file",
    "decode_transaction",
    "fourmeme_explain_token_tx",
    "llm:openai:skill_answer",
  ]);
});

/** 构造 fake tools，避免测试访问真实 RPC。 */
function createFakeRuntimeTools(input: { expectedTxPath?: string; expectedTxHash?: string } = {}): ToolRegistry {
  const tools = new ToolRegistry();
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
        from: "0xPair",
        to: "0xWallet",
        amount: "42",
      },
    ],
  };

  tools.register<{ txPath: string }, ChainTransaction>({
    name: "read_normalized_transaction_file",
    description: "fake normalized transaction file reader",
    async execute(toolInput) {
      if (input.expectedTxPath !== undefined) {
        assert.equal(toolInput.txPath, input.expectedTxPath);
      }

      return {
        ok: true,
        value: transaction,
      };
    },
  });
  tools.register<{ txHash: string }, EvmRpcTransaction>({
    name: "rpc_get_transaction",
    description: "fake transaction fetch",
    async execute(toolInput) {
      if (input.expectedTxHash !== undefined) {
        assert.equal(toolInput.txHash, input.expectedTxHash);
      }

      return {
        ok: true,
        value: {
          hash: "0xtest",
          from: "0xWallet",
          to: "0xRouter",
          value: "0x0",
          input: "0x",
        },
      };
    },
  });
  tools.register<{ txHash: string }, EvmRpcReceipt>({
    name: "rpc_get_transaction_receipt",
    description: "fake receipt fetch",
    async execute(toolInput) {
      if (input.expectedTxHash !== undefined) {
        assert.equal(toolInput.txHash, input.expectedTxHash);
      }

      return {
        ok: true,
        value: {
          transactionHash: "0xtest",
          logs: [],
        },
      };
    },
  });
  tools.register<unknown, ChainTransaction>({
    name: "normalize_evm_transaction",
    description: "fake normalizer",
    async execute() {
      return {
        ok: true,
        value: transaction,
      };
    },
  });
  tools.register<ChainTransaction, DecodedTransaction>({
    name: "decode_transaction",
    description: "fake decoder",
    async execute(input) {
      return {
        ok: true,
        value: {
          hash: input.hash,
          actor: input.from,
          target: input.to,
          method: "contract_call",
          tokenTransferCount: input.tokenTransfers.length,
          nativeValueWei: "0",
          tokenTransfers: input.tokenTransfers,
        },
      };
    },
  });
  tools.register<unknown, FourMemeTokenTxExplanation>({
    name: "fourmeme_explain_token_tx",
    description: "fake fourmeme explanation",
    async execute() {
      return {
        ok: true,
        value: {
          protocol: "fourmeme",
          txHash: "0xtest",
          chainId: "bsc-mainnet",
          walletAddress: "0xWallet",
          primaryAction: "transfer_in",
          summary: "transfer in",
          movements: [
            {
              tokenAddress: "0xToken",
              tokenSymbol: "MEME",
              amount: "42",
              direction: "in",
              from: "0xPair",
              to: "0xWallet",
            },
          ],
          observations: ["fake observation"],
          riskNotes: ["fake risk"],
          nextQuestions: ["fake next question"],
        },
      };
    },
  });

  return tools;
}
