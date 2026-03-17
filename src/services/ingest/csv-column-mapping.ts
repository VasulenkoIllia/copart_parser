interface CsvColumnResolution {
  column: string;
  usesCoreColumn: boolean;
  skipColumn: boolean;
}

interface CsvColumnSpec {
  column: string;
  usesCoreColumn?: boolean;
  skipColumn?: boolean;
}

const KNOWN_CSV_COLUMN_SPECS = new Map<string, CsvColumnSpec>([
  ["id", { column: "", skipColumn: true }],
  ["yard number", { column: "yard_number", usesCoreColumn: true }],
  ["yard name", { column: "yard_name" }],
  ["sale date m/d/cy", { column: "sale_date" }],
  ["day of week", { column: "day_of_week" }],
  ["sale time (hhmm)", { column: "sale_time" }],
  ["time zone", { column: "time_zone" }],
  ["item#", { column: "item_number" }],
  ["lot number", { column: "lot_number", usesCoreColumn: true }],
  ["vehicle type", { column: "vehicle_type" }],
  ["year", { column: "year" }],
  ["make", { column: "make" }],
  ["model group", { column: "model_group" }],
  ["model detail", { column: "model_detail" }],
  ["body style", { column: "body_style" }],
  ["color", { column: "color" }],
  ["damage description", { column: "damage_description" }],
  ["secondary damage", { column: "secondary_damage" }],
  ["sale title state", { column: "sale_title_state" }],
  ["sale title type", { column: "sale_title_type" }],
  ["has keys-yes or no", { column: "has_keys" }],
  ["lot cond. code", { column: "lot_cond_code" }],
  ["vin", { column: "vin" }],
  ["odometer", { column: "odometer" }],
  ["odometer brand", { column: "odometer_brand" }],
  ["est. retail value", { column: "est_retail_value" }],
  ["repair cost", { column: "repair_cost" }],
  ["engine", { column: "engine" }],
  ["drive", { column: "drive" }],
  ["transmission", { column: "transmission" }],
  ["fuel type", { column: "fuel_type" }],
  ["cylinders", { column: "cylinders" }],
  ["runs/drives", { column: "runs_drives" }],
  ["sale status", { column: "sale_status" }],
  ["high bid =non-vix,sealed=vix", { column: "high_bid" }],
  ["special note", { column: "special_note" }],
  ["location city", { column: "location_city" }],
  ["location state", { column: "location_state" }],
  ["location zip", { column: "location_zip" }],
  ["location country", { column: "location_country" }],
  ["currency code", { column: "currency_code" }],
  ["image thumbnail", { column: "image_thumbnail" }],
  ["create date/time", { column: "create_date_time" }],
  ["grid/row", { column: "grid_row" }],
  ["make-an-offer eligible", { column: "make_an_offer_eligible" }],
  ["buy-it-now price", { column: "buy_it_now_price" }],
  ["image url", { column: "imageurl" }],
  ["trim", { column: "trim" }],
  ["last updated time", { column: "last_updated_time" }],
  ["rentals", { column: "rentals" }],
  ["wholesale", { column: "wholesale" }],
  ["seller name", { column: "seller_name" }],
  ["offsite address1", { column: "offsite_address1" }],
  ["offsite state", { column: "offsite_state" }],
  ["offsite city", { column: "offsite_city" }],
  ["offsite zip", { column: "offsite_zip" }],
  ["sale light", { column: "sale_light" }],
  ["autograde", { column: "auto_grade" }],
  ["announcements", { column: "announcements" }],
]);

function normalizeCsvFieldLookupKey(field: string): string {
  return field
    .replace(/\u0000/g, "")
    .replace(/\r?\n/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function fallbackCsvFieldToSnakeCase(field: string): string {
  const normalized = field
    .replace(/\u0000/g, "")
    .replace(/\r?\n/g, " ")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toLowerCase();

  return normalized || "field";
}

export function resolveCsvFieldColumn(field: string): CsvColumnResolution {
  const normalized = normalizeCsvFieldLookupKey(field);
  const known = KNOWN_CSV_COLUMN_SPECS.get(normalized);
  const resolution: CsvColumnResolution = known
    ? {
        column: known.column,
        usesCoreColumn: Boolean(known.usesCoreColumn),
        skipColumn: Boolean(known.skipColumn),
      }
    : {
        column: `csv_${fallbackCsvFieldToSnakeCase(field)}`,
        usesCoreColumn: false,
        skipColumn: false,
      };

  if (resolution.skipColumn) {
    return resolution;
  }

  if (resolution.column.length > 64) {
    throw new Error(`CSV header is too long for MySQL column name: "${field}"`);
  }

  return resolution;
}
