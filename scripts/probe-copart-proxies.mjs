#!/usr/bin/env node
/**
 * probe-copart-proxies.mjs
 *
 * Standalone script — не залежить від src/ і не потребує build.
 * Тестує проксі (і direct) на двох цільових URL Copart з різними TLS-стратегіями.
 *
 * Запуск:
 *   node scripts/probe-copart-proxies.mjs                    # default Node.js TLS
 *   node scripts/probe-copart-proxies.mjs --browser-tls      # Chrome-like cipher set
 *   node scripts/probe-copart-proxies.mjs --compare-tls      # порівняти обидва варіанти
 *   node scripts/probe-copart-proxies.mjs --direct-only      # тільки без проксі
 *   node scripts/probe-copart-proxies.mjs --proxy-only       # тільки проксі
 *   node scripts/probe-copart-proxies.mjs --concurrency 5 --timeout 12000
 */

import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const require = createRequire(import.meta.url);
const axios = require("axios");
const { HttpProxyAgent } = require("http-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");

// ─── Bootstrap ────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(ROOT_DIR, ".env"), quiet: true });

// ─── TLS modes ────────────────────────────────────────────────────────────────
//
// Chrome 124 TLS ClientHello містить:
//   • TLS 1.3 ciphers (перші 3) — Node.js підтримує, але різний порядок
//   • GREASE values — Node.js не відправляє взагалі (ось де JA3 різниться)
//   • extensions: server_name, extended_master_secret, session_ticket,
//     signature_algorithms, supported_groups, ec_point_formats,
//     application_layer_protocol_negotiation (h2+http/1.1), compress_certificate,
//     encrypted_client_hello
//
// Ця конфігурація НЕ дає точного Chrome JA3 (GREASE не підтримується в Node.js
// OpenSSL API) але суттєво змінює fingerprint відносно дефолтного Node.js.
// Вирішальний ефект: ~30-50% Cloudflare конфігурацій пропускають після цього.
//
// Для точного Chrome JA3 потрібен tls-client або got-scraping (окремий dep).

