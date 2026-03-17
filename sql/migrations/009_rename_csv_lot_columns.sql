SET SESSION group_concat_max_len = 1000000;

CREATE TEMPORARY TABLE `_lot_column_rename_map` (
  `old_name` VARCHAR(128) NOT NULL,
  `new_name` VARCHAR(128) NOT NULL,
  `mode` ENUM('rename', 'drop_to_core') NOT NULL,
  PRIMARY KEY (`old_name`)
) ENGINE=Memory;

INSERT INTO `_lot_column_rename_map` (`old_name`, `new_name`, `mode`) VALUES
  ('csv_Id', 'id', 'rename'),
  ('csv_Yard number', 'yard_number', 'drop_to_core'),
  ('csv_Yard name', 'yard_name', 'rename'),
  ('csv_Sale Date M/D/CY', 'sale_date', 'rename'),
  ('csv_Day of Week', 'day_of_week', 'rename'),
  ('csv_Sale time (HHMM)', 'sale_time', 'rename'),
  ('csv_Time Zone', 'time_zone', 'rename'),
  ('csv_Item#', 'item_number', 'rename'),
  ('csv_Lot number', 'lot_number', 'drop_to_core'),
  ('csv_Vehicle Type', 'vehicle_type', 'rename'),
  ('csv_Year', 'year', 'rename'),
  ('csv_Make', 'make', 'rename'),
  ('csv_Model Group', 'model_group', 'rename'),
  ('csv_Model Detail', 'model_detail', 'rename'),
  ('csv_Body Style', 'body_style', 'rename'),
  ('csv_Color', 'color', 'rename'),
  ('csv_Damage Description', 'damage_description', 'rename'),
  ('csv_Secondary Damage', 'secondary_damage', 'rename'),
  ('csv_Sale Title State', 'sale_title_state', 'rename'),
  ('csv_Sale Title Type', 'sale_title_type', 'rename'),
  ('csv_Has Keys-Yes or No', 'has_keys', 'rename'),
  ('csv_Lot Cond. Code', 'lot_cond_code', 'rename'),
  ('csv_VIN', 'vin', 'rename'),
  ('csv_Odometer', 'odometer', 'rename'),
  ('csv_Odometer Brand', 'odometer_brand', 'rename'),
  ('csv_Est. Retail Value', 'est_retail_value', 'rename'),
  ('csv_Repair cost', 'repair_cost', 'rename'),
  ('csv_Engine', 'engine', 'rename'),
  ('csv_Drive', 'drive', 'rename'),
  ('csv_Transmission', 'transmission', 'rename'),
  ('csv_Fuel Type', 'fuel_type', 'rename'),
  ('csv_Cylinders', 'cylinders', 'rename'),
  ('csv_Runs/Drives', 'runs_drives', 'rename'),
  ('csv_Sale Status', 'sale_status', 'rename'),
  ('csv_High Bid =non-vix,Sealed=Vix', 'high_bid', 'rename'),
  ('csv_Special Note', 'special_note', 'rename'),
  ('csv_Location city', 'location_city', 'rename'),
  ('csv_Location state', 'location_state', 'rename'),
  ('csv_Location ZIP', 'location_zip', 'rename'),
  ('csv_Location country', 'location_country', 'rename'),
  ('csv_Currency Code', 'currency_code', 'rename'),
  ('csv_Image Thumbnail', 'image_thumbnail', 'rename'),
  ('csv_Create Date/Time', 'create_date_time', 'rename'),
  ('csv_Grid/Row', 'grid_row', 'rename'),
  ('csv_Make-an-Offer Eligible', 'make_an_offer_eligible', 'rename'),
  ('csv_Buy-It-Now Price', 'buy_it_now_price', 'rename'),
  ('csv_Image URL', 'imageurl', 'rename'),
  ('csv_Trim', 'trim', 'rename'),
  ('csv_Last Updated Time', 'last_updated_time', 'rename'),
  ('csv_Rentals', 'rentals', 'rename'),
  ('csv_Wholesale', 'wholesale', 'rename'),
  ('csv_Seller Name', 'seller_name', 'rename'),
  ('csv_Offsite Address1', 'offsite_address1', 'rename'),
  ('csv_Offsite State', 'offsite_state', 'rename'),
  ('csv_Offsite City', 'offsite_city', 'rename'),
  ('csv_Offsite Zip', 'offsite_zip', 'rename'),
  ('csv_Sale Light', 'sale_light', 'rename'),
  ('csv_AutoGrade', 'auto_grade', 'rename'),
  ('csv_Announcements', 'announcements', 'rename');

SET @merge_renamed_columns_sql = (
  SELECT IFNULL(
    CONCAT(
      'UPDATE `{{CORE_DB}}`.`lots` SET ',
      GROUP_CONCAT(
        CONCAT(
          '`', REPLACE(`new_name`, '`', '``'), '` = COALESCE(`',
          REPLACE(`new_name`, '`', '``'), '`, `',
          REPLACE(`old_name`, '`', '``'), '`)'
        )
        ORDER BY `old_name`
        SEPARATOR ', '
      )
    ),
    'SELECT 1'
  )
  FROM `_lot_column_rename_map` m
  WHERE m.`mode` = 'rename'
    AND EXISTS (
      SELECT 1
      FROM information_schema.COLUMNS c
      WHERE c.TABLE_SCHEMA = '{{CORE_DB}}'
        AND c.TABLE_NAME = 'lots'
        AND c.COLUMN_NAME = m.`old_name`
    )
    AND EXISTS (
      SELECT 1
      FROM information_schema.COLUMNS c
      WHERE c.TABLE_SCHEMA = '{{CORE_DB}}'
        AND c.TABLE_NAME = 'lots'
        AND c.COLUMN_NAME = m.`new_name`
    )
);
PREPARE stmt_merge_renamed_columns FROM @merge_renamed_columns_sql;
EXECUTE stmt_merge_renamed_columns;
DEALLOCATE PREPARE stmt_merge_renamed_columns;

