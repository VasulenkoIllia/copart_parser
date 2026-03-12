#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const axios = require('axios');
const pLimitImport = require('p-limit');

const pLimit = pLimitImport.default || pLimitImport;

const INPUT_FILE = process.argv[2];

if (!INPUT_FILE) {
  console.error('Usage: node copart_limit_test.js <path-to-csv>');
  process.exit(1);
}

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10);
const MAX_ROWS = parseInt(process.env.MAX_ROWS || '0', 10); // 0 = all rows
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '15000', 10);
const DELAY_MS = parseInt(process.env.DELAY_MS || '0', 10);
const TEST_IMAGE = ['1', 'true', 'yes'].includes(
  String(process.env.TEST_IMAGE || '0').toLowerCase()
);
const OUTPUT_PREFIX = process.env.OUTPUT_PREFIX || 'copart_test';
const DEDUPE_BY_IMAGE_URL = ['1', 'true', 'yes'].includes(
  String(process.env.DEDUPE_BY_IMAGE_URL || '1').toLowerCase()
);

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

async function readCsvRows(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let count = 0;

    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', row => {
        if (MAX_ROWS > 0 && count >= MAX_ROWS) return;
        rows.push(row);
        count += 1;
      })
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

function getFirstImageUrlsFromResponse(data) {
  let firstAnyUrl = '';
  let firstThumbUrl = '';
  let firstFullUrl = '';
  let firstHdUrl = '';

  if (!data || !Array.isArray(data.lotImages)) {
    return {
      firstAnyUrl,
      firstThumbUrl,
      firstFullUrl,
      firstHdUrl,
    };
  }

  for (const lotImage of data.lotImages) {
    if (!lotImage || !Array.isArray(lotImage.link)) continue;

    for (const link of lotImage.link) {
      if (!link || !link.url) continue;

      const cleanUrl = String(link.url).trim();

      if (!firstAnyUrl) {
        firstAnyUrl = cleanUrl;
      }

      if (link.isThumbNail && !firstThumbUrl) {
        firstThumbUrl = cleanUrl;
      }

      if (link.isHdImage && !firstHdUrl) {
        firstHdUrl = cleanUrl;
      }

      if (!link.isThumbNail && !link.isHdImage && !firstFullUrl) {
        firstFullUrl = cleanUrl;
      }
    }
  }

  return {
    firstAnyUrl,
    firstThumbUrl,
    firstFullUrl,
    firstHdUrl,
  };
}

async function testImageUrl(imageUrl) {
  const started = Date.now();

  try {
    const response = await axios({
      method: 'head',
      url: imageUrl,
      timeout: REQUEST_TIMEOUT,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://www.copart.com/',
      },
    });

    return {
      image_test_status: response.status,
      image_test_time_ms: Date.now() - started,
      image_test_content_type: response.headers['content-type'] || '',
      image_test_content_length: response.headers['content-length'] || '',
      image_test_error: '',
    };
  } catch (error) {
    return {
      image_test_status: 'ERROR',
      image_test_time_ms: Date.now() - started,
      image_test_content_type: '',
      image_test_content_length: '',
      image_test_error: error.message || 'Unknown image test error',
    };
  }
}

