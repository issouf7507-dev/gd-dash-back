-- CreateTable
CREATE TABLE `mails_envoyes` (
    `id` VARCHAR(191) NOT NULL,
    `demandeId` VARCHAR(191) NULL,
    `a` TEXT NOT NULL,
    `cc` TEXT NOT NULL,
    `objet` VARCHAR(500) NOT NULL,
    `corps` TEXT NOT NULL,
    `envoyeParId` VARCHAR(191) NULL,
    `envoyeLe` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `mails_envoyes_demandeId_idx`(`demandeId`),
    INDEX `mails_envoyes_envoyeLe_idx`(`envoyeLe`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `mails_envoyes` ADD CONSTRAINT `mails_envoyes_demandeId_fkey` FOREIGN KEY (`demandeId`) REFERENCES `demandes_mail`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `mails_envoyes` ADD CONSTRAINT `mails_envoyes_envoyeParId_fkey` FOREIGN KEY (`envoyeParId`) REFERENCES `utilisateurs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
