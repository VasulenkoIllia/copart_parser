export function normalizeCopartLotImagesUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() === "inventoryv2.copart.io" && url.protocol === "http:") {
      url.protocol = "https:";
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}
