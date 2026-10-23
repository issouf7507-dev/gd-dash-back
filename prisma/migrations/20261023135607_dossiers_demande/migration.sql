-- AlterTable
ALTER TABLE `demandes_mail` ADD COLUMN `dossierId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `dossiers_demande` (
    `id` VARCHAR(191) NOT NULL,
    `nom` VARCHAR(60) NOT NULL,
    `parentId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `dossiers_demande_parentId_idx`(`parentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `demandes_mail_dossierId_idx` ON `demandes_mail`(`dossierId`);

-- AddForeignKey
ALTER TABLE `demandes_mail` ADD CONSTRAINT `demandes_mail_dossierId_fkey` FOREIGN KEY (`dossierId`) REFERENCES `dossiers_demande`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dossiers_demande` ADD CONSTRAINT `dossiers_demande_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `dossiers_demande`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
