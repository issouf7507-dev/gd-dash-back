import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { env } from '../../config/env.ts'
import { AppError, UnauthenticatedError } from '../../lib/app-error.ts'
import { verifyPassword } from '../../lib/password.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'
import { toUtilisateurDto } from '../utilisateurs/dto.ts'
import { closeSession, openSession } from './session.ts'

export const authRouter = Router()

const loginSchema = z.object({
  email: z.email().transform((e) => e.trim().toLowerCase()),
  password: z.string().min(1).max(128),
})

// 5 essais par minute et par adresse IP (désactivé pendant les tests)
const loginLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  skip: () => env.NODE_ENV === 'test',
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, _res, next) => next(new AppError('Trop de tentatives, réessayez dans une minute', 429, 'TOO_MANY_REQUESTS')),
})

authRouter.post('/login', loginLimiter, validate({ body: loginSchema }), async (_req, res) => {
  const { email, password } = res.locals.body as z.infer<typeof loginSchema>
  const user = await prisma.utilisateur.findUnique({ where: { email } })
  const valid = await verifyPassword(user?.passwordHash, password)
  // Même message quel que soit le cas (email inconnu, mauvais mot de passe, compte désactivé)
  if (!user || !valid || !user.actif) throw new UnauthenticatedError('Email ou mot de passe incorrect')
  openSession(res, user.id)
  ok(res, toUtilisateurDto(user))
})

authRouter.post('/logout', (_req, res) => {
  closeSession(res)
  ok(res, { deconnecte: true })
})

authRouter.get('/me', requireAuth, (_req, res) => {
  ok(res, toUtilisateurDto(res.locals.user!))
})