const CHROME_CIPHERS = [
  // TLS 1.3 (обов'язкові, порядок важливий)
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  // TLS 1.2 — Chrome preferred order
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

// Chrome signature algorithms (для TLS extension signature_algorithms)
const CHROME_SIGALGS = [
  "ecdsa_secp256r1_sha256",
  "rsa_pss_rsae_sha256",
  "rsa_pkcs1_sha256",
  "ecdsa_secp384r1_sha384",
  "rsa_pss_rsae_sha384",
  "rsa_pkcs1_sha384",
  "rsa_pss_rsae_sha512",
  "rsa_pkcs1_sha512",
].join(":");

// Chrome supported elliptic curves (ECDH groups)
const CHROME_ECDH_CURVES = "X25519:prime256v1:secp384r1";

const TLS_MODES = {
  default: {
    label: "default-tls",
    agentOptions: {},
  },
  browser: {
    label: "browser-tls",
    agentOptions: {
      ciphers: CHROME_CIPHERS,
      honorCipherOrder: false, // браузер не нав'язує порядок серверу
      minVersion: "TLSv1.2",
      sigalgs: CHROME_SIGALGS,
      ecdhCurve: CHROME_ECDH_CURVES,
    },
  },
};

// ─── Targets ─────────────────────────────────────────────────────────────────

const BOT_CHECK = (body) =>
  typeof body === "string" &&
  (body.toLowerCase().includes("just a moment") ||
    body.toLowerCase().includes("cf-challenge") ||
    body.toLowerCase().includes("enable javascript") ||
    body.toLowerCase().includes("checking your browser") ||
    body.toLowerCase().includes("attention required") ||
    body.toLowerCase().includes("access denied") ||
    body.includes("_Incapsula_Resource") ||
    body.toLowerCase().includes("incapsula") ||
    body.toLowerCase().includes("visid_incap") ||
    body.toLowerCase().includes("incap_ses"));

const TARGETS = [
  {
    // Реальний endpoint що використовує photo-sync (inventoryv2.copart.io)
    // В proxy-режимі код використовує HTTP, тому тестуємо обидва
    id: "INVENTORY_HTTP",
    url: "http://inventoryv2.copart.io/public/data/lotdetails/solr/lotImages/90813725/USA?country=us&brand=cprt&yardNumber=1",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.copart.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    },
    successCheck: (body) => {
      try {
        const json = typeof body === "string" ? JSON.parse(body) : body;
        return json && (json.data !== undefined || json.lotImages !== undefined || json.imgCount !== undefined);
      } catch {
        return false;
      }
    },
    botCheck: BOT_CHECK,
  },
  {
    // HTTPS варіант того ж endpoint (для direct-режиму)
    id: "INVENTORY_HTTPS",
    url: "https://inventoryv2.copart.io/public/data/lotdetails/solr/lotImages/90813725/USA?country=us&brand=cprt&yardNumber=1",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.copart.com/",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    },
    successCheck: (body) => {
      try {
        const json = typeof body === "string" ? JSON.parse(body) : body;
        return json && (json.data !== undefined || json.lotImages !== undefined || json.imgCount !== undefined);
      } catch {
        return false;
      }
    },
    botCheck: BOT_CHECK,
  },
  {
    // www.copart.com — публічна сторінка лота (Incapsula-захист)
    // Потрібна тільки якщо плануєте скрапити HTML сторінки
    id: "WWW_LOT_PAGE",
    url: "https://www.copart.com/lot/90813725/salvage-2024-tesla-model-3-in-indianapolis",
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "max-age=0",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    },
    successCheck: (body) =>
      typeof body === "string" &&
      (body.toLowerCase().includes("tesla") || body.toLowerCase().includes("90813725")),
    botCheck: BOT_CHECK,
  },
  {
    // mmember.copart.com — Copart mobile app API (iOS)
    // Повертає lotDetails + lotImages[] в одному запиті, без авторизації.
    // Потенційний fallback для лотів де inventoryv2 повертає порожній lotImages[].
    id: "MMEMBER_LOT",
    url: "https://mmember.copart.com/lots-api/v1/lot-details",
    method: "POST",
    body: JSON.stringify({ lotNumber: 42066666 }),
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      devicename: "iPhone 16 Pro",
      sitecode: "CPRTUS",
      company: "COPART",
      os: "ios",
      languagecode: "en-US",
      clientappversion: "6.7.2",
      deviceid: "5FE63153-B6D9-458F-90FA-287A625BF6D4",
      "ins-sess": "F81006D1-92C3-4F58-A623-4F52711D5C13",
      "User-Agent": "MemberMobile/5 CFNetwork/3860.300.31 Darwin/25.2.0",
    },
    successCheck: (body) => {
      try {
        const json = typeof body === "string" ? JSON.parse(body) : body;
        return json && Array.isArray(json.lotImages) && json.lotImages.length > 0;
      } catch {
        return false;
      }
    },
    botCheck: BOT_CHECK,
  },
];

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_BODY_READ = 16384;

// ─── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const CONCURRENCY = parseInt(getArg("--concurrency") || "8", 10);
const TIMEOUT_MS = parseInt(getArg("--timeout") || "15000", 10);
const DIRECT_ONLY = args.includes("--direct-only");
const PROXY_ONLY = args.includes("--proxy-only");
const BROWSER_TLS = args.includes("--browser-tls");
const COMPARE_TLS = args.includes("--compare-tls");

// ─── Residential proxy (окремий від основного пулу) ──────────────────────────
//
// Задається через:
//   env RESIDENTIAL_PROXY=http://user:pass@host:port
//   або CLI: --residential-proxy http://user:pass@host:port
//
// Якщо задано — додається як окремий маршрут "residential" в таблиці.
const RESIDENTIAL_PROXY_RAW = getArg("--residential-proxy") || process.env.RESIDENTIAL_PROXY || "";

// ─── Proxy parsing ────────────────────────────────────────────────────────────

function parseProxyUrl(raw) {
  const value = raw.trim();
  if (!value) return null;

  let normalized = value;
  if (!value.includes("://")) {
    const parts = value.split(":");
    if (parts.length === 4 && /^\d+$/.test(parts[1])) {
      const [host, port, username, password] = parts;
      normalized = `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    } else if (/^[^:\s]+:\d+$/.test(value) || value.includes("@")) {
      normalized = `http://${value}`;
    } else {
      return null;
    }
  }

  try {
    const url = new URL(normalized);
    const proto = url.protocol.replace(":", "");
    if (proto !== "http" && proto !== "https") return null;
    const port = url.port ? Number(url.port) : proto === "https" ? 443 : 80;
    const auth =
      url.username || url.password
        ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }
        : null;
    return { protocol: proto, host: url.hostname, port, auth };
  } catch {
    return null;
  }
}

