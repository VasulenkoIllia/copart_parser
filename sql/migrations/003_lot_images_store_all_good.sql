ALTER TABLE `copart_media`.`lot_images`
  ADD COLUMN `url_hash` CHAR(64) NULL AFTER `url`;

UPDATE `copart_media`.`lot_images`
SET `url_hash` = SHA2(`url`, 256)
WHERE `url_hash` IS NULL;

DELETE FROM `copart_media`.`lot_images`
WHERE id IN (
  SELECT id
  FROM (
    SELECT li_old.id
    FROM `copart_media`.`lot_images` li_old
    JOIN `copart_media`.`lot_images` li_new
      ON li_old.lot_number = li_new.lot_number
      AND li_old.sequence = li_new.sequence
      AND li_old.url_hash = li_new.url_hash
      AND li_old.id < li_new.id
  ) dedup_ids
);

ALTER TABLE `copart_media`.`lot_images`
  DROP INDEX `uq_lot_sequence_variant`,
  MODIFY COLUMN `url_hash` CHAR(64) NOT NULL,
  ADD UNIQUE KEY `uq_lot_sequence_url_hash` (`lot_number`, `sequence`, `url_hash`);
