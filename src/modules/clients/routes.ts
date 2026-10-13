import { TYPES_CLIENT } from '@gd/shared/types'
import { Router } from 'express'
import { z } from 'zod'
import type { Client } from '../../generated/prisma/client.ts'
import { ConflictError, NotFoundError } from '../../lib/app-error.ts'
import { Role, typeClient } from '../../lib/labels.ts'
import { isForeignKeyViolation, isUniqueViolation } from '../../lib/prisma-errors.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth, requireRole } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'

export const toClientDto = (c: Client) => ({
  id: c.id,
  nom: c.nom,
  type: typeClient.label(c.type),
  email: c.email,
  telephone: c.telephone,
  actif: c.actif,
})

export const clientsRouter = Router()
clientsRouter.use(requireAuth)

// Création / modification : direction, admin, et ADCI (qui crée les clients à l'import des devis)
const canWrite = requireRole(Role.DIRECTION, Role.ADMIN, Role.ADCI)
const canDelete = requireRole(Role.DIRECTION, Role.ADMIN)

const idParams = z.object({ id: z.string().min(1) })
const createSchema = z.object({
  nom: z.string().trim().min(1).max(191),
  type: z.enum(TYPES_CLIENT).default('Syndic / Gestionnaire'),
  email: z.email().trim().toLowerCase().nullable().default(null),
  telephone: z.string().trim().max(30).nullable().default(null),
  actif: z.boolean().default(true),
})
const updateSchema = createSchema.partial()

const conflict = (err: unknown) => {
  if (isUniqueViolation(err)) throw new ConflictError('Un client existe déjà avec ce nom')
  throw err
}

clientsRouter.get('/', async (_req, res) => {
  const clients = await prisma.client.findMany({ orderBy: { nom: 'asc' } })
  ok(res, clients.map(toClientDto))
})

clientsRouter.get('/:id', validate({ params: idParams }), async (_req, res) => {
  const c = await prisma.client.findUnique({ where: { id: res.locals.params.id } })
  if (!c) throw new NotFoundError('Client introuvable')
  ok(res, toClientDto(c))
})

clientsRouter.post('/', canWrite, validate({ body: createSchema }), async (_req, res) => {
  const { type, ...data } = res.locals.body as z.infer<typeof createSchema>
  const c = await prisma.client.create({ data: { ...data, type: typeClient.key(type) } }).catch(conflict)
  ok(res, toClientDto(c), { status: 201 })
})

clientsRouter.patch('/:id', canWrite, validate({ params: idParams, body: updateSchema }), async (_req, res) => {
  const id = res.locals.params.id as string
  const { type, ...data } = res.locals.body as z.infer<typeof updateSchema>
  if (!(await prisma.client.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError('Client introuvable')
  const c = await prisma.client.update({ where: { id }, data: { ...data, ...(type && { type: typeClient.key(type) }) } }).catch(conflict)
  ok(res, toClientDto(c))
})

// Refusée tant que le client a des devis, interventions ou chantiers
clientsRouter.delete('/:id', canDelete, validate({ params: idParams }), async (_req, res) => {
  const id = res.locals.params.id as string
  if (!(await prisma.client.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError('Client introuvable')
  await prisma.client.delete({ where: { id } }).catch((err) => {
    if (isForeignKeyViolation(err)) throw new ConflictError('Ce client a encore des devis, interventions ou chantiers : supprimez-les d’abord')
    throw err
  })
  ok(res, { id })
})