async function testEndpoint(row, rowIndex) {
  const lotNumber = String(row['Lot number'] || '').trim();
  const yardNumber = String(row['Yard number'] || '').trim();
  const imageUrl = String(row['Image URL'] || '').trim();

  if (!imageUrl) {
    return {
      row_index: rowIndex,
      lot_number: lotNumber,
      yard_number: yardNumber,
      image_url: '',
      endpoint_status: 'NO_URL',
      endpoint_time_ms: null,
      endpoint_content_type: '',
      json_ok: false,
      img_count: null,
      lot_images_count: null,
      first_test_image_url: '',
      first_thumb_url: '',
      first_full_url: '',
      first_hd_url: '',
      error: 'Missing Image URL',
      image_test_status: '',
      image_test_time_ms: '',
      image_test_content_type: '',
      image_test_content_length: '',
      image_test_error: '',
    };
  }

  if (DELAY_MS > 0) {
    await sleep(DELAY_MS);
  }

  const started = Date.now();

  try {
    const response = await axios.get(imageUrl, {
      timeout: REQUEST_TIMEOUT,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.copart.com/',
      },
    });

    const endpointTime = Date.now() - started;
    const contentType = response.headers['content-type'] || '';
    const isJson =
      typeof response.data === 'object' ||
      contentType.toLowerCase().includes('application/json');

    let jsonOk = false;
    let imgCount = null;
    let lotImagesCount = null;
    let firstTestImageUrl = '';
    let firstThumbUrl = '';
    let firstFullUrl = '';
    let firstHdUrl = '';
    let parseError = '';

    if (response.status === 200 && isJson && response.data) {
      jsonOk = true;
      imgCount = safeNumber(response.data.imgCount);
      lotImagesCount = Array.isArray(response.data.lotImages)
        ? response.data.lotImages.length
        : null;

      const firstUrls = getFirstImageUrlsFromResponse(response.data);
      firstTestImageUrl = firstUrls.firstAnyUrl;
      firstThumbUrl = firstUrls.firstThumbUrl;
      firstFullUrl = firstUrls.firstFullUrl;
      firstHdUrl = firstUrls.firstHdUrl;
    } else {
      parseError = `Unexpected response: status=${response.status}, content-type=${contentType}`;
    }

    let imageTest = {
      image_test_status: '',
      image_test_time_ms: '',
      image_test_content_type: '',
      image_test_content_length: '',
      image_test_error: '',
    };

    if (TEST_IMAGE && firstTestImageUrl) {
      imageTest = await testImageUrl(firstTestImageUrl);
    }

    return {
      row_index: rowIndex,
      lot_number: lotNumber,
      yard_number: yardNumber,
      image_url: imageUrl,
      endpoint_status: response.status,
      endpoint_time_ms: endpointTime,
      endpoint_content_type: contentType,
      json_ok: jsonOk,
      img_count: imgCount,
      lot_images_count: lotImagesCount,
      first_test_image_url: firstTestImageUrl,
      first_thumb_url: firstThumbUrl,
      first_full_url: firstFullUrl,
      first_hd_url: firstHdUrl,
      error: parseError,
      ...imageTest,
    };
  } catch (error) {
    return {
      row_index: rowIndex,
      lot_number: lotNumber,
      yard_number: yardNumber,
      image_url: imageUrl,
      endpoint_status: 'ERROR',
      endpoint_time_ms: Date.now() - started,
      endpoint_content_type: '',
      json_ok: false,
      img_count: null,
      lot_images_count: null,
      first_test_image_url: '',
      first_thumb_url: '',
      first_full_url: '',
      first_hd_url: '',
      error: error.message || 'Unknown request error',
      image_test_status: '',
      image_test_time_ms: '',
      image_test_content_type: '',
      image_test_content_length: '',
      image_test_error: '',
    };
  }
}

function buildSummary(results, startedAt, rowsCount, uniqueUrlCount) {
  const endpointStatusCounts = {};
  const imageStatusCounts = {};
  const endpointLatencies = [];
  const imageLatencies = [];

  let jsonOkCount = 0;
  let imageUrlFoundCount = 0;
  let firstThumbFoundCount = 0;
  let firstFullFoundCount = 0;
  let firstHdFoundCount = 0;
  let totalImgCount = 0;
  let totalLotImagesCount = 0;

  for (const r of results) {
    const endpointKey = String(r.endpoint_status);
    endpointStatusCounts[endpointKey] = (endpointStatusCounts[endpointKey] || 0) + 1;

    if (r.image_test_status !== '' && r.image_test_status !== undefined) {
      const imageKey = String(r.image_test_status);
      imageStatusCounts[imageKey] = (imageStatusCounts[imageKey] || 0) + 1;
    }

    if (typeof r.endpoint_time_ms === 'number') endpointLatencies.push(r.endpoint_time_ms);
    if (typeof r.image_test_time_ms === 'number') imageLatencies.push(r.image_test_time_ms);

    if (r.json_ok) jsonOkCount += 1;
    if (r.first_test_image_url) imageUrlFoundCount += 1;
    if (r.first_thumb_url) firstThumbFoundCount += 1;
    if (r.first_full_url) firstFullFoundCount += 1;
    if (r.first_hd_url) firstHdFoundCount += 1;
    if (typeof r.img_count === 'number') totalImgCount += r.img_count;
    if (typeof r.lot_images_count === 'number') totalLotImagesCount += r.lot_images_count;
  }

  const endedAt = new Date();
  const durationMs = endedAt.getTime() - startedAt.getTime();

  const errorSamples = results
    .filter(r => r.error || r.image_test_error)
    .slice(0, 20)
    .map(r => ({
      lot_number: r.lot_number,
      endpoint_status: r.endpoint_status,
      error: r.error,
      image_test_status: r.image_test_status,
      image_test_error: r.image_test_error,
    }));

  return {
    input_file: INPUT_FILE,
    rows_read: rowsCount,
    unique_image_urls: uniqueUrlCount,
    tested_rows: results.length,
    concurrency: CONCURRENCY,
    request_timeout_ms: REQUEST_TIMEOUT,
    delay_ms_between_tasks: DELAY_MS,
    test_image_enabled: TEST_IMAGE,
    dedupe_by_image_url: DEDUPE_BY_IMAGE_URL,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_ms: durationMs,
    endpoint_status_counts: endpointStatusCounts,
    image_status_counts: imageStatusCounts,
    json_ok_count: jsonOkCount,
    image_url_found_count: imageUrlFoundCount,
    first_thumb_found_count: firstThumbFoundCount,
    first_full_found_count: firstFullFoundCount,
    first_hd_found_count: firstHdFoundCount,
    total_img_count_sum: totalImgCount,
    total_lot_images_count_sum: totalLotImagesCount,
    endpoint_latency_ms: {
      min: endpointLatencies.length ? Math.min(...endpointLatencies) : null,
      p50: percentile(endpointLatencies, 50),
      p95: percentile(endpointLatencies, 95),
      p99: percentile(endpointLatencies, 99),
      max: endpointLatencies.length ? Math.max(...endpointLatencies) : null,
    },
    image_latency_ms: {
      min: imageLatencies.length ? Math.min(...imageLatencies) : null,
      p50: percentile(imageLatencies, 50),
      p95: percentile(imageLatencies, 95),
      p99: percentile(imageLatencies, 99),
      max: imageLatencies.length ? Math.max(...imageLatencies) : null,
    },
    error_samples: errorSamples,
  };
}