function loadProxyList() {
  const mode = (process.env.HTTP_MODE || "direct").trim().toLowerCase();
  if (mode === "direct") return [];

  const listFile = (process.env.PROXY_LIST_FILE || "").trim();
  const inline = (process.env.PROXY_LIST || "").split(",").map((s) => s.trim()).filter(Boolean);

  let fromFile = [];
  if (listFile) {
    const resolved = path.isAbsolute(listFile) ? listFile : path.resolve(ROOT_DIR, listFile);
    if (fs.existsSync(resolved)) {
      fromFile = fs.readFileSync(resolved, "utf8")
        .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    } else {
      console.warn(`[warn] PROXY_LIST_FILE not found: ${resolved}`);
    }
  }

  const all = [...new Set([...fromFile, ...inline])];
  const parsed = [];
  for (const raw of all) {
    const p = parseProxyUrl(raw);
    if (p) parsed.push(p);
  }
  return parsed;
}

function proxyLabel(proxy) {
  const auth = proxy.auth ? `${proxy.auth.username}:***@` : "";
  return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
}

function buildProxyUrl(proxy) {
  const auth = proxy.auth
    ? `${encodeURIComponent(proxy.auth.username)}:${encodeURIComponent(proxy.auth.password)}@`
    : "";
  return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
}

// ─── Transport ────────────────────────────────────────────────────────────────

function getTransport(proxy, tlsAgentOptions) {
  if (!proxy) {
    // Direct: create a custom https.Agent з нашими TLS-параметрами
    const httpsAgent = new https.Agent(tlsAgentOptions);
    return { proxy: false, httpsAgent };
  }

  const proxyUrl = buildProxyUrl(proxy);
  // HttpsProxyAgent приймає TLS options другим аргументом —
  // вони застосовуються до CONNECT-тунелю і до самого TLS-хендшейку
  const httpsAgent = new HttpsProxyAgent(proxyUrl, tlsAgentOptions);
  const httpAgent = new HttpProxyAgent(proxyUrl);
  return { proxy: false, httpAgent, httpsAgent };
}

// ─── HTTP probe ───────────────────────────────────────────────────────────────

async function probeTarget(target, proxy, tlsAgentOptions) {
  const started = Date.now();
  const transport = getTransport(proxy, tlsAgentOptions);
  const method = target.method || "GET";

  try {
    const response = await axios.default.request({
      method,
      url: target.url,
      timeout: TIMEOUT_MS,
      maxRedirects: 5,
      responseType: "text",
      decompress: true,
      validateStatus: () => true,
      ...(target.body !== undefined ? { data: target.body } : {}),
      ...transport,
      headers: {
        ...(method !== "GET" ? {} : { "User-Agent": USER_AGENT }),
        ...target.headers,
      },
    });

    const latencyMs = Date.now() - started;
    const body =
      typeof response.data === "string"
        ? response.data.slice(0, MAX_BODY_READ)
        : JSON.stringify(response.data).slice(0, MAX_BODY_READ);

    return {
      status: response.status,
      body,
      latencyMs,
      error: null,
      cfRay: response.headers["cf-ray"] || null,
      server: response.headers["server"] || null,
    };
  } catch (err) {
    return {
      status: null,
      body: null,
      latencyMs: Date.now() - started,
      error: err.code || err.message || String(err),
      cfRay: null,
      server: null,
    };
  }
}

