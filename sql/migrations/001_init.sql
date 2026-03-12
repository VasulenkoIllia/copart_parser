CREATE TABLE IF NOT EXISTS `copart_core`.`schema_migrations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `file_name` VARCHAR(255) NOT NULL,
  `applied_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_file_name` (`file_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `copart_core`.`ingest_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `run_type` VARCHAR(32) NOT NULL DEFAULT 'csv_ingest',
  `status` ENUM('running', 'success', 'failed') NOT NULL,
  `source_url` VARCHAR(1024) NOT NULL,
  `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finished_at` DATETIME(3) DEFAULT NULL,
  `rows_total` INT UNSIGNED NOT NULL DEFAULT 0,
  `rows_valid` INT UNSIGNED NOT NULL DEFAULT 0,
  `rows_invalid` INT UNSIGNED NOT NULL DEFAULT 0,
  `rows_inserted` INT UNSIGNED NOT NULL DEFAULT 0,
  `rows_updated` INT UNSIGNED NOT NULL DEFAULT 0,
  `rows_unchanged` INT UNSIGNED NOT NULL DEFAULT 0,
  `error_message` TEXT,
  `meta_json` JSON DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_status_started_at` (`status`, `started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `copart_core`.`lots` (
  `lot_number` BIGINT UNSIGNED NOT NULL,
  `yard_number` INT UNSIGNED DEFAULT NULL,
  `image_url` VARCHAR(1024) DEFAULT NULL,
  `raw_payload` JSON NOT NULL,
  `row_hash` CHAR(64) NOT NULL,
  `source_last_updated_at` DATETIME DEFAULT NULL,
  `source_created_at` DATETIME DEFAULT NULL,
  `first_seen_at` DATETIME(3) NOT NULL,
  `last_seen_at` DATETIME(3) NOT NULL,
  `photo_status` ENUM('unknown', 'ok', 'partial', 'missing') NOT NULL DEFAULT 'unknown',
  `photo_404_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `photo_404_since` DATETIME DEFAULT NULL,
  `next_photo_retry_at` DATETIME DEFAULT NULL,
  `last_photo_check_at` DATETIME DEFAULT NULL,
  `deleted_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`lot_number`),
  KEY `idx_last_seen_at` (`last_seen_at`),
  KEY `idx_photo_retry` (`photo_status`, `next_photo_retry_at`),
  KEY `idx_deleted_at` (`deleted_at`),
  KEY `idx_row_hash` (`row_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `copart_media`.`lot_images` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `lot_number` BIGINT UNSIGNED NOT NULL,
  `sequence` INT UNSIGNED NOT NULL DEFAULT 0,
  `variant` ENUM('thumb', 'full', 'hd', 'video', 'unknown') NOT NULL DEFAULT 'unknown',
  `url` VARCHAR(1024) NOT NULL,
  `http_status` SMALLINT UNSIGNED DEFAULT NULL,
  `content_type` VARCHAR(255) DEFAULT NULL,
  `content_length` BIGINT UNSIGNED DEFAULT NULL,
  `width` INT UNSIGNED DEFAULT NULL,
  `height` INT UNSIGNED DEFAULT NULL,
  `is_full_size` TINYINT(1) NOT NULL DEFAULT 0,
  `check_status` ENUM('pending', 'ok', 'not_found', 'bad_quality', 'error') NOT NULL DEFAULT 'pending',
  `last_checked_at` DATETIME DEFAULT NULL,
  `first_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_lot_sequence_variant` (`lot_number`, `sequence`, `variant`),
  KEY `idx_lot_number` (`lot_number`),
  KEY `idx_check_status` (`check_status`, `last_checked_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `copart_media`.`photo_fetch_attempts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `lot_number` BIGINT UNSIGNED NOT NULL,
  `url` VARCHAR(1024) DEFAULT NULL,
  `attempt_type` ENUM('lot_images_endpoint', 'image_head', 'image_get') NOT NULL,
  `http_status` SMALLINT UNSIGNED DEFAULT NULL,
  `error_code` VARCHAR(128) DEFAULT NULL,
  `error_message` VARCHAR(1024) DEFAULT NULL,
  `attempted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `idx_lot_attempted_at` (`lot_number`, `attempted_at`),
  KEY `idx_http_status` (`http_status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
