import type { NextFunction, Request, Response } from 'express'
import { AppError, formatErrorResponse, NotFoundError } from '../lib/app-error.ts'
import { logger } from '../lib/logger.ts'

/** Route inconnue → 404 au format standard. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(new NotFoundError(`Route introuvable : ${req.method} ${req.path}`))
}

/** Middleware d'erreur centralisé — doit être enregistré en DERNIER, avec ses 4 paramètres. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json(formatErrorResponse(err))
  }
  // JSON mal formé envoyé par le client (erreur levée par express.json())
  if (err instanceof SyntaxError && 'status' in err && err.status === 400) {
    return res.status(400).json({ error: { message: 'Corps de requête JSON invalide', code: 'VALIDATION_ERROR' } })
  }
  logger.error({ err, method: req.method, url: req.originalUrl }, 'Erreur non gérée')
  return res.status(500).json({ error: { message: 'Erreur interne', code: 'INTERNAL_ERROR' } })
}