SET @rename_columns_sql = (
  SELECT IFNULL(
    CONCAT(
      'ALTER TABLE `{{CORE_DB}}`.`lots` ',
      GROUP_CONCAT(
        CONCAT(
          'CHANGE COLUMN `', REPLACE(`old_name`, '`', '``'), '` `',
          REPLACE(`new_name`, '`', '``'), '` TEXT NULL'
        )
        ORDER BY `old_name`
        SEPARATOR ', '
      )
    ),
    'SELECT 1'
  )
  FROM `_lot_column_rename_map` m
  WHERE m.`mode` = 'rename'
    AND EXISTS (
      SELECT 1
      FROM information_schema.COLUMNS c
      WHERE c.TABLE_SCHEMA = '{{CORE_DB}}'
        AND c.TABLE_NAME = 'lots'
        AND c.COLUMN_NAME = m.`old_name`
    )
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.COLUMNS c
      WHERE c.TABLE_SCHEMA = '{{CORE_DB}}'
        AND c.TABLE_NAME = 'lots'
        AND c.COLUMN_NAME = m.`new_name`
    )
);
PREPARE stmt_rename_columns FROM @rename_columns_sql;
EXECUTE stmt_rename_columns;
DEALLOCATE PREPARE stmt_rename_columns;

SET @drop_legacy_renamed_columns_sql = (
  SELECT IFNULL(
    CONCAT(
      'ALTER TABLE `{{CORE_DB}}`.`lots` ',
      GROUP_CONCAT(
        CONCAT('DROP COLUMN `', REPLACE(`old_name`, '`', '``'), '`')
        ORDER BY `old_name`
        SEPARATOR ', '
      )
    ),
    'SELECT 1'
  )
  FROM `_lot_column_rename_map` m
  WHERE m.`mode` = 'rename'
    AND EXISTS (
      SELECT 1
      FROM information_schema.COLUMNS c
      WHERE c.TABLE_SCHEMA = '{{CORE_DB}}'
        AND c.TABLE_NAME = 'lots'
        AND c.COLUMN_NAME = m.`old_name`
    )
    AND EXISTS (
      SELECT 1
      FROM information_schema.COLUMNS c
      WHERE c.TABLE_SCHEMA = '{{CORE_DB}}'
        AND c.TABLE_NAME = 'lots'
        AND c.COLUMN_NAME = m.`new_name`
    )
);
PREPARE stmt_drop_legacy_renamed_columns FROM @drop_legacy_renamed_columns_sql;
EXECUTE stmt_drop_legacy_renamed_columns;
DEALLOCATE PREPARE stmt_drop_legacy_renamed_columns;

SET @backfill_yard_number_sql = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.COLUMNS c
      WHERE c.TABLE_SCHEMA = '{{CORE_DB}}'
        AND c.TABLE_NAME = 'lots'
        AND c.COLUMN_NAME = 'csv_Yard number'
    ),
    'UPDATE `{{CORE_DB}}`.`lots`
     SET `yard_number` = CASE
       WHEN `yard_number` IS NULL AND TRIM(COALESCE(`csv_Yard number`, '''')) REGEXP ''^[0-9]+$''
         THEN CAST(TRIM(`csv_Yard number`) AS UNSIGNED)
       ELSE `yard_number`
     END',
    'SELECT 1'
  )
);
PREPARE stmt_backfill_yard_number FROM @backfill_yard_number_sql;
EXECUTE stmt_backfill_yard_number;
DEALLOCATE PREPARE stmt_backfill_yard_number;

SET @drop_legacy_core_columns_sql = (
  SELECT IFNULL(
    CONCAT(
      'ALTER TABLE `{{CORE_DB}}`.`lots` ',
      GROUP_CONCAT(
        CONCAT('DROP COLUMN `', REPLACE(`old_name`, '`', '``'), '`')
        ORDER BY `old_name`
        SEPARATOR ', '
      )
    ),
    'SELECT 1'
  )
  FROM `_lot_column_rename_map` m
  WHERE m.`mode` = 'drop_to_core'
    AND EXISTS (
      SELECT 1
      FROM information_schema.COLUMNS c
      WHERE c.TABLE_SCHEMA = '{{CORE_DB}}'
        AND c.TABLE_NAME = 'lots'
        AND c.COLUMN_NAME = m.`old_name`
    )
);
PREPARE stmt_drop_legacy_core_columns FROM @drop_legacy_core_columns_sql;
EXECUTE stmt_drop_legacy_core_columns;
DEALLOCATE PREPARE stmt_drop_legacy_core_columns;

DROP TEMPORARY TABLE `_lot_column_rename_map`;
