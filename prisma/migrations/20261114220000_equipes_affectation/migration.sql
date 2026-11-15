-- AlterTable
ALTER TABLE `demandes_mail` ADD COLUMN `affecteAId` VARCHAR(191) NULL,
    ADD COLUMN `affecteLe` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `equipes` (
    `id` VARCHAR(191) NOT NULL,
    `nom` VARCHAR(60) NOT NULL,
    `couleur` VARCHAR(20) NOT NULL DEFAULT 'blue',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `equipes_nom_key`(`nom`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `_EquipeToUtilisateur` (
    `A` VARCHAR(191) NOT NULL,
    `B` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `_EquipeToUtilisateur_AB_unique`(`A`, `B`),
    INDEX `_EquipeToUtilisateur_B_index`(`B`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `demandes_mail_affecteAId_idx` ON `demandes_mail`(`affecteAId`);

-- AddForeignKey
ALTER TABLE `demandes_mail` ADD CONSTRAINT `demandes_mail_affecteAId_fkey` FOREIGN KEY (`affecteAId`) REFERENCES `utilisateurs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_EquipeToUtilisateur` ADD CONSTRAINT `_EquipeToUtilisateur_A_fkey` FOREIGN KEY (`A`) REFERENCES `equipes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `_EquipeToUtilisateur` ADD CONSTRAINT `_EquipeToUtilisateur_B_fkey` FOREIGN KEY (`B`) REFERENCES `utilisateurs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

