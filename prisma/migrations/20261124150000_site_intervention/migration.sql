-- AlterTable
ALTER TABLE `chantiers` ADD COLUMN `codePostal` VARCHAR(10) NULL,
    ADD COLUMN `latitude` DOUBLE NULL,
    ADD COLUMN `longitude` DOUBLE NULL,
    ADD COLUMN `ville` VARCHAR(100) NULL;

-- AlterTable
ALTER TABLE `devis` ADD COLUMN `codePostal` VARCHAR(10) NULL,
    ADD COLUMN `latitude` DOUBLE NULL,
    ADD COLUMN `longitude` DOUBLE NULL,
    ADD COLUMN `ville` VARCHAR(100) NULL;

-- AlterTable
ALTER TABLE `interventions` ADD COLUMN `codePostal` VARCHAR(10) NULL,
    ADD COLUMN `latitude` DOUBLE NULL,
    ADD COLUMN `longitude` DOUBLE NULL,
    ADD COLUMN `ville` VARCHAR(100) NULL;

