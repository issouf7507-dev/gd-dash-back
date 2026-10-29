-- CreateTable
CREATE TABLE `photos_observation` (
    `id` VARCHAR(191) NOT NULL,
    `observationId` VARCHAR(191) NOT NULL,
    `fichier` VARCHAR(255) NOT NULL,
    `type` VARCHAR(50) NOT NULL,
    `taille` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `photos_observation_observationId_idx`(`observationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `photos_observation` ADD CONSTRAINT `photos_observation_observationId_fkey` FOREIGN KEY (`observationId`) REFERENCES `observations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
