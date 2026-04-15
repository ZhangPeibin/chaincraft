import assert from "node:assert/strict";
import test from "node:test";
import { maskProxyUrl, normalizeProxyUrl, resolveProxyConfig } from "../src/core/proxy.ts";

// Clash Verge 常见端口可以直接写 host:port，loader 会自动补 http://。
test("normalizes proxy urls for Clash Verge style values", () => {
  assert.equal(normalizeProxyUrl("127.0.0.1:7890"), "http://127.0.0.1:7890/");
  assert.equal(normalizeProxyUrl("http://127.0.0.1:7897"), "http://127.0.0.1:7897/");
});

// Chaincraft 专用代理变量优先于通用 HTTPS_PROXY，避免系统环境影响项目配置。
test("resolves Chaincraft proxy env before generic proxy env", () => {
  const resolved = resolveProxyConfig({
    env: {
      CHAINCRAFT_PROXY_URL: "127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:9999",
    },
  });

  assert.equal(resolved?.source, "CHAINCRAFT_PROXY_URL");
  assert.equal(resolved?.url, "http://127.0.0.1:7890/");
});

// 代理 URL 可能包含认证信息，展示时必须遮蔽密码。
test("masks proxy credentials for display", () => {
  assert.equal(maskProxyUrl("http://user:password@127.0.0.1:7890"), "http://***:***@127.0.0.1:7890/");
});
