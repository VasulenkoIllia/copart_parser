import env from "../../config/env";
import { hashObject } from "../../lib/hash";
import { normalizeCopartLotImagesUrl } from "../../lib/url-utils";
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

function parseCreatedAt(value: string): Date | null {
  if (!value) {
    return null;
  }

  const isoDate = new Date(value);
  if (!Number.isNaN(isoDate.getTime())) {
    return isoDate;
  }

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})-(\d{2})\.(\d{2})\.(\d{2})\.(\d{6})$/
  );
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second, micros] = match;
  const millis = Number.parseInt(micros.slice(0, 3), 10);
  const asUtc = Date.UTC(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    Number.parseInt(hour, 10),
    Number.parseInt(minute, 10),
    Number.parseInt(second, 10),
    millis
  );

  return new Date(asUtc);
}

function normalizeRecord(record: Record<string, unknown>): CsvRecord {
  const normalized: CsvRecord = {};
  for (const [key, value] of Object.entries(record)) {
    normalized[String(key)] = value === undefined || value === null ? "" : String(value).trim();
  }
  return normalized;
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
  const sourceLastUpdatedRaw = pickFirst(normalized, [
    "Last Updated Time",
    "last_updated_time",
    "lastUpdatedTime",
  ]);
  const sourceCreatedRaw = pickFirst(normalized, [
    "Create Date Time",
    "create_date_time",
    "createDateTime",
  ]);

  const sourceLastUpdatedAt = sourceLastUpdatedRaw ? new Date(sourceLastUpdatedRaw) : null;
  const sourceCreatedAt = parseCreatedAt(sourceCreatedRaw);

  return {
    lotNumber,
    yardNumber: parseOptionalInt(yardNumberRaw),
    imageUrl: normalizeCopartLotImagesUrl(imageUrlRaw),
    sourceLastUpdatedAt:
      sourceLastUpdatedAt && !Number.isNaN(sourceLastUpdatedAt.getTime())
        ? sourceLastUpdatedAt
        : null,
    sourceCreatedAt,
    rowHash: hashObject(normalized, env.ingest.rowHashAlgo),
    rawPayload: normalized,
  };
}
