-- AlterTable
ALTER TABLE `demandes_mail` MODIFY `statut` ENUM('À traiter', 'Devis créé', 'Intervention créée', 'Chantier créé', 'Ignorée', 'Erreur') NOT NULL DEFAULT 'À traiter',
    MODIFY `boite` ENUM('Devis', 'Intervention', 'Chantier') NULL,
    ADD COLUMN `chantierId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `demandes_mail_chantierId_idx` ON `demandes_mail`(`chantierId`);

-- AddForeignKey
ALTER TABLE `demandes_mail` ADD CONSTRAINT `demandes_mail_chantierId_fkey` FOREIGN KEY (`chantierId`) REFERENCES `chantiers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