async function testProxyTarget(target, proxy, tlsAgentOptions) {
  const probe = await probeTarget(target, proxy, tlsAgentOptions);

  if (probe.error !== null) {
    return { result: "FAIL", status: null, latencyMs: probe.latencyMs, note: probe.error };
  }

  if (probe.status === 403 || probe.status === 503 || probe.status === 429) {
    const cfHint = probe.cfRay ? ` cf-ray=${probe.cfRay}` : "";
    return { result: "BOT", status: probe.status, latencyMs: probe.latencyMs, note: `HTTP ${probe.status}${cfHint}` };
  }

  if (probe.status !== 200) {
    return { result: "HTTP_ERR", status: probe.status, latencyMs: probe.latencyMs, note: `HTTP ${probe.status}` };
  }

  if (target.botCheck(probe.body)) {
    const cfHint = probe.cfRay ? ` cf-ray=${probe.cfRay}` : "";
    return { result: "BOT", status: 200, latencyMs: probe.latencyMs, note: `200+CF-challenge${cfHint}` };
  }

  if (target.successCheck(probe.body)) {
    return { result: "PASS", status: 200, latencyMs: probe.latencyMs, note: "" };
  }

  const snippet = (probe.body || "").slice(0, 100).replace(/\s+/g, " ");
  return { result: "HTTP_ERR", status: 200, latencyMs: probe.latencyMs, note: `200 unexpected: ${snippet}` };
}

async function testRoute(label, proxy, tlsAgentOptions) {
  const results = {};
  for (const target of TARGETS) {
    results[target.id] = await testProxyTarget(target, proxy, tlsAgentOptions);
  }
  return { label, results };
}

// ─── Concurrency ──────────────────────────────────────────────────────────────

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── Output ───────────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
};

function colorResult(result) {
  switch (result) {
    case "PASS":     return `${C.green}PASS${C.reset}`;
    case "BOT":      return `${C.red}BOT ${C.reset}`;
    case "FAIL":     return `${C.red}FAIL${C.reset}`;
    case "HTTP_ERR": return `${C.yellow}ERR ${C.reset}`;
    default:         return result;
  }
}

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

function summarize(routeResults) {
  let pass = 0, bot = 0, fail = 0;
  const perTarget = Object.fromEntries(TARGETS.map((t) => [t.id, 0]));
  for (const { results } of routeResults) {
    const allPass = TARGETS.every((t) => results[t.id].result === "PASS");
    if (allPass) pass++;
    else if (TARGETS.some((t) => results[t.id].result === "BOT")) bot++;
    else fail++;
    for (const t of TARGETS) {
      if (results[t.id].result === "PASS") perTarget[t.id]++;
    }
  }
  return { pass, bot, fail, perTarget, total: routeResults.length };
}

function printTable(routeResults, tlsLabel) {
  const LINE = "─".repeat(120);
  console.log(`\n${C.bold}TLS mode: ${tlsLabel}${C.reset}`);
  console.log(LINE);
  console.log(
    `${pad("ROUTE", 44)} ${TARGETS.map((t) => pad(t.id, 34)).join("  ")}  NOTES`
  );
  console.log(LINE);

  for (const { label, results } of routeResults) {
    const labelCol = pad(label, 44);
    const targetCols = TARGETS.map((t) => {
      const r = results[t.id];
      const cell = `${colorResult(r.result)} ${r.status ?? "---"} ${r.latencyMs}ms`;
      return pad(cell, 34 + 16); // 16 для ANSI codes
    });
    const notes = TARGETS.map((t) => results[t.id].note).filter(Boolean).join(" | ");
    console.log(`${labelCol} ${targetCols.join("  ")}  ${C.gray}${notes}${C.reset}`);
  }

  console.log(LINE);
  const s = summarize(routeResults);
  console.log(
    `${C.bold}RESULT${C.reset}  ` +
    `${C.green}PASS: ${s.pass}${C.reset}  ` +
    `${C.red}BOT: ${s.bot}${C.reset}  ` +
    `${C.yellow}FAIL/ERR: ${s.fail}${C.reset}  ` +
    TARGETS.map((t) => `${t.id}: ${s.perTarget[t.id]}/${s.total}`).join("  ")
  );
}

function printCompareRow(label, defaultResults, browserResults) {
  const LINE = "─".repeat(140);

  const labelCol = pad(label, 38);
  const cols = TARGETS.map((t) => {
    const d = defaultResults[t.id];
    const b = browserResults[t.id];
    const dCell = `${colorResult(d.result)}${d.latencyMs}ms`;
    const bCell = `${colorResult(b.result)}${b.latencyMs}ms`;
    const changed =
      d.result !== b.result
        ? ` ${C.cyan}↑TLS${C.reset}`
        : "";
    return `${dCell} → ${bCell}${changed}`;
  });
  console.log(`${labelCol} ${cols.join("    ")}`);
}

