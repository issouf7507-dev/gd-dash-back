import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import helmet from 'helmet'
import { pinoHttp } from 'pino-http'
import { env } from './config/env.ts'
import { logger } from './lib/logger.ts'
import { errorHandler, notFoundHandler } from './middleware/error-handler.ts'
import { apiRouter } from './routes.ts'

export function createApp() {
  const app = express()

  app.disable('x-powered-by')
  app.set('trust proxy', 1) // derrière Nginx en production
  app.use(helmet())
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }))
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())
  app.use(
    pinoHttp({
      logger,
      autoLogging: env.NODE_ENV !== 'test',
      // Une ligne par requête : méthode, URL, statut (pas d'en-têtes ni de cookies dans les logs)
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  )

  app.use('/api', apiRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)
  return app
}
