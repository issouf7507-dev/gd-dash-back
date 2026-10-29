import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { env } from '../../config/env.ts'
import { AppError, NotFoundError, UnauthenticatedError } from '../../lib/app-error.ts'
import { envoiParServeur, envoyerMail } from '../../lib/envoi-mail.ts'
import { consommerJeton, creerJeton, lienMotDePasse, lireJeton } from '../../lib/jetons.ts'
import { logger } from '../../lib/logger.ts'
import { hashPassword, PASSWORD_RULE, PASSWORD_RULE_MESSAGE, verifyPassword } from '../../lib/password.ts'
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
const limiter = () =>
  rateLimit({
    windowMs: 60_000,
    limit: 5,
    skip: () => env.NODE_ENV === 'test',
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new AppError('Trop de tentatives, réessayez dans une minute', 429, 'TOO_MANY_REQUESTS')),
  })
const loginLimiter = limiter()
const jetonLimiter = limiter()

authRouter.post('/login', loginLimiter, validate({ body: loginSchema }), async (_req, res) => {
  const { email, password } = res.locals.body as z.infer<typeof loginSchema>
  const user = await prisma.utilisateur.findUnique({ where: { email } })
  const valid = await verifyPassword(user?.passwordHash, password)
  // Même message quel que soit le cas (email inconnu, mauvais mot de passe, compte désactivé)
  if (!user || !valid || !user.actif) throw new UnauthenticatedError('Email ou mot de passe incorrect')
  openSession(res, user)
  ok(res, toUtilisateurDto(user))
})

authRouter.post('/logout', (_req, res) => {
  closeSession(res)
  ok(res, { deconnecte: true })
})

authRouter.get('/me', requireAuth, (_req, res) => {
  ok(res, toUtilisateurDto(res.locals.user!))
})

// ─── Mot de passe oublié, invitation ─────────────────────────

const oubliSchema = z.object({ email: z.email().transform((e) => e.trim().toLowerCase()) })

// La page de connexion n'affiche le lien « Mot de passe oublié ? » que si le serveur envoie les emails
authRouter.get('/mot-de-passe-oublie', (_req, res) => {
  ok(res, { disponible: envoiParServeur() })
})

// Réponse identique que le compte existe ou non : la page ne révèle pas quels emails ont un compte
authRouter.post('/mot-de-passe-oublie', jetonLimiter, validate({ body: oubliSchema }), async (_req, res) => {
  if (!envoiParServeur()) {
    throw new AppError("La réinitialisation par email n'est pas disponible : demandez à un administrateur", 503, 'SERVICE_UNAVAILABLE')
  }
  const { email } = res.locals.body as z.infer<typeof oubliSchema>
  const user = await prisma.utilisateur.findUnique({ where: { email } })
  if (user?.actif) {
    const jeton = await creerJeton(user.id, 'REINITIALISATION')
    await envoyerMail({
      a: user.email,
      objet: 'GD — réinitialisation de votre mot de passe',
      corps: `Bonjour ${user.prenom},\n\nPour choisir un nouveau mot de passe, ouvrez ce lien (valable 1 heure) :\n${lienMotDePasse(jeton)}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message : votre mot de passe actuel reste valable.\n\nGD`,
    }).catch((err: unknown) => logger.error({ err, utilisateurId: user.id }, 'mot de passe oublié : envoi de l’email impossible'))
  }
  ok(res, { envoye: true })
})

const jetonParams = z.object({ jeton: z.string().min(20).max(100) })

/** Vérifie un lien avant d'afficher le formulaire (prénom pour l'accueil, type de lien). */
authRouter.get('/jeton/:jeton', jetonLimiter, validate({ params: jetonParams }), async (_req, res) => {
  const j = await lireJeton(res.locals.params.jeton as string)
  if (!j) throw new NotFoundError('Ce lien est invalide ou a expiré')
  ok(res, { type: j.type === 'INVITATION' ? 'invitation' : 'reinitialisation', prenom: j.utilisateur.prenom, email: j.utilisateur.email })
})

const definirSchema = z.object({
  jeton: z.string().min(20).max(100),
  motDePasse: z.string().regex(PASSWORD_RULE, PASSWORD_RULE_MESSAGE),
})

// Définit le mot de passe, coupe les autres sessions, puis connecte la personne
authRouter.post('/definir-mot-de-passe', jetonLimiter, validate({ body: definirSchema }), async (_req, res) => {
  const { jeton, motDePasse } = res.locals.body as z.infer<typeof definirSchema>
  const j = await lireJeton(jeton)
  if (!j || !(await consommerJeton(j.id))) throw new NotFoundError('Ce lien est invalide ou a expiré')
  const user = await prisma.utilisateur.update({
    where: { id: j.utilisateurId },
    data: { passwordHash: await hashPassword(motDePasse), sessionVersion: { increment: 1 } },
  })
  openSession(res, user)
  ok(res, toUtilisateurDto(user))
})
