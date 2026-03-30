#!/usr/bin/env node
/**
 * test-mmember.mjs
 *
 * Тестує mmember.copart.com API напряму і через residential proxy.
 *
 * Запуск:
 *   node scripts/test-mmember.mjs                        # лот за замовчуванням
 *   node scripts/test-mmember.mjs 74590025               # конкретний лот
 *   node scripts/test-mmember.mjs 74590025 42066666      # кілька лотів
 */

import https from "node:https";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { HttpsProxyAgent } = require("https-proxy-agent");

// ─── Config ───────────────────────────────────────────────────────────────────

const RESIDENTIAL_PROXY = "http://ek517ci0v19wgwu:1ibxr0jh1jnk8wq@rp.scrapegw.com:6060";
const TIMEOUT_MS = 30_000;

const MOBILE_HEADERS = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/plain, */*",
  "devicename": "iPhone 16 Pro",
  "sitecode": "CPRTUS",
  "company": "COPART",
  "os": "ios",
  "languagecode": "en-US",
  "clientappversion": "6.7.2",
  "deviceid": "5FE63153-B6D9-458F-90FA-287A625BF6D4",
  "ins-sess": "F81006D1-92C3-4F58-A623-4F52711D5C13",
  "User-Agent": "MemberMobile/5 CFNetwork/3860.300.31 Darwin/25.2.0",
};

// ─── HTTP request ─────────────────────────────────────────────────────────────

function request(lotNumber, proxyUrl) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ lotNumber });
    const options = {
      hostname: "mmember.copart.com",
      path: "/lots-api/v1/lot-details",
      method: "POST",
      headers: { ...MOBILE_HEADERS, "Content-Length": Buffer.byteLength(body) },
      timeout: TIMEOUT_MS,
    };

    if (proxyUrl) {
      options.agent = new HttpsProxyAgent(proxyUrl);
    }

    const startedAt = Date.now();
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const latencyMs = Date.now() - startedAt;
        const raw = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json, raw, latencyMs, error: null });
      });
    });

    req.on("timeout", () => { req.destroy(); resolve({ status: null, json: null, raw: null, latencyMs: Date.now() - startedAt, error: "TIMEOUT" }); });
    req.on("error", (err) => resolve({ status: null, json: null, raw: null, latencyMs: Date.now() - startedAt, error: err.code || err.message }));

    req.write(body);
    req.end();
  });
}

// ─── Print result ─────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m",
  yellow: "\x1b[33m", gray: "\x1b[90m", bold: "\x1b[1m", cyan: "\x1b[36m",
};

function printResult(label, lotNumber, { status, json, raw, latencyMs, error }) {
  console.log(`\n${C.bold}[${label}] lot ${lotNumber}${C.reset}  ${C.gray}${latencyMs}ms${C.reset}`);

  if (error) {
    console.log(`  ${C.red}ERROR: ${error}${C.reset}`);
    return;
  }

  if (status !== 200) {
    const snippet = (raw || "").slice(0, 200).replace(/\s+/g, " ");
    console.log(`  ${C.red}HTTP ${status}${C.reset}  ${C.gray}${snippet}${C.reset}`);
    return;
  }

  if (!json) {
    console.log(`  ${C.yellow}HTTP 200 але відповідь не JSON${C.reset}`);
    console.log(`  ${C.gray}${(raw || "").slice(0, 200)}${C.reset}`);
    return;
  }

  const images = Array.isArray(json.lotImages) ? json.lotImages : [];
  const imgCount = json.lotDetails?.imgCount ?? images.length;

  if (images.length > 0) {
    console.log(`  ${C.green}PASS${C.reset}  imgCount=${imgCount}  lotImages=${images.length}`);
    for (const img of images) {
      const url = img.url || img.hdUrl || "";
      const label = img.imageLabelCode || "";
      const seq = img.sequenceNumber ?? "?";
      console.log(`  ${C.gray}[${seq}] ${label.padEnd(6)} ${url.slice(-70)}${C.reset}`);
    }
  } else {
    const keys = Object.keys(json).join(", ");
    console.log(`  ${C.yellow}HTTP 200, lotImages пустий${C.reset}  imgCount=${imgCount}  keys: ${keys}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const lotArgs = process.argv.slice(2).filter(a => /^\d+$/.test(a));
  const lots = lotArgs.length > 0 ? lotArgs.map(Number) : [42066666];

  console.log(`${C.bold}=== mmember.copart.com API test ===${C.reset}`);
  console.log(`${C.gray}Lots: ${lots.join(", ")}${C.reset}`);
  console.log(`${C.gray}Residential proxy: ${RESIDENTIAL_PROXY.replace(/:([^:@]+)@/, ":***@")}${C.reset}`);

  for (const lot of lots) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`${C.bold}Lot ${lot}${C.reset}`);

    const [directResult, proxyResult] = await Promise.all([
      request(lot, null),
      request(lot, RESIDENTIAL_PROXY),
    ]);

    printResult("DIRECT (server IP)", lot, directResult);
    printResult("RESIDENTIAL PROXY", lot, proxyResult);
  }

  console.log(`\n${"─".repeat(70)}`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
