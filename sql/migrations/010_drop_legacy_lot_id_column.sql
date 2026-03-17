SET @drop_lot_id_column_sql = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = '{{CORE_DB}}'
        AND TABLE_NAME = 'lots'
        AND COLUMN_NAME = 'id'
    ),
    'ALTER TABLE `{{CORE_DB}}`.`lots` DROP COLUMN `id`',
    'SELECT 1'
  )
);

PREPARE stmt_drop_lot_id_column FROM @drop_lot_id_column_sql;
EXECUTE stmt_drop_lot_id_column;
DEALLOCATE PREPARE stmt_drop_lot_id_column;
