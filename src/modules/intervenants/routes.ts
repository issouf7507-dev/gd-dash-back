import { CATEGORIES, TYPES_INTERVENANT, type Categorie } from '@gd/shared/types'
import { Router } from 'express'
import { z } from 'zod'
import type { Intervenant } from '../../generated/prisma/client.ts'
import { ConflictError, NotFoundError } from '../../lib/app-error.ts'
import { Role, typeIntervenant } from '../../lib/labels.ts'
import { isUniqueViolation } from '../../lib/prisma-errors.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth, requireRole } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'

export const toIntervenantDto = (t: Intervenant) => ({
  id: t.id,
  nom: t.nom,
  type: typeIntervenant.label(t.type),
  specialites: t.specialites as Categorie[],
  telephone: t.telephone,
  actif: t.actif,
})

export const intervenantsRouter = Router()
intervenantsRouter.use(requireAuth)

// Référentiel : écriture réservée à la direction et aux administrateurs
const canWrite = requireRole(Role.DIRECTION, Role.ADMIN)
const idParams = z.object({ id: z.string().min(1) })
const createSchema = z.object({
  nom: z.string().trim().min(1, 'Le nom est obligatoire').max(100),
  type: z.enum(TYPES_INTERVENANT).default('Interne'),
  specialites: z.array(z.enum(CATEGORIES)).default([]),
  telephone: z.string().trim().max(30).nullable().default(null),
  actif: z.boolean().default(true),
})
const updateSchema = createSchema.partial()

const conflict = (err: unknown): never => {
  if (isUniqueViolation(err)) throw new ConflictError('Un technicien existe déjà avec ce nom')
  throw err
}

/** Refuse la suppression d'un technicien encore affecté à des interventions (on propose de le désactiver). */
async function supprimer(ids: string[]) {
  const utilises = await prisma.intervenant.findMany({ where: { id: { in: ids }, interventions: { some: {} } }, select: { nom: true } })
  if (utilises.length) {
    throw new ConflictError(`${utilises.map((t) => t.nom).join(', ')} : encore affecté à des interventions. Désactivez-le plutôt.`)
  }
  return prisma.intervenant.deleteMany({ where: { id: { in: ids } } })
}

intervenantsRouter.get('/', async (_req, res) => {
  const list = await prisma.intervenant.findMany({ orderBy: { nom: 'asc' } })
  ok(res, list.map(toIntervenantDto))
})

const idsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) })
intervenantsRouter.post('/supprimer', requireRole(Role.DIRECTION, Role.ADMIN), validate({ body: idsSchema }), async (_req, res) => {
  const { count } = await supprimer((res.locals.body as z.infer<typeof idsSchema>).ids)
  ok(res, { count })
})

intervenantsRouter.post('/', canWrite, validate({ body: createSchema }), async (_req, res) => {
  const { type, ...data } = res.locals.body as z.infer<typeof createSchema>
  const t = await prisma.intervenant.create({ data: { ...data, type: typeIntervenant.key(type) } }).catch(conflict)
  ok(res, toIntervenantDto(t), { status: 201 })
})

intervenantsRouter.patch('/:id', canWrite, validate({ params: idParams, body: updateSchema }), async (_req, res) => {
  const id = res.locals.params.id as string
  const { type, ...data } = res.locals.body as z.infer<typeof updateSchema>
  if (!(await prisma.intervenant.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError('Technicien introuvable')
  const t = await prisma.intervenant.update({ where: { id }, data: { ...data, ...(type && { type: typeIntervenant.key(type) }) } }).catch(conflict)
  ok(res, toIntervenantDto(t))
})

intervenantsRouter.delete('/:id', requireRole(Role.DIRECTION, Role.ADMIN), validate({ params: idParams }), async (_req, res) => {
  const id = res.locals.params.id as string
  const { count } = await supprimer([id])
  if (!count) throw new NotFoundError('Technicien introuvable')
  ok(res, { id })
})
