import crypto from "crypto";

function sortedObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => sortedObject(item));
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      result[key] = sortedObject(item);
    }
    return result;
  }

  return value;
}

export function hashObject(value: unknown, algorithm: string): string {
  const normalized = JSON.stringify(sortedObject(value));
  return crypto.createHash(algorithm).update(normalized).digest("hex");
}
