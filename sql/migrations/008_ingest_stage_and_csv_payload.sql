ALTER TABLE `{{CORE_DB}}`.`lots`
  ADD COLUMN `csv_payload` JSON NULL AFTER `row_hash`;

UPDATE `{{CORE_DB}}`.`lots`
SET `csv_payload` = JSON_OBJECT()
WHERE `csv_payload` IS NULL;

ALTER TABLE `{{CORE_DB}}`.`lots`
  MODIFY COLUMN `csv_payload` JSON NOT NULL;

CREATE TABLE IF NOT EXISTS `{{CORE_DB}}`.`ingest_lot_stage` (
  `lot_number` BIGINT UNSIGNED NOT NULL,
  `seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`lot_number`),
  KEY `idx_seen_at` (`seen_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
