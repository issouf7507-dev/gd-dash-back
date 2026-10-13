import { ROLES } from '@gd/shared/types'
import { Router } from 'express'
import { z } from 'zod'
import { ConflictError, ForbiddenError, NotFoundError } from '../../lib/app-error.ts'
import { Role, roleKey } from '../../lib/labels.ts'
import { hashPassword, PASSWORD_RULE, PASSWORD_RULE_MESSAGE } from '../../lib/password.ts'
import { isUniqueViolation } from '../../lib/prisma-errors.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth, requireRole } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'
import { toUtilisateurDto } from './dto.ts'

export const utilisateursRouter = Router()

// Gestion des utilisateurs : réservée aux administrateurs
utilisateursRouter.use(requireAuth, requireRole(Role.ADMIN))

const idParams = z.object({ id: z.string().min(1) })
const motDePasse = z.string().regex(PASSWORD_RULE, PASSWORD_RULE_MESSAGE)

const createSchema = z.object({
  prenom: z.string().trim().min(1).max(100),
  nom: z.string().trim().max(100).default(''),
  email: z.email().transform((e) => e.trim().toLowerCase()),
  role: z.enum(ROLES),
  actif: z.boolean().default(true),
  /** Mot de passe initial (en attendant l'invitation par email) */
  motDePasse: motDePasse.optional(),
})
const updateSchema = createSchema.partial()

utilisateursRouter.get('/', async (_req, res) => {
  const users = await prisma.utilisateur.findMany({ orderBy: [{ prenom: 'asc' }, { nom: 'asc' }] })
  ok(res, users.map(toUtilisateurDto))
})

utilisateursRouter.get('/:id', validate({ params: idParams }), async (_req, res) => {
  const user = await prisma.utilisateur.findUnique({ where: { id: res.locals.params.id } })
  if (!user) throw new NotFoundError('Utilisateur introuvable')
  ok(res, toUtilisateurDto(user))
})

utilisateursRouter.post('/', validate({ body: createSchema }), async (_req, res) => {
  const { motDePasse: mdp, role, ...data } = res.locals.body as z.infer<typeof createSchema>
  try {
    const user = await prisma.utilisateur.create({
      data: { ...data, role: roleKey(role), passwordHash: mdp ? await hashPassword(mdp) : null },
    })
    ok(res, toUtilisateurDto(user), { status: 201 })
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('Un utilisateur existe déjà avec cet email')
    throw err
  }
})

utilisateursRouter.patch('/:id', validate({ params: idParams, body: updateSchema }), async (_req, res) => {
  const id = res.locals.params.id as string
  const { motDePasse: mdp, role, ...data } = res.locals.body as z.infer<typeof updateSchema>
  const me = res.locals.user!

  // Garde-fou : un administrateur ne peut pas se bloquer lui-même
  if (id === me.id && (data.actif === false || (role && roleKey(role) !== Role.ADMIN))) {
    throw new ForbiddenError('Vous ne pouvez pas désactiver votre propre compte ni retirer votre rôle Admin')
  }
  if (!(await prisma.utilisateur.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError('Utilisateur introuvable')

  try {
    const user = await prisma.utilisateur.update({
      where: { id },
      data: {
        ...data,
        ...(role && { role: roleKey(role) }),
        ...(mdp && { passwordHash: await hashPassword(mdp) }),
      },
    })
    ok(res, toUtilisateurDto(user))
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('Un utilisateur existe déjà avec cet email')
    throw err
  }
})