function dedupeRowsByImageUrl(rows) {
  const seen = new Set();
  const uniqueRows = [];

  for (const row of rows) {
    const url = String(row['Image URL'] || '').trim();
    const key = url || `__empty__${uniqueRows.length}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueRows.push(row);
    }
  }

  return uniqueRows;
}

async function main() {
  const startedAt = new Date();

  console.log(`Reading CSV: ${INPUT_FILE}`);
  const rows = await readCsvRows(INPUT_FILE);
  console.log(`Rows loaded: ${rows.length}`);

  const targetRows = DEDUPE_BY_IMAGE_URL ? dedupeRowsByImageUrl(rows) : rows;

  console.log(`Rows to test: ${targetRows.length}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Test first image URL: ${TEST_IMAGE ? 'YES' : 'NO'}`);
  console.log(`Dedupe by Image URL: ${DEDUPE_BY_IMAGE_URL ? 'YES' : 'NO'}`);

  const limit = pLimit(CONCURRENCY);
  let completed = 0;

  const tasks = targetRows.map((row, index) =>
    limit(async () => {
      const result = await testEndpoint(row, index + 1);
      completed += 1;

      if (completed % 25 === 0 || completed === targetRows.length) {
        console.log(
          `[${completed}/${targetRows.length}] lot=${result.lot_number || '-'} endpoint=${result.endpoint_status} time=${result.endpoint_time_ms}ms first=${result.first_test_image_url ? 'YES' : 'NO'} image=${result.image_test_status || '-'}`
        );
      }

      return result;
    })
  );

  const results = await Promise.all(tasks);
  const summary = buildSummary(
    results,
    startedAt,
    rows.length,
    DEDUPE_BY_IMAGE_URL ? targetRows.length : rows.length
  );

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  const reportCsvPath = path.resolve(`${OUTPUT_PREFIX}_report_${timestamp}.csv`);
  const firstPhotosCsvPath = path.resolve(`${OUTPUT_PREFIX}_first_photos_${timestamp}.csv`);
  const summaryJsonPath = path.resolve(`${OUTPUT_PREFIX}_summary_${timestamp}.json`);

  const csvHeaders = [
    'row_index',
    'lot_number',
    'yard_number',
    'image_url',
    'endpoint_status',
    'endpoint_time_ms',
    'endpoint_content_type',
    'json_ok',
    'img_count',
    'lot_images_count',
    'first_test_image_url',
    'first_thumb_url',
    'first_full_url',
    'first_hd_url',
    'error',
    'image_test_status',
    'image_test_time_ms',
    'image_test_content_type',
    'image_test_content_length',
    'image_test_error',
  ];

  const csvLines = [
    csvHeaders.join(','),
    ...results.map(r => csvHeaders.map(h => csvEscape(r[h])).join(',')),
  ];

  fs.writeFileSync(reportCsvPath, csvLines.join('\n'), 'utf8');

  const firstPhotoHeaders = [
    'lot_number',
    'yard_number',
    'image_url',
    'endpoint_status',
    'first_test_image_url',
    'first_thumb_url',
    'first_full_url',
    'first_hd_url',
  ];

  const firstPhotoLines = [
    firstPhotoHeaders.join(','),
    ...results.map(r => firstPhotoHeaders.map(h => csvEscape(r[h])).join(',')),
  ];

  fs.writeFileSync(firstPhotosCsvPath, firstPhotoLines.join('\n'), 'utf8');
  fs.writeFileSync(summaryJsonPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log('\n=== DONE ===');
  console.log(`Report CSV:       ${reportCsvPath}`);
  console.log(`First photos CSV: ${firstPhotosCsvPath}`);
  console.log(`Summary JSON:     ${summaryJsonPath}`);
  console.log('\nSummary:');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});