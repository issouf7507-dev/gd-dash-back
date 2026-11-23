-- CreateTable
CREATE TABLE `tickets` (
    `id` VARCHAR(191) NOT NULL,
    `numero` INTEGER NOT NULL AUTO_INCREMENT,
    `titre` VARCHAR(200) NOT NULL,
    `description` TEXT NOT NULL,
    `categorie` VARCHAR(30) NOT NULL,
    `priorite` VARCHAR(20) NOT NULL,
    `statut` VARCHAR(20) NOT NULL DEFAULT 'Ouvert',
    `page` VARCHAR(500) NULL,
    `navigateur` VARCHAR(500) NULL,
    `pieces` JSON NULL,
    `auteurId` VARCHAR(191) NULL,
    `notifie` BOOLEAN NOT NULL DEFAULT false,
    `erreurNotif` TEXT NULL,
    `resoluLe` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `tickets_numero_key`(`numero`),
    INDEX `tickets_statut_idx`(`statut`),
    INDEX `tickets_auteurId_idx`(`auteurId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tickets_messages` (
    `id` VARCHAR(191) NOT NULL,
    `ticketId` VARCHAR(191) NOT NULL,
    `auteurId` VARCHAR(191) NULL,
    `texte` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `tickets_messages_ticketId_idx`(`ticketId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `tickets` ADD CONSTRAINT `tickets_auteurId_fkey` FOREIGN KEY (`auteurId`) REFERENCES `utilisateurs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tickets_messages` ADD CONSTRAINT `tickets_messages_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `tickets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tickets_messages` ADD CONSTRAINT `tickets_messages_auteurId_fkey` FOREIGN KEY (`auteurId`) REFERENCES `utilisateurs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
