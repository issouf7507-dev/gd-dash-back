import { createApp } from './app.ts'
import { env } from './config/env.ts'
import { logger } from './lib/logger.ts'
import { prisma } from './lib/prisma.ts'
import { demarrerReleve } from './modules/import-mail/service.ts'

const server = createApp().listen(env.PORT, () => {
  logger.info(`API GD démarrée sur http://localhost:${env.PORT}/api`)
})

// Relève des mails de devis SolutionsBTP (si IMPORT_MAIL_SOURCE est renseigné)
const arreterReleve = demarrerReleve()

// Arrêt propre (PM2 reload, Ctrl+C) : on termine les requêtes en cours puis on ferme MySQL
async function shutdown(signal: string) {
  logger.info(`${signal} reçu, arrêt en cours…`)
  arreterReleve()
  server.close(async () => {
    await prisma.$disconnect()
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
