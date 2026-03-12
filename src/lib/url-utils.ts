interface NormalizeCopartUrlOptions {
  protocol?: "http" | "https";
  defaultCountry?: string;
  defaultBrand?: string;
  yardNumber?: number | null;
  defaultYardNumber?: number | null;
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
    const isInventoryV2 = url.hostname.toLowerCase() === "inventoryv2.copart.io";
    if (isInventoryV2 && options.protocol) {
      url.protocol = `${options.protocol}:`;
    }

    if (isInventoryV2) {
      const country = options.defaultCountry?.trim();
      const brand = options.defaultBrand?.trim();
      const yardCandidate =
        options.yardNumber !== null && options.yardNumber !== undefined
          ? options.yardNumber
          : options.defaultYardNumber;
      const yard =
        typeof yardCandidate === "number" && Number.isFinite(yardCandidate) && yardCandidate > 0
          ? Math.floor(yardCandidate)
          : null;

      if (country && !url.searchParams.has("country")) {
        url.searchParams.set("country", country);
      }
      if (brand && !url.searchParams.has("brand")) {
        url.searchParams.set("brand", brand);
      }
      if (yard !== null && !url.searchParams.has("yardNumber")) {
        url.searchParams.set("yardNumber", String(yard));
      }
    }
    return url.toString();
  } catch {
    return trimmed;
  }
}
