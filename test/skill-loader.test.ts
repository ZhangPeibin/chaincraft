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
  assert.deepEqual(skill.tools, ["decode_transaction", "fourmeme_explain_token_tx"]);
  assert.deepEqual(skill.safety, {
    autoSign: false,
    autoBroadcast: false,
  });
});
