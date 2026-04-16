import assert from "node:assert/strict";
import test from "node:test";
import { parseSkill } from "../src/core/skill-loader.ts";

// SKILL.md frontmatter 现在是运行时 contract，需要解析 tools 和 safety。
test("parses skill tools and safety policy from frontmatter", () => {
  const skill = parseSkill(
    "fourmeme",
    "/tmp/fourmeme",
    `---
name: FourMeme Token Investigation
description: Investigate token transactions.
domains:
  - defi
protocols:
  - fourmeme
chains:
  - bsc-mainnet
actions:
  - explain_transaction
triggers:
  - fourmeme
inputs:
  - transactionHash
tools:
  - decode_transaction
  - fourmeme_explain_token_tx
safety:
  autoSign: false
  autoBroadcast: false
---

# Body
`,
  );

  assert.equal(skill.name, "FourMeme Token Investigation");
  assert.deepEqual(skill.domains, ["defi"]);
  assert.deepEqual(skill.protocols, ["fourmeme"]);
  assert.deepEqual(skill.chains, ["bsc-mainnet"]);
  assert.deepEqual(skill.actions, ["explain_transaction"]);
  assert.deepEqual(skill.triggers, ["fourmeme"]);
  assert.deepEqual(skill.inputs, ["transactionHash"]);
  assert.deepEqual(skill.tools, ["decode_transaction", "fourmeme_explain_token_tx"]);
  assert.deepEqual(skill.safety, {
    autoSign: false,
    autoBroadcast: false,
  });
});
