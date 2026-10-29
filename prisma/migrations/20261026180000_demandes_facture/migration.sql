-- AlterTable
ALTER TABLE `demandes_mail` MODIFY `statut` ENUM('À traiter', 'Devis créé', 'Intervention créée', 'Chantier créé', 'Facture rattachée', 'Ignorée', 'Erreur') NOT NULL DEFAULT 'À traiter',
    MODIFY `boite` ENUM('Devis', 'Intervention', 'Chantier', 'Facture') NULL,
    ADD COLUMN `factureId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `demandes_mail_factureId_idx` ON `demandes_mail`(`factureId`);

-- AddForeignKey
ALTER TABLE `demandes_mail` ADD CONSTRAINT `demandes_mail_factureId_fkey` FOREIGN KEY (`factureId`) REFERENCES `factures`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
