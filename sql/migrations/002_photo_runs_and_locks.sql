CREATE TABLE IF NOT EXISTS `{{CORE_DB}}`.`photo_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `status` ENUM('running', 'success', 'failed') NOT NULL,
  `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finished_at` DATETIME(3) DEFAULT NULL,
  `lots_scanned` INT UNSIGNED NOT NULL DEFAULT 0,
  `lots_processed` INT UNSIGNED NOT NULL DEFAULT 0,
  `lots_ok` INT UNSIGNED NOT NULL DEFAULT 0,
  `lots_partial` INT UNSIGNED NOT NULL DEFAULT 0,
  `lots_missing` INT UNSIGNED NOT NULL DEFAULT 0,
  `images_upserted` INT UNSIGNED NOT NULL DEFAULT 0,
  `images_full_size` INT UNSIGNED NOT NULL DEFAULT 0,
  `images_bad_quality` INT UNSIGNED NOT NULL DEFAULT 0,
  `http_404_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `deleted_lots_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `error_message` TEXT,
  `meta_json` JSON DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_status_started_at` (`status`, `started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `{{CORE_DB}}`.`app_locks` (
  `lock_name` VARCHAR(128) NOT NULL,
  `owner_id` VARCHAR(128) NOT NULL,
  `locked_until` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`lock_name`),
  KEY `idx_locked_until` (`locked_until`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
