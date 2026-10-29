import { CATEGORIES, PLANIFICATIONS, STATUTS_ADCI } from '@gd/shared/types'
import { Router } from 'express'
import { z } from 'zod'
import type { Intervention, Prisma } from '../../generated/prisma/client.ts'
import { NotFoundError } from '../../lib/app-error.ts'
import { defini, erreurEcriture } from '../../lib/crud.ts'
import { isoDate, toDate } from '../../lib/dates.ts'
import { categorie, planification, Role, statutADCI } from '../../lib/labels.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth, requireRole } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'

export const toInterventionDto = (i: Intervention) => ({
  id: i.id,
  numero: i.numero,
  planification: planification.label(i.planification),
  categorie: categorie.label(i.categorie),
  clientId: i.clientId,
  adresse: i.adresse,
  descriptif: i.descriptif,
  technicienId: i.technicienId,
  datePassage: isoDate(i.datePassage),
  statutADCI: statutADCI.label(i.statutADCI),
  validePar: i.validePar,
  numeroFacture: i.numeroFacture,
  numeroDevis: i.numeroDevis,
  commentaires: i.commentaires,
})

export const interventionsRouter = Router()
interventionsRouter.use(requireAuth)

const canWrite = requireRole(Role.DIRECTION, Role.ADMIN, Role.CONDUCTEUR, Role.ADCI)
const canDelete = requireRole(Role.DIRECTION, Role.ADMIN)
const idParams = z.object({ id: z.string().min(1) })
const date = z.iso.date().nullable()
const texte = (max: number) => z.string().trim().max(max)

export const interventionSchema = z.object({
  numero: texte(50).min(1, 'Le numéro est obligatoire'),
  planification: z.enum(PLANIFICATIONS).default('À planifier'),
  categorie: z.enum(CATEGORIES),
  clientId: z.string().min(1, 'Le client est obligatoire'),
  adresse: texte(500).min(1, 'L’adresse est obligatoire'),
  descriptif: texte(10_000).default(''),
  technicienId: z.string().min(1).nullable().default(null),
  datePassage: date.default(null),
  statutADCI: z.enum(STATUTS_ADCI).default('Non traité'),
  validePar: texte(100).nullable().default(null),
  numeroFacture: texte(50).nullable().default(null),
  numeroDevis: texte(50).nullable().default(null),
  commentaires: texte(10_000).default(''),
})
export type InterventionInput = z.infer<typeof interventionSchema>
type Input = InterventionInput

/** Libellés → valeurs Prisma. Le n° de devis saisi est relié au devis correspondant s'il existe. */
export async function toInterventionData(v: Partial<Input>) {
  const devis = v.numeroDevis ? await prisma.devis.findUnique({ where: { numero: v.numeroDevis }, select: { id: true } }) : null
  return defini({
    ...v,
    planification: v.planification && planification.key(v.planification),
    categorie: v.categorie && categorie.key(v.categorie),
    statutADCI: v.statutADCI && statutADCI.key(v.statutADCI),
    datePassage: toDate(v.datePassage),
    devisId: v.numeroDevis === undefined ? undefined : (devis?.id ?? null),
  }) satisfies Prisma.InterventionUncheckedUpdateInput
}

export const mapInterventionError = erreurEcriture('Ce numéro d’intervention existe déjà', 'clientId', 'Client ou technicien introuvable')

interventionsRouter.get('/', async (_req, res) => {
  const list = await prisma.intervention.findMany({ orderBy: [{ datePassage: 'desc' }, { numero: 'desc' }] })
  ok(res, list.map(toInterventionDto))
})

const idsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) })
interventionsRouter.post('/supprimer', canDelete, validate({ body: idsSchema }), async (_req, res) => {
  const { ids } = res.locals.body as z.infer<typeof idsSchema>
  const { count } = await prisma.intervention.deleteMany({ where: { id: { in: ids } } })
  ok(res, { count })
})

interventionsRouter.post('/', canWrite, validate({ body: interventionSchema }), async (_req, res) => {
  const data = (await toInterventionData(res.locals.body as Input)) as Prisma.InterventionUncheckedCreateInput
  const i = await prisma.intervention.create({ data }).catch(mapInterventionError)
  ok(res, toInterventionDto(i), { status: 201 })
})

interventionsRouter.patch('/:id', canWrite, validate({ params: idParams, body: interventionSchema.partial() }), async (_req, res) => {
  const id = res.locals.params.id as string
  if (!(await prisma.intervention.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError('Intervention introuvable')
  const i = await prisma.intervention.update({ where: { id }, data: await toInterventionData(res.locals.body as Partial<Input>) }).catch(mapInterventionError)
  ok(res, toInterventionDto(i))
})

interventionsRouter.delete('/:id', canDelete, validate({ params: idParams }), async (_req, res) => {
  const id = res.locals.params.id as string
  const { count } = await prisma.intervention.deleteMany({ where: { id } })
  if (!count) throw new NotFoundError('Intervention introuvable')
  ok(res, { id })
})
