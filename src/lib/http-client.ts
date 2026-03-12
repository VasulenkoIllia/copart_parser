import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import env from "../config/env";
import { logger } from "./logger";

interface RetryOptions {
  retries: number;
  retryDelayMs: number;
}

interface ProxyConfig {
  protocol: "http" | "https";
  host: string;
  port: number;
  auth?: {
    username: string;
    password: string;
  };
}

interface ProxyProbeResult {
  proxy: ProxyConfig;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error: string | null;
}

let proxyIndex = 0;
let parsedProxiesCache: ProxyConfig[] | null = null;
let activeProxiesCache: ProxyConfig[] | null = null;
let preflightCompleted = false;
let preflightPromise: Promise<void> | null = null;

function sanitizeRequestUrl(url: string | undefined): string {
  if (!url) {
    return "unknown";
  }
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseProxyUrl(value: string): ProxyConfig {
  const raw = value.trim();
  if (!raw) {
    throw new Error("Empty proxy value");
  }

  let normalized = raw;
  if (!raw.includes("://")) {
    const parts = raw.split(":");

    // host:port:user:pass
    if (parts.length === 4 && /^\d+$/.test(parts[1])) {
      const [host, port, username, password] = parts;
      normalized = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    } else if (/^[^:\s]+:\d+$/.test(raw) || raw.includes("@")) {
      // host:port  OR user:pass@host:port
      normalized = `http://${raw}`;
    } else {
      throw new Error(`Unsupported proxy format: ${raw}`);
    }
  }

  const url = new URL(normalized);
  const protocol = url.protocol.replace(":", "");
  if (protocol !== "http" && protocol !== "https") {
    throw new Error(`Unsupported proxy protocol: ${value}`);
  }
  const port = url.port ? Number.parseInt(url.port, 10) : protocol === "https" ? 443 : 80;
  if (!Number.isFinite(port)) {
    throw new Error(`Invalid proxy port: ${value}`);
  }

  const auth =
    url.username || url.password
      ? {
          username: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        }
      : undefined;

  return {
    protocol,
    host: url.hostname,
    port,
    auth,
  };
}

function getParsedProxyList(): ProxyConfig[] {
  if (parsedProxiesCache) {
    return parsedProxiesCache;
  }

  const valid: ProxyConfig[] = [];
  const invalid: Array<{ index: number; value: string; error: string }> = [];

  for (let index = 0; index < env.proxy.list.length; index += 1) {
    const value = env.proxy.list[index];
    try {
      valid.push(parseProxyUrl(value));
    } catch (error) {
      invalid.push({
        index: index + 1,
        value,
        error: sanitizeError(error),
      });
    }
  }

  if (invalid.length > 0) {
    logger.warn("Invalid proxies skipped", {
      invalidCount: invalid.length,
      configuredCount: env.proxy.list.length,
      sample: invalid.slice(0, 5),
    });
  }

  parsedProxiesCache = valid;
  return parsedProxiesCache;
}

function proxyLabel(proxy: ProxyConfig): string {
  const authPrefix = proxy.auth?.username ? `${proxy.auth.username}:***@` : "";
  return `${proxy.protocol}://${authPrefix}${proxy.host}:${proxy.port}`;
}

function isHealthyProxyStatus(status: number): boolean {
  return status >= 200 && status < 400;
}

function sanitizeError(error: unknown): string {
  if (!error) {
    return "unknown_error";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let index = 0;

  const runners = Array.from({ length: safeConcurrency }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) {
        return;
      }
      results[current] = await worker(items[current]);
    }
  });

  await Promise.all(runners);
  return results;
}

