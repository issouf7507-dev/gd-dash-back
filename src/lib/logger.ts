import { pino } from 'pino'
import { env, isProd } from '../config/env.ts'

export const logger = pino({
  level: env.LOG_LEVEL,
  // Logs lisibles en développement, JSON brut en production (exploité par PM2)
  transport: isProd || env.NODE_ENV === 'test' ? undefined : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', singleLine: true } },
})
