-- AlterTable
ALTER TABLE `clients` ADD COLUMN `adresse` VARCHAR(191) NULL,
    ADD COLUMN `code` VARCHAR(30) NULL,
    ADD COLUMN `codePostal` VARCHAR(10) NULL,
    ADD COLUMN `famille` VARCHAR(60) NULL,
    ADD COLUMN `ville` VARCHAR(100) NULL;

-- CreateTable
CREATE TABLE `fournisseurs` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(30) NULL,
    `nom` VARCHAR(191) NOT NULL,
    `famille` VARCHAR(60) NULL,
    `email` VARCHAR(191) NULL,
    `telephone` VARCHAR(30) NULL,
    `adresse` VARCHAR(191) NULL,
    `codePostal` VARCHAR(10) NULL,
    `ville` VARCHAR(100) NULL,
    `actif` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `fournisseurs_code_key`(`code`),
    INDEX `fournisseurs_nom_idx`(`nom`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `clients_code_key` ON `clients`(`code`);

