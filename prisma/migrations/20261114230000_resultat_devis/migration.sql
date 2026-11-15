-- AlterTable
ALTER TABLE `devis` ADD COLUMN `motifRefus` VARCHAR(500) NULL,
    ADD COLUMN `resultat` ENUM('En attente', 'Accepté', 'Refusé', 'Sans suite') NOT NULL DEFAULT 'En attente',
    ADD COLUMN `resultatLe` DATE NULL,
    ADD COLUMN `resultatMailId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `devis_resultat_idx` ON `devis`(`resultat`);

-- AddForeignKey
ALTER TABLE `devis` ADD CONSTRAINT `devis_resultatMailId_fkey` FOREIGN KEY (`resultatMailId`) REFERENCES `demandes_mail`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

