import env from "../../config/env";
import { hashObject } from "../../lib/hash";
import { normalizeCopartLotImagesUrl } from "../../lib/url-utils";
import { isRowChangeExcludedField } from "./row-change-exclusions";
import { CsvRecord, IngestCandidate } from "./types";

function pickFirst(record: CsvRecord, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function parseOptionalInt(value: string): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeRecord(record: Record<string, unknown>): CsvRecord {
  const normalized: CsvRecord = {};
  for (const [key, value] of Object.entries(record)) {
    normalized[String(key)] = value === undefined || value === null ? "" : String(value).trim();
  }
  return normalized;
}

function buildHashPayload(record: CsvRecord): CsvRecord {
  const payload: CsvRecord = {};
  for (const [key, value] of Object.entries(record)) {
    if (isRowChangeExcludedField(key)) {
      continue;
    }
    payload[key] = value;
  }
  return payload;
}

export function mapCsvRow(record: Record<string, unknown>): IngestCandidate | null {
  const normalized = normalizeRecord(record);

  const lotNumberRaw = pickFirst(normalized, [
    "Lot number",
    "lot_number",
    "lot number",
    "lotNumber",
  ]);
  const lotNumber = parseOptionalInt(lotNumberRaw);
  if (!lotNumber) {
    return null;
  }

  const yardNumberRaw = pickFirst(normalized, ["Yard number", "yard_number", "yard number"]);
  const imageUrlRaw = pickFirst(normalized, ["Image URL", "imageurl", "image_url"]);
  const yardNumber = parseOptionalInt(yardNumberRaw);
  const hashPayload = buildHashPayload(normalized);

  return {
    lotNumber,
    yardNumber,
    imageUrl: normalizeCopartLotImagesUrl(imageUrlRaw, {
      protocol: "https",
      defaultCountry: "us",
      defaultBrand: "cprt",
      yardNumber,
      defaultYardNumber: 1,
    }),
    rowHash: hashObject(hashPayload, env.ingest.rowHashAlgo),
    csvPayload: normalized,
  };
}
