-- CreateTable
CREATE TABLE `demandes_mail` (
    `id` VARCHAR(191) NOT NULL,
    `messageId` VARCHAR(255) NOT NULL,
    `recuLe` DATETIME(3) NOT NULL,
    `expediteur` VARCHAR(255) NOT NULL,
    `objet` VARCHAR(500) NOT NULL,
    `corps` TEXT NOT NULL,
    `statut` ENUM('À traiter', 'Devis créé', 'Ignorée', 'Erreur') NOT NULL DEFAULT 'À traiter',
    `donnees` JSON NOT NULL,
    `anomalies` JSON NOT NULL,
    `pieces` JSON NOT NULL,
    `erreur` TEXT NULL,
    `devisId` VARCHAR(191) NULL,
    `traiteParId` VARCHAR(191) NULL,
    `traiteLe` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `demandes_mail_messageId_key`(`messageId`),
    INDEX `demandes_mail_statut_idx`(`statut`),
    INDEX `demandes_mail_recuLe_idx`(`recuLe`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `demandes_mail` ADD CONSTRAINT `demandes_mail_devisId_fkey` FOREIGN KEY (`devisId`) REFERENCES `devis`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `demandes_mail` ADD CONSTRAINT `demandes_mail_traiteParId_fkey` FOREIGN KEY (`traiteParId`) REFERENCES `utilisateurs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
