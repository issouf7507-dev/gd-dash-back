-- AlterTable
ALTER TABLE `demandes_mail` ADD COLUMN `filId` VARCHAR(191) NULL,
    ADD COLUMN `refsFil` JSON NULL;

-- CreateIndex
CREATE INDEX `demandes_mail_filId_idx` ON `demandes_mail`(`filId`);