// ─── Run single mode ──────────────────────────────────────────────────────────

async function runSingleMode(routes, tlsMode) {
  const { label, agentOptions } = tlsMode;
  let completed = 0;
  const showProgress = routes.length > CONCURRENCY;

  const routeResults = await mapConcurrent(routes, CONCURRENCY, async ({ label: routeLabel, proxy }) => {
    const r = await testRoute(routeLabel, proxy, agentOptions);
    completed++;
    if (showProgress && completed % 5 === 0) {
      process.stderr.write(`\r[progress] ${completed}/${routes.length} routes tested...`);
    }
    return r;
  });

  if (showProgress) process.stderr.write("\r" + " ".repeat(60) + "\r");
  printTable(routeResults, label);
  return routeResults;
}

// ─── Run compare mode ─────────────────────────────────────────────────────────

async function runCompareMode(routes) {
  const LINE = "─".repeat(140);
  console.log(`\n${C.bold}=== TLS COMPARISON: default-tls vs browser-tls ===${C.reset}`);
  console.log(`Each route is tested twice — once with Node.js default TLS, once with Chrome-like TLS.`);
  console.log(`${C.cyan}↑TLS${C.reset} = результат змінився після browser-tls\n`);

  // Run both in parallel per route to save time
  let completed = 0;
  const showProgress = routes.length > 4;

  const pairs = await mapConcurrent(routes, CONCURRENCY, async ({ label: routeLabel, proxy }) => {
    const [defaultR, browserR] = await Promise.all([
      testRoute(routeLabel, proxy, TLS_MODES.default.agentOptions),
      testRoute(routeLabel, proxy, TLS_MODES.browser.agentOptions),
    ]);
    completed++;
    if (showProgress && completed % 5 === 0) {
      process.stderr.write(`\r[progress] ${completed}/${routes.length} routes compared...`);
    }
    return { label: routeLabel, defaultR, browserR };
  });

  if (showProgress) process.stderr.write("\r" + " ".repeat(60) + "\r");

  console.log(LINE);
  const headerTargets = TARGETS.map((t) => pad(`${t.id} (def→brw)`, 40)).join("    ");
  console.log(`${pad("ROUTE", 38)} ${headerTargets}`);
  console.log(LINE);

  let improved = 0;
  let degraded = 0;
  let unchanged = 0;

  for (const { label, defaultR, browserR } of pairs) {
    printCompareRow(label, defaultR.results, browserR.results);

    const defPass = TARGETS.every((t) => defaultR.results[t.id].result === "PASS");
    const brwPass = TARGETS.every((t) => browserR.results[t.id].result === "PASS");
    if (!defPass && brwPass) improved++;
    else if (defPass && !brwPass) degraded++;
    else unchanged++;
  }

  console.log(LINE);
  console.log(`\n${C.bold}TLS COMPARISON SUMMARY${C.reset}`);
  console.log(`  ${C.green}Improved by browser-tls (was BOT/FAIL → PASS):${C.reset} ${improved}`);
  console.log(`  ${C.yellow}Unchanged:${C.reset}                                      ${unchanged}`);
  console.log(`  ${C.red}Degraded (unlikely but logged):${C.reset}                 ${degraded}`);

  if (improved === 0 && !PROXY_ONLY) {
    console.log(`\n${C.yellow}[!] Browser-TLS не допоміг.${C.reset}`);
    console.log(`    Це означає що блокування відбувається НЕ на рівні TLS fingerprint, а:`);
    console.log(`    • IP / ASN репутація (datacenter проксі) — потрібні residential proxies`);
    console.log(`    • Cloudflare Cookie challenge (потрібна сесія з браузера)`);
    console.log(`    • Rate limiting по IP`);
  } else if (improved > 0) {
    console.log(`\n${C.cyan}[i] Browser-TLS допоміг для ${improved} маршрутів.${C.reset}`);
    console.log(`    Для повного ефекту розгляньте: npm install tls-client (точний Chrome JA3)`);
  }
}

// ─── Diagnostics ──────────────────────────────────────────────────────────────

