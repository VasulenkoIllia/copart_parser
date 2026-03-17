SET @add_url_hash_column_sql = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = '{{MEDIA_DB}}'
        AND TABLE_NAME = 'lot_images'
        AND COLUMN_NAME = 'url_hash'
    ),
    'SELECT 1',
    'ALTER TABLE `{{MEDIA_DB}}`.`lot_images` ADD COLUMN `url_hash` CHAR(64) NULL AFTER `url`'
  )
);
PREPARE stmt_add_url_hash_column FROM @add_url_hash_column_sql;
EXECUTE stmt_add_url_hash_column;
DEALLOCATE PREPARE stmt_add_url_hash_column;

UPDATE `{{MEDIA_DB}}`.`lot_images`
SET `url_hash` = SHA2(`url`, 256)
WHERE `url_hash` IS NULL;

DELETE FROM `{{MEDIA_DB}}`.`lot_images`
WHERE id IN (
  SELECT id
  FROM (
    SELECT li_old.id
    FROM `{{MEDIA_DB}}`.`lot_images` li_old
    JOIN `{{MEDIA_DB}}`.`lot_images` li_new
      ON li_old.lot_number = li_new.lot_number
      AND li_old.sequence = li_new.sequence
      AND li_old.url_hash = li_new.url_hash
      AND li_old.id < li_new.id
  ) dedup_ids
);

ALTER TABLE `{{MEDIA_DB}}`.`lot_images`
  MODIFY COLUMN `url_hash` CHAR(64) NOT NULL;

SET @drop_legacy_index_sql = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = '{{MEDIA_DB}}'
        AND TABLE_NAME = 'lot_images'
        AND INDEX_NAME = 'uq_lot_sequence_variant'
    ),
    'ALTER TABLE `{{MEDIA_DB}}`.`lot_images` DROP INDEX `uq_lot_sequence_variant`',
    'SELECT 1'
  )
);
PREPARE stmt_drop_legacy_index FROM @drop_legacy_index_sql;
EXECUTE stmt_drop_legacy_index;
DEALLOCATE PREPARE stmt_drop_legacy_index;

SET @add_hash_unique_sql = (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = '{{MEDIA_DB}}'
        AND TABLE_NAME = 'lot_images'
        AND INDEX_NAME = 'uq_lot_sequence_url_hash'
    ),
    'SELECT 1',
    'ALTER TABLE `{{MEDIA_DB}}`.`lot_images` ADD UNIQUE KEY `uq_lot_sequence_url_hash` (`lot_number`, `sequence`, `url_hash`)'
  )
);
PREPARE stmt_add_hash_unique FROM @add_hash_unique_sql;
EXECUTE stmt_add_hash_unique;
DEALLOCATE PREPARE stmt_add_hash_unique;
