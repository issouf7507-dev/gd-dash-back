import { Router } from 'express'
import { AppError } from '../../lib/app-error.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'

export const healthRouter = Router()

/** État de l'API et de la connexion MySQL (utilisé par le monitoring et le déploiement). */
healthRouter.get('/', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch {
    throw new AppError('Base de données injoignable', 503, 'SERVICE_UNAVAILABLE')
  }
  ok(res, { status: 'ok', db: 'ok', time: new Date().toISOString() })
})
