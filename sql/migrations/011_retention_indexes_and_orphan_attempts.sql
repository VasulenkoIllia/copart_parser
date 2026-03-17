SET @add_photo_fetch_attempts_attempted_at_index = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = '{{MEDIA_DB}}'
        AND TABLE_NAME = 'photo_fetch_attempts'
        AND INDEX_NAME = 'idx_attempted_at_id'
    ),
    'SELECT 1',
    'ALTER TABLE `{{MEDIA_DB}}`.`photo_fetch_attempts`
       ADD KEY `idx_attempted_at_id` (`attempted_at`, `id`)'
  )
);
PREPARE stmt_add_photo_fetch_attempts_attempted_at_index FROM @add_photo_fetch_attempts_attempted_at_index;
EXECUTE stmt_add_photo_fetch_attempts_attempted_at_index;
DEALLOCATE PREPARE stmt_add_photo_fetch_attempts_attempted_at_index;

SET @add_ingest_runs_finished_at_index = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = '{{CORE_DB}}'
        AND TABLE_NAME = 'ingest_runs'
        AND INDEX_NAME = 'idx_status_finished_at'
    ),
    'SELECT 1',
    'ALTER TABLE `{{CORE_DB}}`.`ingest_runs`
       ADD KEY `idx_status_finished_at` (`status`, `finished_at`, `id`)'
  )
);
PREPARE stmt_add_ingest_runs_finished_at_index FROM @add_ingest_runs_finished_at_index;
EXECUTE stmt_add_ingest_runs_finished_at_index;
DEALLOCATE PREPARE stmt_add_ingest_runs_finished_at_index;

SET @add_photo_runs_finished_at_index = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = '{{CORE_DB}}'
        AND TABLE_NAME = 'photo_runs'
        AND INDEX_NAME = 'idx_status_finished_at'
    ),
    'SELECT 1',
    'ALTER TABLE `{{CORE_DB}}`.`photo_runs`
       ADD KEY `idx_status_finished_at` (`status`, `finished_at`, `id`)'
  )
);
PREPARE stmt_add_photo_runs_finished_at_index FROM @add_photo_runs_finished_at_index;
EXECUTE stmt_add_photo_runs_finished_at_index;
DEALLOCATE PREPARE stmt_add_photo_runs_finished_at_index;

SET @add_photo_cluster_runs_finished_at_index = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = '{{CORE_DB}}'
        AND TABLE_NAME = 'photo_cluster_runs'
        AND INDEX_NAME = 'idx_status_finished_at'
    ),
    'SELECT 1',
    'ALTER TABLE `{{CORE_DB}}`.`photo_cluster_runs`
       ADD KEY `idx_status_finished_at` (`status`, `finished_at`, `id`)'
  )
);
PREPARE stmt_add_photo_cluster_runs_finished_at_index FROM @add_photo_cluster_runs_finished_at_index;
EXECUTE stmt_add_photo_cluster_runs_finished_at_index;
DEALLOCATE PREPARE stmt_add_photo_cluster_runs_finished_at_index;
