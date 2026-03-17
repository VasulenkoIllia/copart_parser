SET SESSION group_concat_max_len = 1000000;

CREATE TEMPORARY TABLE `_lot_materialized_columns` (
  `column_name` VARCHAR(128) NOT NULL,
  PRIMARY KEY (`column_name`)
) ENGINE=Memory;

INSERT INTO `_lot_materialized_columns` (`column_name`) VALUES
  ('yard_name'),
  ('sale_date'),
  ('day_of_week'),
  ('sale_time'),
  ('time_zone'),
  ('item_number'),
  ('vehicle_type'),
  ('year'),
  ('make'),
  ('model_group'),
  ('model_detail'),
  ('body_style'),
  ('color'),
  ('damage_description'),
  ('secondary_damage'),
  ('sale_title_state'),
  ('sale_title_type'),
  ('has_keys'),
  ('lot_cond_code'),
  ('vin'),
  ('odometer'),
  ('odometer_brand'),
  ('est_retail_value'),
  ('repair_cost'),
  ('engine'),
  ('drive'),
  ('transmission'),
  ('fuel_type'),
  ('cylinders'),
  ('runs_drives'),
  ('sale_status'),
  ('high_bid'),
  ('special_note'),
  ('location_city'),
  ('location_state'),
  ('location_zip'),
  ('location_country'),
  ('currency_code'),
  ('image_thumbnail'),
  ('create_date_time'),
  ('grid_row'),
  ('make_an_offer_eligible'),
  ('buy_it_now_price'),
  ('imageurl'),
  ('trim'),
  ('last_updated_time'),
  ('rentals'),
  ('wholesale'),
  ('seller_name'),
  ('offsite_address1'),
  ('offsite_state'),
  ('offsite_city'),
  ('offsite_zip'),
  ('sale_light'),
  ('auto_grade'),
  ('announcements');

SET @add_missing_lot_columns_sql = (
  SELECT IFNULL(
    CONCAT(
      'ALTER TABLE `{{CORE_DB}}`.`lots` ',
      GROUP_CONCAT(
        CONCAT(
          'ADD COLUMN `',
          REPLACE(c.`column_name`, '`', '``'),
          '` TEXT NULL'
        )
        ORDER BY c.`column_name`
        SEPARATOR ', '
      )
    ),
    'SELECT 1'
  )
  FROM `_lot_materialized_columns` c
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.COLUMNS ic
    WHERE ic.TABLE_SCHEMA = '{{CORE_DB}}'
      AND ic.TABLE_NAME = 'lots'
      AND ic.COLUMN_NAME = c.`column_name`
  )
);
PREPARE stmt_add_missing_lot_columns FROM @add_missing_lot_columns_sql;
EXECUTE stmt_add_missing_lot_columns;
DEALLOCATE PREPARE stmt_add_missing_lot_columns;

DROP TEMPORARY TABLE `_lot_materialized_columns`;
