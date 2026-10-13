import { CATEGORIES, STATUTS_CHANTIER } from '@gd/shared/types'
import { Router } from 'express'
import { z } from 'zod'
import type { Chantier, Observation, Prisma, Utilisateur } from '../../generated/prisma/client.ts'
import { ConflictError, NotFoundError } from '../../lib/app-error.ts'
import { defini, erreurEcriture, montant } from '../../lib/crud.ts'
import { isoDate, toDate } from '../../lib/dates.ts'
import { categorie, Role, statutChantier } from '../../lib/labels.ts'
import { isForeignKeyViolation } from '../../lib/prisma-errors.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth, requireRole } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'

export const toChantierDto = (c: Chantier) => ({
  id: c.id,
  numero: c.numero,
  devisNumeros: c.devisNumeros as string[],
  adresse: c.adresse,
  clientId: c.clientId,
  categorie: categorie.label(c.categorie),
  equipes: c.equipes,
  statut: statutChantier.label(c.statut),
  chargeAffairesId: c.chargeAffairesId,
  dateDebut: isoDate(c.dateDebut),
  dateFin: isoDate(c.dateFin),
  montantMarcheHT: montant(c.montantMarcheHT),
  budgetSousTraitance: montant(c.budgetSousTraitance),
  deboursePrevu: montant(c.deboursePrevu),
  debourseReel: montant(c.debourseReel),
})

export const nomAuteur = (u: Pick<Utilisateur, 'prenom' | 'nom'> | null) => (u ? `${u.prenom} ${u.nom}`.trim() : 'Utilisateur supprimé')

const toObservationDto = (o: Observation & { auteur: Utilisateur | null }) => ({
  id: o.id,
  chantierId: o.chantierId,
  date: isoDate(o.date)!,
  auteur: nomAuteur(o.auteur),
  texte: o.texte,
})

export const chantiersRouter = Router()
chantiersRouter.use(requireAuth)

const canWrite = requireRole(Role.DIRECTION, Role.ADMIN, Role.CHARGE_AFFAIRES)
// Le journal est aussi tenu par les conducteurs de travaux
const canWriteJournal = requireRole(Role.DIRECTION, Role.ADMIN, Role.CHARGE_AFFAIRES, Role.CONDUCTEUR)
const canDelete = requireRole(Role.DIRECTION, Role.ADMIN)
const idParams = z.object({ id: z.string().min(1) })
const date = z.iso.date().nullable()
const euros = z.number().nonnegative().max(9_999_999_999).nullable()

const schema = z.object({
  numero: z.string().trim().min(1, 'Le numéro est obligatoire').max(50),
  devisNumeros: z.array(z.string().trim().min(1).max(50)).max(50).default([]),
  adresse: z.string().trim().min(1, 'L’adresse est obligatoire').max(500),
  clientId: z.string().min(1, 'Le client est obligatoire'),
  categorie: z.enum(CATEGORIES),
  equipes: z.string().trim().max(500).default(''),
  statut: z.enum(STATUTS_CHANTIER).default('À venir'),
  chargeAffairesId: z.string().min(1).nullable().default(null),
  dateDebut: date.default(null),
  dateFin: date.default(null),
  montantMarcheHT: euros.default(null),
  budgetSousTraitance: euros.default(null),
  deboursePrevu: euros.default(null),
  debourseReel: euros.default(null),
})
type Input = z.infer<typeof schema>

const toData = (v: Partial<Input>) =>
  defini({
    ...v,
    categorie: v.categorie && categorie.key(v.categorie),
    statut: v.statut && statutChantier.key(v.statut),
    dateDebut: toDate(v.dateDebut),
    dateFin: toDate(v.dateFin),
  }) satisfies Prisma.ChantierUncheckedUpdateInput

const mapError = erreurEcriture('Ce numéro de chantier existe déjà', 'clientId', 'Client ou chargé d’affaires introuvable')

/** Supprime des chantiers (et leur journal) ; refusé tant qu'il reste des factures. */
function supprimer(ids: string[]) {
  return prisma.chantier.deleteMany({ where: { id: { in: ids } } }).catch((err) => {
    if (isForeignKeyViolation(err)) throw new ConflictError('Ce chantier a encore des factures : supprimez-les d’abord')
    throw err
  })
}

chantiersRouter.get('/', async (_req, res) => {
  const list = await prisma.chantier.findMany({ orderBy: { numero: 'desc' } })
  ok(res, list.map(toChantierDto))
})

const idsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) })
chantiersRouter.post('/supprimer', canDelete, validate({ body: idsSchema }), async (_req, res) => {
  const { count } = await supprimer((res.locals.body as z.infer<typeof idsSchema>).ids)
  ok(res, { count })
})

chantiersRouter.post('/', canWrite, validate({ body: schema }), async (_req, res) => {
  const c = await prisma.chantier.create({ data: toData(res.locals.body as Input) as Prisma.ChantierUncheckedCreateInput }).catch(mapError)
  ok(res, toChantierDto(c), { status: 201 })
})

chantiersRouter.patch('/:id', canWrite, validate({ params: idParams, body: schema.partial() }), async (_req, res) => {
  const id = res.locals.params.id as string
  if (!(await prisma.chantier.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError('Chantier introuvable')
  const c = await prisma.chantier.update({ where: { id }, data: toData(res.locals.body as Partial<Input>) }).catch(mapError)
  ok(res, toChantierDto(c))
})

chantiersRouter.delete('/:id', canDelete, validate({ params: idParams }), async (_req, res) => {
  const id = res.locals.params.id as string
  const { count } = await supprimer([id])
  if (!count) throw new NotFoundError('Chantier introuvable')
  ok(res, { id })
})

// ─── Journal d'observations ──────────────────────────────────

const observationSchema = z.object({
  date: z.iso.date(),
  texte: z.string().trim().min(1, 'L’observation est vide').max(10_000),
})

chantiersRouter.post('/:id/observations', canWriteJournal, validate({ params: idParams, body: observationSchema }), async (_req, res) => {
  const chantierId = res.locals.params.id as string
  if (!(await prisma.chantier.findUnique({ where: { id: chantierId }, select: { id: true } }))) throw new NotFoundError('Chantier introuvable')
  const { date: jour, texte } = res.locals.body as z.infer<typeof observationSchema>
  const o = await prisma.observation.create({
    data: { chantierId, date: toDate(jour)!, texte, auteurId: res.locals.user!.id },
    include: { auteur: true },
  })
  ok(res, toObservationDto(o), { status: 201 })
})

/** Observations de tous les chantiers (chargées une fois par le front), et suppression d'une observation. */
export const observationsRouter = Router()
observationsRouter.use(requireAuth)

observationsRouter.get('/', async (_req, res) => {
  const list = await prisma.observation.findMany({ orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], include: { auteur: true } })
  ok(res, list.map(toObservationDto))
})

observationsRouter.delete('/:id', canDelete, validate({ params: idParams }), async (_req, res) => {
  const id = res.locals.params.id as string
  const { count } = await prisma.observation.deleteMany({ where: { id } })
  if (!count) throw new NotFoundError('Observation introuvable')
  ok(res, { id })
})