async function probeProxy(proxy: ProxyConfig): Promise<ProxyProbeResult> {
  const startedAt = Date.now();
  let status: number | null = null;
  let error: string | null = null;

  try {
    const headResponse = await axios.request({
      method: "HEAD",
      url: env.proxy.healthcheckUrl,
      timeout: env.proxy.preflightTimeoutMs,
      maxRedirects: 3,
      proxy,
      validateStatus: () => true,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      },
    });

    status = headResponse.status;
    if (status === 405) {
      const getResponse = await axios.request({
        method: "GET",
        url: env.proxy.healthcheckUrl,
        timeout: env.proxy.preflightTimeoutMs,
        maxRedirects: 3,
        responseType: "stream",
        proxy,
        validateStatus: () => true,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        },
      });
      status = getResponse.status;
      if (
        getResponse.data &&
        typeof getResponse.data === "object" &&
        "destroy" in getResponse.data &&
        typeof getResponse.data.destroy === "function"
      ) {
        getResponse.data.destroy();
      }
    }
  } catch (probeError) {
    error = sanitizeError(probeError);
  }

  const latencyMs = Date.now() - startedAt;
  const ok = error === null && status !== null && isHealthyProxyStatus(status);

  return {
    proxy,
    ok,
    status,
    latencyMs,
    error,
  };
}

async function runProxyPreflight(reason: string): Promise<void> {
  const configured = getParsedProxyList();

  if (configured.length === 0) {
    activeProxiesCache = [];
    preflightCompleted = true;
    if (env.proxy.mode === "proxy") {
      throw new Error("HTTP_MODE=proxy but proxy list is empty (PROXY_LIST/PROXY_LIST_FILE)");
    }
    return;
  }

  const results = await mapWithConcurrency(
    configured,
    env.proxy.preflightConcurrency,
    async proxy => probeProxy(proxy)
  );
  const healthy = results.filter(result => result.ok).sort((a, b) => a.latencyMs - b.latencyMs);
  const topN = Math.min(env.proxy.preflightTopN, healthy.length);
  const selected = healthy.slice(0, topN);

  if (healthy.length < env.proxy.preflightMinWorking) {
    logger.warn("Proxy preflight found fewer working proxies than expected", {
      reason,
      configured: configured.length,
      healthy: healthy.length,
      minWorking: env.proxy.preflightMinWorking,
      strict: env.proxy.preflightStrict,
    });
    if (env.proxy.preflightStrict) {
      throw new Error(
        `Proxy preflight failed: healthy=${healthy.length}, min=${env.proxy.preflightMinWorking}`
      );
    }
  }

  activeProxiesCache = selected.map(item => item.proxy);
  preflightCompleted = true;

  logger.info("Proxy preflight completed", {
    reason,
    mode: env.proxy.mode,
    configured: configured.length,
    healthy: healthy.length,
    selected: activeProxiesCache.length,
    topN: env.proxy.preflightTopN,
    timeoutMs: env.proxy.preflightTimeoutMs,
    concurrency: env.proxy.preflightConcurrency,
    sampleSelected: activeProxiesCache.slice(0, 3).map(proxyLabel),
  });

  if (env.proxy.mode === "proxy" && activeProxiesCache.length === 0) {
    throw new Error("Proxy preflight failed: no working proxies selected");
  }
}

export async function prepareProxyPool(reason = "runtime", force = false): Promise<void> {
  if (force) {
    preflightCompleted = false;
    preflightPromise = null;
    parsedProxiesCache = null;
    activeProxiesCache = null;
    proxyIndex = 0;
  }

  if (env.proxy.mode === "direct") {
    preflightCompleted = true;
    activeProxiesCache = [];
    return;
  }

  const configured = getParsedProxyList();
  if (configured.length === 0) {
    if (env.proxy.mode === "proxy") {
      throw new Error("HTTP_MODE=proxy but proxy list is empty (PROXY_LIST/PROXY_LIST_FILE)");
    }
    preflightCompleted = true;
    activeProxiesCache = [];
    return;
  }

  if (!env.proxy.preflightEnabled) {
    activeProxiesCache = configured.slice(0, Math.min(env.proxy.preflightTopN, configured.length));
    preflightCompleted = true;
    logger.info("Proxy preflight disabled, selected proxies without checks", {
      reason,
      mode: env.proxy.mode,
      configured: configured.length,
      selected: activeProxiesCache.length,
      topN: env.proxy.preflightTopN,
      sampleSelected: activeProxiesCache.slice(0, 3).map(proxyLabel),
    });
    return;
  }

  if (preflightCompleted) {
    return;
  }

  if (!preflightPromise) {
    preflightPromise = runProxyPreflight(reason).finally(() => {
      preflightPromise = null;
    });
  }

  await preflightPromise;
}

