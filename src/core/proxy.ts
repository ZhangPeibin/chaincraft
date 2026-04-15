import { ProxyAgent, setGlobalDispatcher } from "undici";

/** 代理配置来源，按优先级从上到下选择。 */
const PROXY_ENV_KEYS = [
  "CHAINCRAFT_PROXY_URL",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

/** 配置全局 fetch 代理时允许传入的选项。 */
export interface ConfigureProxyOptions {
  /** 显式代理地址；优先级高于环境变量，主要给测试或未来 CLI 参数使用。 */
  proxyUrl?: string;
  /** 环境变量来源，生产默认 process.env，测试可传自定义对象。 */
  env?: NodeJS.ProcessEnv;
}

/** 解析出来的代理配置。 */
export interface ResolvedProxyConfig {
  /** 代理地址来源，例如 CHAINCRAFT_PROXY_URL。 */
  source: string;
  /** 标准化后的真实代理 URL，会传给 ProxyAgent。 */
  url: string;
  /** 遮蔽密码后的展示 URL，避免日志泄露代理认证信息。 */
  displayUrl: string;
}

/** 配置代理后的结果。 */
export type ConfigureProxyResult =
  | {
      /** 找到了代理并完成全局 fetch 配置。 */
      enabled: true;
      /** 代理地址来源。 */
      source: string;
      /** 遮蔽后的代理地址。 */
      displayUrl: string;
    }
  | {
      /** 没找到代理配置，因此保持 Node fetch 默认行为。 */
      enabled: false;
    };

/** 根据显式参数或环境变量，为 Node fetch 配置全局 HTTP(S) 代理。 */
export function configureProxyFromEnv(options: ConfigureProxyOptions = {}): ConfigureProxyResult {
  const resolved = resolveProxyConfig(options);
  if (!resolved) {
    return { enabled: false };
  }

  // Node 内置 fetch 使用 undici；设置全局 dispatcher 后，后续 fetch 会走该代理。
  setGlobalDispatcher(new ProxyAgent(resolved.url));

  return {
    enabled: true,
    source: resolved.source,
    displayUrl: resolved.displayUrl,
  };
}

/** 从环境变量中解析代理配置，不产生副作用，方便测试。 */
export function resolveProxyConfig(options: ConfigureProxyOptions = {}): ResolvedProxyConfig | undefined {
  if (options.proxyUrl?.trim()) {
    const url = normalizeProxyUrl(options.proxyUrl);
    return {
      source: "explicit",
      url,
      displayUrl: maskProxyUrl(url),
    };
  }

  const env = options.env ?? process.env;
  for (const key of PROXY_ENV_KEYS) {
    const rawValue = env[key];
    if (!rawValue?.trim()) {
      continue;
    }

    const url = normalizeProxyUrl(rawValue);
    return {
      source: key,
      url,
      displayUrl: maskProxyUrl(url),
    };
  }

  return undefined;
}

/** 标准化代理 URL；Clash 常见写法 127.0.0.1:7890 会自动补 http://。 */
export function normalizeProxyUrl(rawValue: string): string {
  const trimmed = rawValue.trim();
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withProtocol);

  if (url.protocol === "socks:" || url.protocol === "socks4:" || url.protocol === "socks5:") {
    throw new Error(
      "SOCKS proxy URLs are not supported by Chaincraft's Node fetch proxy yet. Use Clash Verge's HTTP or mixed port, for example CHAINCRAFT_PROXY_URL=http://127.0.0.1:7890.",
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported proxy protocol: ${url.protocol}. Use an http:// or https:// proxy URL.`);
  }

  if (!url.hostname || !url.port) {
    throw new Error("Proxy URL must include host and port, for example http://127.0.0.1:7890.");
  }

  return url.toString();
}

/** 遮蔽代理 URL 中的用户名密码，避免未来 debug 输出泄露敏感信息。 */
export function maskProxyUrl(proxyUrl: string): string {
  const url = new URL(proxyUrl);
  if (url.username) {
    url.username = "***";
  }
  if (url.password) {
    url.password = "***";
  }

  return url.toString();
}
