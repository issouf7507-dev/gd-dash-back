-- CreateTable
CREATE TABLE `exercices_gestion` (
    `id` VARCHAR(191) NOT NULL,
    `annee` INTEGER NOT NULL,
    `parametres` JSON NOT NULL,
    `previsions` JSON NOT NULL,
    `realise` JSON NOT NULL,
    `fraisGeneraux` JSON NOT NULL,
    `salaires` JSON NOT NULL,
    `modifieParId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `exercices_gestion_annee_key`(`annee`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `exercices_gestion` ADD CONSTRAINT `exercices_gestion_modifieParId_fkey` FOREIGN KEY (`modifieParId`) REFERENCES `utilisateurs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

