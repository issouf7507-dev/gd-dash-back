import type { NextFunction, Request, Response } from 'express'
import { ForbiddenError, UnauthenticatedError } from '../lib/app-error.ts'
import { prisma } from '../lib/prisma.ts'
import type { Role } from '../generated/prisma/client.ts'
import { readSession, SESSION_COOKIE } from '../modules/auth/session.ts'

/**
 * Exige une session valide. L'utilisateur est relu en base à chaque requête : un compte désactivé est coupé
 * immédiatement, et une session ouverte avant un changement de mot de passe aussi (version de session dépassée).
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const session = readSession(req.cookies?.[SESSION_COOKIE])
  const user = session ? await prisma.utilisateur.findUnique({ where: { id: session.userId } }) : null
  if (!user || !user.actif || user.sessionVersion !== session!.version) return next(new UnauthenticatedError())
  res.locals.user = user
  next()
}

/** Exige l'un des rôles donnés (à placer après requireAuth). */
export function requireRole(...roles: Role[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const user = res.locals.user
    if (!user) return next(new UnauthenticatedError())
    if (!roles.includes(user.role)) return next(new ForbiddenError())
    next()
  }
}
