-- AlterTable
ALTER TABLE `demandes_mail` ADD COLUMN `categorieId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `categories_demande` (
    `id` VARCHAR(191) NOT NULL,
    `nom` VARCHAR(60) NOT NULL,
    `couleur` VARCHAR(20) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `categories_demande_nom_key`(`nom`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `demandes_mail_categorieId_idx` ON `demandes_mail`(`categorieId`);

-- AddForeignKey
ALTER TABLE `demandes_mail` ADD CONSTRAINT `demandes_mail_categorieId_fkey` FOREIGN KEY (`categorieId`) REFERENCES `categories_demande`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
