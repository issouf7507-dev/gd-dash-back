-- AlterTable
ALTER TABLE `devis` ADD COLUMN `montantHT` DECIMAL(12, 2) NULL,
    ADD COLUMN `source` ENUM('Saisie', 'Mail') NOT NULL DEFAULT 'Saisie';

-- CreateTable
CREATE TABLE `imports_mail` (
    `id` VARCHAR(191) NOT NULL,
    `messageId` VARCHAR(255) NOT NULL,
    `recuLe` DATETIME(3) NOT NULL,
    `expediteur` VARCHAR(255) NOT NULL,
    `objet` VARCHAR(500) NOT NULL,
    `corps` TEXT NOT NULL,
    `statut` ENUM('À vérifier', 'Importé', 'Ignoré', 'Erreur') NOT NULL DEFAULT 'À vérifier',
    `donnees` JSON NOT NULL,
    `anomalies` JSON NOT NULL,
    `pdfNom` VARCHAR(255) NULL,
    `pdfFichier` VARCHAR(255) NULL,
    `erreur` TEXT NULL,
    `devisId` VARCHAR(191) NULL,
    `traiteParId` VARCHAR(191) NULL,
    `traiteLe` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `imports_mail_messageId_key`(`messageId`),
    INDEX `imports_mail_statut_idx`(`statut`),
    INDEX `imports_mail_recuLe_idx`(`recuLe`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `imports_mail` ADD CONSTRAINT `imports_mail_devisId_fkey` FOREIGN KEY (`devisId`) REFERENCES `devis`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `imports_mail` ADD CONSTRAINT `imports_mail_traiteParId_fkey` FOREIGN KEY (`traiteParId`) REFERENCES `utilisateurs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
