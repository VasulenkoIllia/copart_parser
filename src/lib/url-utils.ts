interface NormalizeCopartUrlOptions {
  protocol?: "http" | "https";
}

export function normalizeCopartLotImagesUrl(
  value: string | null | undefined,
  options: NormalizeCopartUrlOptions = {}
): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() === "inventoryv2.copart.io" && options.protocol) {
      url.protocol = `${options.protocol}:`;
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}
