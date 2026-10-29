import { createApp } from './app.ts'
import { env } from './config/env.ts'
import { logger } from './lib/logger.ts'
import { prisma } from './lib/prisma.ts'
import { regrouperAnciens } from './modules/demandes-mail/fils.ts'
import { classerAnciens, demarrerReleve as demarrerReleveDemandes, rangerDossiersAuto } from './modules/demandes-mail/service.ts'
import { demarrerReleve } from './modules/import-mail/service.ts'

const onListen = () => logger.info(`API GD démarrée sur http://${env.HOST ?? 'localhost'}:${env.PORT}/api`)
const server = env.HOST ? createApp().listen(env.PORT, env.HOST, onListen) : createApp().listen(env.PORT, onListen)

// Relève des mails de devis SolutionsBTP (si IMPORT_MAIL_SOURCE est renseigné)
const arreterReleve = demarrerReleve()
// Relève des demandes de devis des clients dans la boîte contact@ (si DEMANDES_SOURCE est renseigné)
const arreterReleveDemandes = demarrerReleveDemandes()
// Regroupe en fils les demandes reçues avant la mise en place des fils (une seule fois)
void regrouperAnciens().catch((err) => logger.error({ err }, 'demandes mail : regroupement des anciens mails en échec'))
// Range dans la boîte Devis ou Intervention les demandes reçues avant les demandes d'intervention (une seule fois)
void classerAnciens()
  .catch((err) => logger.error({ err }, 'demandes mail : rangement des anciens mails en échec'))
  // Crée les dossiers automatiques (CV, Publicité, Fournisseurs…) et y range les mails déjà reçus (une seule fois)
  .then(() => rangerDossiersAuto())
  .catch((err) => logger.error({ err }, 'demandes mail : rangement dans les dossiers automatiques en échec'))

// Arrêt propre (PM2 reload, Ctrl+C) : on termine les requêtes en cours puis on ferme MySQL
async function shutdown(signal: string) {
  logger.info(`${signal} reçu, arrêt en cours…`)
  arreterReleve()
  arreterReleveDemandes()
  server.close(async () => {
    await prisma.$disconnect()
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
