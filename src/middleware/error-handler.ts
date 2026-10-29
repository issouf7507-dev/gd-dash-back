import type { NextFunction, Request, Response } from 'express'
import { Prisma } from '../generated/prisma/client.ts'
import { AppError, ConflictError, formatErrorResponse, NotFoundError } from '../lib/app-error.ts'
import { logger } from '../lib/logger.ts'

/** Erreurs Prisma qu'une route n'a pas traduites elle-même (ex. élément supprimé par un collègue entre la lecture et l'écriture). */
function depuisPrisma(err: unknown): AppError | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null
  if (err.code === 'P2025') return new NotFoundError('Élément introuvable : il a peut-être été supprimé entre-temps')
  if (err.code === 'P2002') return new ConflictError('Cet élément existe déjà')
  if (err.code === 'P2003') return new ConflictError('Opération impossible : cet élément est lié à d’autres données')
  return null
}

/** Route inconnue → 404 au format standard. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction) {
  next(new NotFoundError(`Route introuvable : ${req.method} ${req.path}`))
}

/** Middleware d'erreur centralisé — doit être enregistré en DERNIER, avec ses 4 paramètres. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  err = depuisPrisma(err) ?? err
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
