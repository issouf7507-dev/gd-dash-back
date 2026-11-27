-- AlterTable
ALTER TABLE `interventions` ADD COLUMN `budgetAlloue` DECIMAL(12, 2) NULL,
    ADD COLUMN `devisADCI` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `heuresPrevues` DECIMAL(8, 2) NULL,
    ADD COLUMN `validation` ENUM('À valider', 'Validée', 'Refusée') NOT NULL DEFAULT 'À valider',
    ADD COLUMN `validationMotif` VARCHAR(500) NULL,
    ADD COLUMN `valideLe` DATETIME(3) NULL,
    ADD COLUMN `valideParId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `_EquipeIntervention` (
    `A` VARCHAR(191) NOT NULL,
    `B` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `_EquipeIntervention_AB_unique`(`A`, `B`),
    INDEX `_EquipeIntervention_B_index`(`B`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `interventions_validation_idx` ON `interventions`(`validation`);

-- AddForeignKey
ALTER TABLE `interventions` ADD CONSTRAINT `interventions_valideParId_fkey` FOREIGN KEY (`valideParId`) REFERENCES `utilisateurs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_EquipeIntervention` ADD CONSTRAINT `_EquipeIntervention_A_fkey` FOREIGN KEY (`A`) REFERENCES `intervenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_EquipeIntervention` ADD CONSTRAINT `_EquipeIntervention_B_fkey` FOREIGN KEY (`B`) REFERENCES `interventions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- Reprise de l'existant : les interventions déjà saisies datent d'avant la validation, elles sont validées d'office
UPDATE `interventions` SET `validation` = 'Validée';

-- Un n° de devis qui ne correspond à aucun devis de la plateforme vient d'ADCI
UPDATE `interventions` SET `devisADCI` = true WHERE `numeroDevis` IS NOT NULL AND `numeroDevis` <> '' AND `devisId` IS NULL;
