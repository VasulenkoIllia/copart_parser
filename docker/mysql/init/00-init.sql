CREATE DATABASE IF NOT EXISTS `copart_core` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS `copart_media` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'copart'@'%' IDENTIFIED BY 'copart';
GRANT ALL PRIVILEGES ON `copart_core`.* TO 'copart'@'%';
GRANT ALL PRIVILEGES ON `copart_media`.* TO 'copart'@'%';
FLUSH PRIVILEGES;
