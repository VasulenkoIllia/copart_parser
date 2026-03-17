const ROW_CHANGE_EXCLUDED_FIELDS = new Set([
  "id",
  "createdatetime",
  "lastupdatedtime",
]);

export function normalizeExcludedCsvFieldName(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function isRowChangeExcludedField(key: string): boolean {
  return ROW_CHANGE_EXCLUDED_FIELDS.has(normalizeExcludedCsvFieldName(key));
}
