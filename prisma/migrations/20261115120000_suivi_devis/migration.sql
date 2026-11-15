-- AlterTable
ALTER TABLE `devis` ADD COLUMN `envoyeLe` DATE NULL,
    ADD COLUMN `valideLe` DATETIME(3) NULL,
    ADD COLUMN `valideParId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `suivis_devis` (
    `id` VARCHAR(191) NOT NULL,
    `devisId` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `type` ENUM('Validation demandée', 'Validé', 'Validation refusée', 'Envoyé au client', 'Relance') NOT NULL,
    `auteurId` VARCHAR(191) NULL,
    `commentaire` TEXT NULL,
    `email` VARCHAR(191) NULL,
    `objet` VARCHAR(255) NULL,
    `statutEnvoi` ENUM('envoyé', 'échec') NULL,
    `erreur` TEXT NULL,

    INDEX `suivis_devis_devisId_idx`(`devisId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `devis` ADD CONSTRAINT `devis_valideParId_fkey` FOREIGN KEY (`valideParId`) REFERENCES `utilisateurs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `suivis_devis` ADD CONSTRAINT `suivis_devis_devisId_fkey` FOREIGN KEY (`devisId`) REFERENCES `devis`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `suivis_devis` ADD CONSTRAINT `suivis_devis_auteurId_fkey` FOREIGN KEY (`auteurId`) REFERENCES `utilisateurs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;


-- Devis déjà envoyés : date d'envoi approchée par leur dernière modification (point de départ des relances)
UPDATE `devis` SET `envoyeLe` = DATE(`updatedAt`) WHERE `statutADCI` = 'Envoyé' AND `envoyeLe` IS NULL;
