#!/usr/bin/env node
/**
 * test-photo-endpoints.mjs
 *
 * Фінальний тест всіх відомих endpoints для отримання фото лота.
 * Тестує кожен endpoint через 3 маршрути: direct, residential proxy, перший proxy з файлу.
 *
 * Запуск:
 *   node scripts/test-photo-endpoints.mjs
 *   node scripts/test-photo-endpoints.mjs 42066666 74590025
 *   node scripts/test-photo-endpoints.mjs --lot 74590025 --lot 42066666
 *
 * ENV:
 *   RESIDENTIAL_PROXY=http://user:pass@host:port   (за замовчуванням вже вбудований)
 *   PROXY_LIST_FILE=proxies.txt                    (за замовчуванням proxies.txt)
 */

import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import dotenv from "dotenv";

const require = createRequire(import.meta.url);
const { HttpsProxyAgent } = require("https-proxy-agent");
const { HttpProxyAgent } = require("http-proxy-agent");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

// ─── Config ───────────────────────────────────────────────────────────────────

const TIMEOUT_MS = 20_000;

// Residential proxy за замовчуванням (можна перевизначити через ENV)
const RESIDENTIAL_PROXY_URL =
  process.env.RESIDENTIAL_PROXY ||
  "http://ek517ci0v19wgwu:1ibxr0jh1jnk8wq@rp.scrapegw.com:6060";

// Файл з проксі (береться перший рядок для тесту)
const PROXY_LIST_FILE = process.env.PROXY_LIST_FILE || path.join(ROOT, "proxies.txt");

// ─── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const lots = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--lot" && args[i + 1]) {
    lots.push(Number(args[++i]));
  } else if (/^\d{6,}$/.test(args[i])) {
    lots.push(Number(args[i]));
  }
}
if (lots.length === 0) lots.push(42066666, 74590025);

// ─── Colors ───────────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m",
  yellow: "\x1b[33m", gray: "\x1b[90m", bold: "\x1b[1m",
  cyan: "\x1b[36m", blue: "\x1b[34m", magenta: "\x1b[35m",
};

// ─── Proxy helpers ────────────────────────────────────────────────────────────

function parseProxyUrl(raw) {
  if (!raw || !raw.trim()) return null;
  let s = raw.trim();
  if (!s.includes("://")) s = "http://" + s;
  try {
    const u = new URL(s);
    return {
      url: s,
      label: `${u.protocol}//${u.username ? u.username + ":***@" : ""}${u.hostname}:${u.port}`,
    };
  } catch {
    return null;
  }
}

function loadFirstProxy() {
  if (!fs.existsSync(PROXY_LIST_FILE)) return null;
  const lines = fs.readFileSync(PROXY_LIST_FILE, "utf8")
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("#"));
  return lines.length > 0 ? parseProxyUrl(lines[0]) : null;
}

function makeAgent(proxyUrl, targetIsHttps) {
  if (!proxyUrl) return null;
  return targetIsHttps
    ? new HttpsProxyAgent(proxyUrl)
    : new HttpProxyAgent(proxyUrl);
}

// ─── Raw HTTP request ─────────────────────────────────────────────────────────

function doRequest({ url, method = "GET", headers = {}, body = null, proxyUrl = null }) {
  const startedAt = Date.now();

  const requestPromise = new Promise((resolve) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const agent = makeAgent(proxyUrl, isHttps);
    const bodyBuf = body ? Buffer.from(body, "utf8") : null;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        ...(bodyBuf ? { "Content-Length": bodyBuf.length } : {}),
        ...headers,
      },
      ...(agent ? { agent } : {}),
    };

    const mod = isHttps ? https : http;

    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString("utf8"), ms: Date.now() - startedAt, error: null });
      });
      res.on("error", err => {
        resolve({ status: null, raw: null, ms: Date.now() - startedAt, error: err.code || err.message });
      });
    });

    req.on("error", err => {
      resolve({ status: null, raw: null, ms: Date.now() - startedAt, error: err.code || err.message });
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });

  const timeoutPromise = new Promise(resolve =>
    setTimeout(() => resolve({ status: null, raw: null, ms: TIMEOUT_MS, error: "TIMEOUT" }), TIMEOUT_MS)
  );

  return Promise.race([requestPromise, timeoutPromise]);
}

