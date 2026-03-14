CREATE TABLE IF NOT EXISTS `{{CORE_DB}}`.`photo_cluster_runs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `status` ENUM('running', 'success', 'failed') NOT NULL,
  `started_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `finished_at` DATETIME(3) DEFAULT NULL,
  `worker_total` INT UNSIGNED NOT NULL DEFAULT 0,
  `workers_finished` INT UNSIGNED NOT NULL DEFAULT 0,
  `workers_succeeded` INT UNSIGNED NOT NULL DEFAULT 0,
  `workers_failed` INT UNSIGNED NOT NULL DEFAULT 0,
  `total_lots_scanned` INT UNSIGNED NOT NULL DEFAULT 0,
  `total_lots_processed` INT UNSIGNED NOT NULL DEFAULT 0,
  `total_lots_ok` INT UNSIGNED NOT NULL DEFAULT 0,
  `total_lots_missing` INT UNSIGNED NOT NULL DEFAULT 0,
  `total_images_upserted` INT UNSIGNED NOT NULL DEFAULT 0,
  `total_images_full_size` INT UNSIGNED NOT NULL DEFAULT 0,
  `total_images_bad_quality` INT UNSIGNED NOT NULL DEFAULT 0,
  `total_http_404_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `error_message` TEXT,
  `meta_json` JSON DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_status_started_at` (`status`, `started_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `{{CORE_DB}}`.`photo_runs`
  ADD COLUMN `cluster_run_id` BIGINT UNSIGNED NULL AFTER `id`,
  ADD COLUMN `worker_index` INT UNSIGNED NULL AFTER `cluster_run_id`,
  ADD COLUMN `worker_total` INT UNSIGNED NULL AFTER `worker_index`,
  ADD KEY `idx_cluster_run_id` (`cluster_run_id`),
  ADD KEY `idx_cluster_worker` (`cluster_run_id`, `worker_index`);
