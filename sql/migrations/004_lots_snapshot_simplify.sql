ALTER TABLE `copart_core`.`lots`
  ADD COLUMN `ingest_run_id` BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER `row_hash`,
  DROP COLUMN `raw_payload`,
  DROP COLUMN `source_last_updated_at`,
  DROP COLUMN `source_created_at`,
  DROP COLUMN `deleted_at`,
  ADD KEY `idx_ingest_run_id` (`ingest_run_id`);