export function getProxyPoolSnapshot(): {
  mode: string;
  configured: number;
  selected: number;
  preflightEnabled: boolean;
  preflightCompleted: boolean;
} {
  const configured = getParsedProxyList().length;
  const selected = activeProxiesCache ? activeProxiesCache.length : 0;

  return {
    mode: env.proxy.mode,
    configured,
    selected,
    preflightEnabled: env.proxy.preflightEnabled,
    preflightCompleted,
  };
}

function getActiveProxyList(): ProxyConfig[] {
  if (activeProxiesCache && activeProxiesCache.length > 0) {
    return activeProxiesCache;
  }
  return getParsedProxyList();
}

function getProxyRouteOrder(): Array<ProxyConfig | null> {
  const parsed = getActiveProxyList();

  if (env.proxy.mode === "direct") {
    return [null];
  }

  if (parsed.length === 0) {
    if (env.proxy.mode === "proxy") {
      throw new Error("Proxy mode enabled but proxy pool is empty");
    }
    return [null];
  }

  const ordered: ProxyConfig[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const idx = (proxyIndex + i) % parsed.length;
    ordered.push(parsed[idx]);
  }
  proxyIndex = (proxyIndex + 1) % parsed.length;

  if (env.proxy.mode === "proxy") {
    return ordered;
  }

  if (env.proxy.mode === "mixed") {
    return [...ordered, null];
  }

  return [null];
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function httpRequest<T = unknown>(
  config: AxiosRequestConfig,
  options: RetryOptions
): Promise<AxiosResponse<T>> {
  const startedAt = Date.now();
  const method = (config.method ?? "GET").toString().toUpperCase();
  const requestUrl = sanitizeRequestUrl(config.url);

  if (env.proxy.mode !== "direct") {
    await prepareProxyPool("http_request");
  }

  const routes = getProxyRouteOrder();

  let lastError: unknown;
  let lastResponse: AxiosResponse<T> | null = null;

  for (let attempt = 1; attempt <= options.retries; attempt += 1) {
    for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
      const route = routes[routeIndex];
      const routeName = route ? proxyLabel(route) : "direct";
      const requestAttemptStartedAt = Date.now();

      try {
        const response = await axios.request<T>({
          ...config,
          proxy: route ? route : false,
          validateStatus: () => true,
        });
        const durationMs = Date.now() - requestAttemptStartedAt;

        if (isRetryableStatus(response.status)) {
          if (env.diagnostics.httpLogRetryAttempts) {
            logger.warn("HTTP retryable status", {
              method,
              requestUrl,
              route: routeName,
              attempt,
              routeIndex,
              status: response.status,
              durationMs,
            });
          }
          lastResponse = response;
          continue;
        }

        if (durationMs >= env.diagnostics.httpLogSlowRequestMs) {
          logger.info("HTTP slow request", {
            method,
            requestUrl,
            route: routeName,
            attempt,
            routeIndex,
            status: response.status,
            durationMs,
          });
        }

        return response;
      } catch (error) {
        const durationMs = Date.now() - requestAttemptStartedAt;
        if (env.diagnostics.httpLogRetryAttempts) {
          logger.warn("HTTP route error", {
            method,
            requestUrl,
            route: routeName,
            attempt,
            routeIndex,
            durationMs,
            error: sanitizeError(error),
          });
        }
        lastError = error;
      }
    }

    if (attempt < options.retries) {
      if (env.diagnostics.httpLogRetryAttempts) {
        logger.warn("HTTP retry backoff", {
          method,
          requestUrl,
          attempt,
          retries: options.retries,
          retryDelayMs: options.retryDelayMs * attempt,
        });
      }
      await sleep(options.retryDelayMs * attempt);
    }
  }

  if (lastResponse) {
    logger.warn("HTTP retries exhausted with response", {
      method,
      requestUrl,
      status: lastResponse.status,
      retries: options.retries,
      totalDurationMs: Date.now() - startedAt,
    });
    return lastResponse;
  }

  if (lastError instanceof Error) {
    logger.error("HTTP retries exhausted with error", {
      method,
      requestUrl,
      retries: options.retries,
      totalDurationMs: Date.now() - startedAt,
      error: lastError.message,
    });
    throw lastError;
  }

  throw new Error("HTTP request failed without response");
}
