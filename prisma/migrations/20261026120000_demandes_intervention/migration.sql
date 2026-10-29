-- AlterTable
ALTER TABLE `demandes_mail` MODIFY `statut` ENUM('À traiter', 'Devis créé', 'Intervention créée', 'Ignorée', 'Erreur') NOT NULL DEFAULT 'À traiter',
    ADD COLUMN `boite` ENUM('Devis', 'Intervention') NULL,
    ADD COLUMN `interventionId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `demandes_mail_boite_idx` ON `demandes_mail`(`boite`);

-- CreateIndex
CREATE INDEX `demandes_mail_interventionId_idx` ON `demandes_mail`(`interventionId`);

-- AddForeignKey
ALTER TABLE `demandes_mail` ADD CONSTRAINT `demandes_mail_interventionId_fkey` FOREIGN KEY (`interventionId`) REFERENCES `interventions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
