import { createApp } from './app.ts'
import { env } from './config/env.ts'
import { logger } from './lib/logger.ts'
import { prisma } from './lib/prisma.ts'
import { demarrerReleve as demarrerReleveDemandes } from './modules/demandes-mail/service.ts'
import { demarrerReleve } from './modules/import-mail/service.ts'

const onListen = () => logger.info(`API GD démarrée sur http://${env.HOST ?? 'localhost'}:${env.PORT}/api`)
const server = env.HOST ? createApp().listen(env.PORT, env.HOST, onListen) : createApp().listen(env.PORT, onListen)

// Relève des mails de devis SolutionsBTP (si IMPORT_MAIL_SOURCE est renseigné)
const arreterReleve = demarrerReleve()
// Relève des demandes de devis des clients dans la boîte contact@ (si DEMANDES_SOURCE est renseigné)
const arreterReleveDemandes = demarrerReleveDemandes()

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
