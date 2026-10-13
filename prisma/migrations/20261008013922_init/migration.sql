-- CreateTable
CREATE TABLE `utilisateurs` (
    `id` VARCHAR(191) NOT NULL,
    `prenom` VARCHAR(100) NOT NULL,
    `nom` VARCHAR(100) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `passwordHash` VARCHAR(255) NULL,
    `role` ENUM('Direction', 'Admin', 'Chargé d’affaires', 'Conducteur de travaux', 'ADCI') NOT NULL,
    `actif` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `utilisateurs_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `jetons_auth` (
    `id` VARCHAR(191) NOT NULL,
    `utilisateurId` VARCHAR(191) NOT NULL,
    `type` ENUM('INVITATION', 'REINITIALISATION') NOT NULL,
    `tokenHash` VARCHAR(128) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `jetons_auth_tokenHash_key`(`tokenHash`),
    INDEX `jetons_auth_utilisateurId_idx`(`utilisateurId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `clients` (
    `id` VARCHAR(191) NOT NULL,
    `nom` VARCHAR(191) NOT NULL,
    `type` ENUM('Syndic / Gestionnaire', 'Architecte', 'Particulier', 'Entreprise') NOT NULL DEFAULT 'Syndic / Gestionnaire',
    `email` VARCHAR(191) NULL,
    `telephone` VARCHAR(30) NULL,
    `actif` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `clients_nom_key`(`nom`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `intervenants` (
    `id` VARCHAR(191) NOT NULL,
    `nom` VARCHAR(100) NOT NULL,
    `type` ENUM('Interne', 'Sous-traitant') NOT NULL DEFAULT 'Interne',
    `specialites` JSON NOT NULL,
    `telephone` VARCHAR(30) NULL,
    `actif` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `intervenants_nom_key`(`nom`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `devis` (
    `id` VARCHAR(191) NOT NULL,
    `numero` VARCHAR(50) NOT NULL,
    `dateReception` DATE NULL,
    `planification` ENUM('À planifier', 'Planifié', 'En attente', 'Annulé') NOT NULL DEFAULT 'À planifier',
    `categorie` ENUM('Couverture', 'Plomberie', 'Étanchéité', 'Ravalement / Peinture') NOT NULL,
    `clientId` VARCHAR(191) NOT NULL,
    `adresse` VARCHAR(500) NOT NULL,
    `descriptif` TEXT NOT NULL,
    `conducteurId` VARCHAR(191) NULL,
    `datePassage` DATE NULL,
    `statutConducteur` ENUM('À vérifier', 'Validé') NULL,
    `statutADCI` ENUM('Non traité', 'En attente validation', 'Validé', 'Envoyé', 'Transféré', 'À venir', 'Annulé') NOT NULL DEFAULT 'Non traité',
    `validePar` VARCHAR(100) NULL,
    `relance` ENUM('OUI', 'NON', 'RAS') NULL,
    `commentaires` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `devis_numero_key`(`numero`),
    INDEX `devis_statutADCI_idx`(`statutADCI`),
    INDEX `devis_datePassage_idx`(`datePassage`),
    INDEX `devis_clientId_idx`(`clientId`),
    INDEX `devis_conducteurId_idx`(`conducteurId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `interventions` (
    `id` VARCHAR(191) NOT NULL,
    `numero` VARCHAR(50) NOT NULL,
    `planification` ENUM('À planifier', 'Planifié', 'En attente', 'Annulé') NOT NULL DEFAULT 'À planifier',
    `categorie` ENUM('Couverture', 'Plomberie', 'Étanchéité', 'Ravalement / Peinture') NOT NULL,
    `clientId` VARCHAR(191) NOT NULL,
    `adresse` VARCHAR(500) NOT NULL,
    `descriptif` TEXT NOT NULL,
    `technicienId` VARCHAR(191) NULL,
    `datePassage` DATE NULL,
    `statutADCI` ENUM('Non traité', 'En attente validation', 'Validé', 'Envoyé', 'Transféré', 'À venir', 'Annulé') NOT NULL DEFAULT 'Non traité',
    `validePar` VARCHAR(100) NULL,
    `numeroFacture` VARCHAR(50) NULL,
    `devisId` VARCHAR(191) NULL,
    `numeroDevis` VARCHAR(50) NULL,
    `commentaires` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `interventions_numero_key`(`numero`),
    INDEX `interventions_statutADCI_idx`(`statutADCI`),
    INDEX `interventions_datePassage_idx`(`datePassage`),
    INDEX `interventions_clientId_idx`(`clientId`),
    INDEX `interventions_technicienId_idx`(`technicienId`),
    INDEX `interventions_devisId_idx`(`devisId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chantiers` (
    `id` VARCHAR(191) NOT NULL,
    `numero` VARCHAR(50) NOT NULL,
    `devisNumeros` JSON NOT NULL,
    `adresse` VARCHAR(500) NOT NULL,
    `clientId` VARCHAR(191) NOT NULL,
    `categorie` ENUM('Couverture', 'Plomberie', 'Étanchéité', 'Ravalement / Peinture') NOT NULL,
    `equipes` VARCHAR(500) NOT NULL,
    `statut` ENUM('À venir', 'En attente signature', 'En cours', 'En stand-by', 'Terminé', 'Annulé') NOT NULL DEFAULT 'À venir',
    `chargeAffairesId` VARCHAR(191) NULL,
    `dateDebut` DATE NULL,
    `dateFin` DATE NULL,
    `montantMarcheHT` DECIMAL(12, 2) NULL,
    `budgetSousTraitance` DECIMAL(12, 2) NULL,
    `deboursePrevu` DECIMAL(12, 2) NULL,
    `debourseReel` DECIMAL(12, 2) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `chantiers_numero_key`(`numero`),
    INDEX `chantiers_statut_idx`(`statut`),
    INDEX `chantiers_clientId_idx`(`clientId`),
    INDEX `chantiers_chargeAffairesId_idx`(`chargeAffairesId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `observations` (
    `id` VARCHAR(191) NOT NULL,
    `chantierId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `texte` TEXT NOT NULL,
    `auteurId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `observations_chantierId_date_idx`(`chantierId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `factures` (
    `id` VARCHAR(191) NOT NULL,
    `numero` VARCHAR(50) NOT NULL,
    `chantierId` VARCHAR(191) NOT NULL,
    `situation` VARCHAR(100) NOT NULL,
    `dateFacture` DATE NOT NULL,
    `montantTTC` DECIMAL(12, 2) NOT NULL,
    `delaiPaiementJours` INTEGER NOT NULL DEFAULT 15,
    `statut` ENUM('À valider', 'Validée') NOT NULL DEFAULT 'À valider',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `factures_numero_key`(`numero`),
    INDEX `factures_chantierId_idx`(`chantierId`),
    INDEX `factures_dateFacture_idx`(`dateFacture`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reglements` (
    `id` VARCHAR(191) NOT NULL,
    `factureId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `montant` DECIMAL(12, 2) NOT NULL,
    `mode` VARCHAR(30) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `reglements_factureId_idx`(`factureId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `relances` (
    `id` VARCHAR(191) NOT NULL,
    `factureId` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `niveau` ENUM('R1', 'R2', 'R3', 'MD') NOT NULL,
    `destinataire` ENUM('client', 'chargé d’affaires') NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `objet` VARCHAR(255) NOT NULL,
    `corps` TEXT NOT NULL,
    `envoyeParId` VARCHAR(191) NULL,
    `statutEnvoi` ENUM('envoyé', 'échec') NOT NULL,
    `erreur` TEXT NULL,

    INDEX `relances_factureId_idx`(`factureId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `compteurs` (
    `prefixe` VARCHAR(10) NOT NULL,
    `annee` INTEGER NOT NULL,
    `valeur` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`prefixe`, `annee`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` VARCHAR(191) NOT NULL,
    `date` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `userId` VARCHAR(191) NULL,
    `action` VARCHAR(20) NOT NULL,
    `entite` VARCHAR(50) NOT NULL,
    `entiteId` VARCHAR(50) NOT NULL,
    `changements` JSON NULL,

    INDEX `audit_logs_entite_entiteId_idx`(`entite`, `entiteId`),
    INDEX `audit_logs_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `jetons_auth` ADD CONSTRAINT `jetons_auth_utilisateurId_fkey` FOREIGN KEY (`utilisateurId`) REFERENCES `utilisateurs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `devis` ADD CONSTRAINT `devis_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `clients`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `devis` ADD CONSTRAINT `devis_conducteurId_fkey` FOREIGN KEY (`conducteurId`) REFERENCES `utilisateurs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `interventions` ADD CONSTRAINT `interventions_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `clients`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `interventions` ADD CONSTRAINT `interventions_technicienId_fkey` FOREIGN KEY (`technicienId`) REFERENCES `intervenants`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `interventions` ADD CONSTRAINT `interventions_devisId_fkey` FOREIGN KEY (`devisId`) REFERENCES `devis`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chantiers` ADD CONSTRAINT `chantiers_clientId_fkey` FOREIGN KEY (`clientId`) REFERENCES `clients`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `chantiers` ADD CONSTRAINT `chantiers_chargeAffairesId_fkey` FOREIGN KEY (`chargeAffairesId`) REFERENCES `utilisateurs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `observations` ADD CONSTRAINT `observations_chantierId_fkey` FOREIGN KEY (`chantierId`) REFERENCES `chantiers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `observations` ADD CONSTRAINT `observations_auteurId_fkey` FOREIGN KEY (`auteurId`) REFERENCES `utilisateurs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `factures` ADD CONSTRAINT `factures_chantierId_fkey` FOREIGN KEY (`chantierId`) REFERENCES `chantiers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reglements` ADD CONSTRAINT `reglements_factureId_fkey` FOREIGN KEY (`factureId`) REFERENCES `factures`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `relances` ADD CONSTRAINT `relances_factureId_fkey` FOREIGN KEY (`factureId`) REFERENCES `factures`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `relances` ADD CONSTRAINT `relances_envoyeParId_fkey` FOREIGN KEY (`envoyeParId`) REFERENCES `utilisateurs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `utilisateurs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
