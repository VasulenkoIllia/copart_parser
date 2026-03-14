CREATE TABLE IF NOT EXISTS `{{CORE_DB}}`.`invalid_csv_rows` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ingest_run_id` BIGINT UNSIGNED NOT NULL,
  `source` VARCHAR(32) NOT NULL,
  `line_number` INT UNSIGNED DEFAULT NULL,
  `reason` VARCHAR(1024) NOT NULL,
  `occurrences` INT UNSIGNED NOT NULL DEFAULT 1,
  `raw` LONGTEXT,
  `record_json` LONGTEXT,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_ingest_run_id` (`ingest_run_id`),
  KEY `idx_line_number` (`line_number`),
  KEY `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