function printDiagnostics(total, pass) {
  if (pass === 0) {
    console.log(`\n${C.yellow}[!] Жоден маршрут не пройшов.${C.reset}`);
    console.log(`    Запустіть з --compare-tls щоб перевірити чи TLS fingerprint є причиною.`);
    console.log(`    Запустіть з --direct-only щоб перевірити чи сам IP сервера блокується.`);
  } else if (pass < total) {
    console.log(`\n${C.cyan}[i] ${pass}/${total} маршрутів пройшли.${C.reset}`);
    console.log(`    Використовуйте тільки ті проксі що показали PASS для запитів до copart.com.`);
  } else {
    console.log(`\n${C.green}[✓] Всі ${total} маршрутів пройшли.${C.reset}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const proxies = loadProxyList();

  // Residential proxy route
  const residentialProxy = RESIDENTIAL_PROXY_RAW ? parseProxyUrl(RESIDENTIAL_PROXY_RAW) : null;
  if (RESIDENTIAL_PROXY_RAW && !residentialProxy) {
    console.warn(`${C.yellow}[warn] RESIDENTIAL_PROXY не вдалося розпарсити: ${RESIDENTIAL_PROXY_RAW}${C.reset}`);
  }

  console.log(`\n${C.bold}=== Copart Anti-Bot Proxy Probe ===${C.reset}`);
  console.log(`${C.gray}Date: ${new Date().toISOString()}${C.reset}`);

  console.log(`\n${C.bold}Targets:${C.reset}`);
  for (const [i, t] of TARGETS.entries()) {
    console.log(`  [${i + 1}] ${t.id}: ${t.url}`);
  }

  const tlsModeLabel = COMPARE_TLS ? "compare (default + browser)" : BROWSER_TLS ? "browser-tls" : "default-tls";
  console.log(`\n${C.bold}Settings:${C.reset}`);
  console.log(`  concurrency: ${CONCURRENCY}  timeout: ${TIMEOUT_MS}ms`);
  console.log(`  tls-mode:    ${tlsModeLabel}`);
  console.log(`  HTTP_MODE:   ${process.env.HTTP_MODE || "direct"}`);
  console.log(`  Proxies loaded: ${proxies.length}`);
  if (residentialProxy) {
    console.log(`  ${C.cyan}Residential proxy: ${proxyLabel(residentialProxy)}${C.reset}`);
  }
  console.log(`\n${C.bold}TLS fingerprint note:${C.reset} ${C.gray}`);
  console.log(`  default-tls  → Node.js/OpenSSL JA3 — Cloudflare може бачити як бот`);
  console.log(`  browser-tls  → Chrome-like ciphers + sigalgs (часткова маскировка)`);
  console.log(`  Точний Chrome JA3 → потребує: npm install tls-client (окремий крок)${C.reset}`);

  // Build routes
  const routes = [];
  if (!PROXY_ONLY) routes.push({ label: "direct (no proxy)", proxy: null });
  if (residentialProxy) routes.push({ label: `residential: ${proxyLabel(residentialProxy)}`, proxy: residentialProxy });
  if (!DIRECT_ONLY) for (const p of proxies) routes.push({ label: proxyLabel(p), proxy: p });

  if (routes.length === 0) {
    console.error("\n[error] No routes to test. Check HTTP_MODE and proxy list.");
    process.exit(1);
  }

  console.log(`\n${C.bold}Routes to test: ${routes.length}${C.reset}`);

  if (COMPARE_TLS) {
    await runCompareMode(routes);
  } else {
    const tlsMode = BROWSER_TLS ? TLS_MODES.browser : TLS_MODES.default;
    const results = await runSingleMode(routes, tlsMode);
    const s = summarize(results);
    printDiagnostics(s.total, s.pass);
  }

  console.log(`\n${C.bold}Legend:${C.reset}`);
  console.log(`  ${C.green}PASS${C.reset}     відповідь коректна (очікуваний контент)`);
  console.log(`  ${C.red}BOT${C.reset}      Cloudflare заблокував (403/503 або JS-challenge в body)`);
  console.log(`  ${C.yellow}ERR${C.reset}      HTTP відповідь не 200 і не bot-response`);
  console.log(`  ${C.red}FAIL${C.reset}     мережева помилка (таймаут, відмова з'єднання)`);

  console.log("");
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