// ─── Endpoints ────────────────────────────────────────────────────────────────
//
// Кожен endpoint — функція що приймає lotNumber і повертає описаний запит.
// parse(raw) → { photos: [{seq, label, url}], imgCount, error }

const ENDPOINTS = [
  {
    id: "INVENTORYV2_HTTP",
    label: "inventoryv2 HTTP (основний, proxy-mode)",
    note: "Основний endpoint в photo-sync (HTTP через проксі)",
    buildRequest: (lot, yardNumber = 1) => ({
      url: `http://inventoryv2.copart.io/v1/lotImages/${lot}?country=us&brand=cprt&yardNumber=${yardNumber}`,
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: "https://www.copart.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      },
    }),
    parse(raw) {
      try {
        const j = JSON.parse(raw);
        const imgCount = j.imgCount ?? 0;
        const photos = [];
        for (const img of (j.lotImages || [])) {
          for (const link of (img.link || [])) {
            if (link.url && !link.isThumbNail && !link.isEngineSound) {
              photos.push({ seq: img.sequence, label: link.isHdImage ? "HD" : "full", url: link.url });
            }
          }
        }
        return { photos, imgCount, rawImgCount: imgCount };
      } catch (e) {
        return { photos: [], imgCount: 0, error: e.message };
      }
    },
  },
  {
    id: "INVENTORYV2_HTTPS",
    label: "inventoryv2 HTTPS (direct-mode)",
    note: "Той самий endpoint у direct-режимі",
    buildRequest: (lot, yardNumber = 1) => ({
      url: `https://inventoryv2.copart.io/v1/lotImages/${lot}?country=us&brand=cprt&yardNumber=${yardNumber}`,
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: "https://www.copart.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      },
    }),
    parse(raw) {
      return ENDPOINTS[0].parse(raw);
    },
  },
  {
    id: "MMEMBER_POST",
    label: "mmember.copart.com POST (iOS mobile API)",
    note: "Fallback. Не потребує токенів. Потребує residential IP.",
    buildRequest: (lot) => ({
      url: "https://mmember.copart.com/lots-api/v1/lot-details",
      method: "POST",
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
      body: JSON.stringify({ lotNumber: lot }),
    }),
    parse(raw) {
      try {
        const j = JSON.parse(raw);
        const photos = (j.lotImages || []).map(img => ({
          seq: img.sequenceNumber,
          label: img.imageLabelCode || "IMG",
          url: img.url || img.hdUrl || "",
        }));
        return { photos, imgCount: photos.length };
      } catch (e) {
        return { photos: [], imgCount: 0, error: e.message };
      }
    },
  },
  {
    id: "WWW_SOLR_GET",
    label: "www.copart.com solr GET (захищений Incapsula)",
    note: "Потребує session cookies або residential proxy з сесією",
    buildRequest: (lot) => ({
      url: `https://www.copart.com/public/data/lotdetails/solr/lotImages/${lot}/USA`,
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: `https://www.copart.com/lot/${lot}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    }),
    parse(raw) {
      try {
        const j = JSON.parse(raw);
        // www повертає {data:{lotImages:[...]}} або {lotImages:[...]}
        const list = j?.data?.lotImages || j?.lotImages || [];
        const photos = list.map(img => ({
          seq: img.sequenceNumber,
          label: img.imageLabelCode || "IMG",
          url: img.url || img.fullUrl || img.hdUrl || "",
        }));
        return { photos, imgCount: photos.length };
      } catch (e) {
        return { photos: [], imgCount: 0, error: e.message };
      }
    },
  },
];

// ─── Routes ───────────────────────────────────────────────────────────────────

function buildRoutes() {
  const residential = parseProxyUrl(RESIDENTIAL_PROXY_URL);
  const firstFileProxy = loadFirstProxy();

  const routes = [
    { id: "direct", label: "direct (server IP)", proxyUrl: null },
    { id: "residential", label: `residential: ${residential?.label ?? "n/a"}`, proxyUrl: residential?.url ?? null },
  ];

  if (firstFileProxy) {
    routes.push({ id: "file_proxy_1", label: `proxies.txt #1: ${firstFileProxy.label}`, proxyUrl: firstFileProxy.url });
  } else {
    routes.push({ id: "file_proxy_1", label: "proxies.txt #1: (файл не знайдено)", proxyUrl: null });
  }

  return routes;
}

// ─── Run one cell ─────────────────────────────────────────────────────────────

async function testCell(endpoint, route, lot, yardNumber) {
  const reqDef = endpoint.buildRequest(lot, yardNumber);
  const { status, raw, ms, error } = await doRequest({ ...reqDef, proxyUrl: route.proxyUrl });

  if (error) return { outcome: "FAIL", status: null, ms, photos: 0, imgCount: 0, note: error };

  const isBot = raw && (
    raw.includes("_Incapsula_Resource") ||
    raw.toLowerCase().includes("visid_incap") ||
    raw.toLowerCase().includes("access denied") ||
    raw.toLowerCase().includes("just a moment")
  );

  if (status === 403 || status === 503 || status === 429 || (status === 200 && isBot)) {
    return { outcome: "BOT", status, ms, photos: 0, imgCount: 0, note: `HTTP ${status}${isBot && status === 200 ? "+bot-body" : ""}` };
  }

  if (!status || status < 200 || status >= 300) {
    const snippet = (raw || "").slice(0, 80).replace(/\s+/g, " ");
    return { outcome: "ERR", status, ms, photos: 0, imgCount: 0, note: `HTTP ${status}: ${snippet}` };
  }

  const parsed = endpoint.parse(raw || "");
  if (parsed.photos.length > 0) {
    return { outcome: "PASS", status, ms, photos: parsed.photos.length, imgCount: parsed.imgCount, note: "", parsedPhotos: parsed.photos };
  }

  if (parsed.imgCount > 0) {
    return { outcome: "EMPTY", status, ms, photos: 0, imgCount: parsed.imgCount, note: `imgCount=${parsed.imgCount} але lotImages=[]` };
  }

  return { outcome: "NO_PHOTOS", status, ms, photos: 0, imgCount: 0, note: parsed.error || "0 photos" };
}

// ─── Print ────────────────────────────────────────────────────────────────────

function colorOutcome(o) {
  switch (o) {
    case "PASS":      return `${C.green}PASS     ${C.reset}`;
    case "EMPTY":     return `${C.yellow}EMPTY    ${C.reset}`;
    case "BOT":       return `${C.red}BOT      ${C.reset}`;
    case "FAIL":      return `${C.red}FAIL     ${C.reset}`;
    case "ERR":       return `${C.yellow}ERR      ${C.reset}`;
    case "NO_PHOTOS": return `${C.magenta}NO_PHOTOS${C.reset}`;
    default:          return o;
  }
}

function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length); }

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const routes = buildRoutes();

  console.log(`\n${C.bold}=== Photo Endpoints Final Test ===${C.reset}`);
  console.log(`${C.gray}Date: ${new Date().toISOString()}${C.reset}`);
  console.log(`${C.gray}Lots: ${lots.join(", ")}${C.reset}\n`);

  console.log(`${C.bold}Routes:${C.reset}`);
  for (const r of routes) console.log(`  [${r.id}] ${r.label}`);

  console.log(`\n${C.bold}Endpoints:${C.reset}`);
  for (const e of ENDPOINTS) console.log(`  [${e.id}] ${e.label}`);

  for (const lot of lots) {
    console.log(`\n${"═".repeat(100)}`);
    console.log(`${C.bold}LOT ${lot}${C.reset}`);
    console.log("═".repeat(100));

    // Запускаємо всі комбінації паралельно
    const jobs = [];
    for (const endpoint of ENDPOINTS) {
      for (const route of routes) {
        jobs.push({ endpoint, route });
      }
    }

    const results = await Promise.all(
      jobs.map(({ endpoint, route }) => testCell(endpoint, route, lot, 1))
    );

    // Друкуємо таблицю: рядки = endpoints, стовпці = routes
    const LINE = "─".repeat(100);
    console.log(`\n${pad("ENDPOINT", 28)} ${routes.map(r => pad(r.id.toUpperCase(), 28)).join("  ")}`);
    console.log(LINE);

    for (let ei = 0; ei < ENDPOINTS.length; ei++) {
      const ep = ENDPOINTS[ei];
      const cells = routes.map((_, ri) => results[ei * routes.length + ri]);
      const cols = cells.map(c => {
        const outcome = colorOutcome(c.outcome);
        const detail = c.outcome === "PASS" ? `${C.green}${c.photos}ph${C.reset}` :
                       c.outcome === "EMPTY" ? `${C.yellow}imgC=${c.imgCount}${C.reset}` :
                       `${C.gray}${c.status ?? "---"}${C.reset}`;
        return `${outcome} ${detail} ${C.gray}${c.ms}ms${C.reset}`;
      });
      console.log(`${pad(ep.id, 28)} ${cols.join("  ")}`);
    }

    console.log(LINE);

    // Детальні нотатки по помилках
    let hasNotes = false;
    for (let ei = 0; ei < ENDPOINTS.length; ei++) {
      for (let ri = 0; ri < routes.length; ri++) {
        const c = results[ei * routes.length + ri];
        if (c.note) {
          if (!hasNotes) { console.log(`\n${C.bold}Notes:${C.reset}`); hasNotes = true; }
          console.log(`  ${C.gray}[${ENDPOINTS[ei].id}][${routes[ri].id}] ${c.note}${C.reset}`);
        }
      }
    }

    // Показуємо фото для PASS результатів
    for (let ei = 0; ei < ENDPOINTS.length; ei++) {
      for (let ri = 0; ri < routes.length; ri++) {
        const c = results[ei * routes.length + ri];
        if (c.outcome === "PASS" && c.parsedPhotos) {
          console.log(`\n${C.bold}[${ENDPOINTS[ei].id}][${routes[ri].id}] Photos (${c.parsedPhotos.length}):${C.reset}`);
          for (const p of c.parsedPhotos.slice(0, 5)) {
            const shortUrl = p.url.replace(/^https?:\/\/[^/]+/, "").slice(-70);
            console.log(`  ${C.gray}[${p.seq ?? "?"}] ${String(p.label).padEnd(6)} ...${shortUrl}${C.reset}`);
          }
          if (c.parsedPhotos.length > 5) {
            console.log(`  ${C.gray}  ... ще ${c.parsedPhotos.length - 5} фото${C.reset}`);
          }
        }
      }
    }
  }

  // Підсумок
  console.log(`\n${"═".repeat(100)}`);
  console.log(`${C.bold}ПІДСУМОК${C.reset}`);
  console.log("═".repeat(100));
  console.log(`\n${C.bold}Легенда:${C.reset}`);
  console.log(`  ${C.green}PASS${C.reset}      — фото отримані`);
  console.log(`  ${C.yellow}EMPTY${C.reset}     — imgCount > 0 але lotImages[] порожній (відомий баг inventoryv2)`);
  console.log(`  ${C.red}BOT${C.reset}       — Incapsula заблокував`);
  console.log(`  ${C.yellow}ERR${C.reset}       — HTTP помилка (не 2xx)`);
  console.log(`  ${C.magenta}NO_PHOTOS${C.reset} — 200 OK але 0 фото і imgCount=0`);
  console.log(`  ${C.red}FAIL${C.reset}      — мережева помилка / таймаут`);
  console.log("");
}

main().catch(err => { console.error("[fatal]", err); process.exit(1); });
