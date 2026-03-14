UPDATE `{{CORE_DB}}`.`lots`
SET
  `photo_status` = 'missing',
  `next_photo_retry_at` = COALESCE(`next_photo_retry_at`, CURRENT_TIMESTAMP(3))
WHERE `photo_status` = 'partial';

ALTER TABLE `{{CORE_DB}}`.`lots`
  MODIFY COLUMN `photo_status` ENUM('unknown', 'ok', 'missing') NOT NULL DEFAULT 'unknown';

ALTER TABLE `{{CORE_DB}}`.`photo_runs`
  DROP COLUMN `lots_partial`;
