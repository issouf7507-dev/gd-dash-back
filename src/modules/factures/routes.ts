import { STATUTS_FACTURE_SAISIS } from '@gd/shared/types'
import { Router } from 'express'
import { z } from 'zod'
import type { Prisma } from '../../generated/prisma/client.ts'
import { NotFoundError } from '../../lib/app-error.ts'
import { defini, erreurEcriture } from '../../lib/crud.ts'
import { isoDate, toDate } from '../../lib/dates.ts'
import { destinataireRelance, niveauRelance, Role, statutFacture } from '../../lib/labels.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth, requireRole } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'
import { nomAuteur } from '../chantiers/routes.ts'

/** Une facture est toujours renvoyée avec ses règlements et ses relances (du plus ancien au plus récent). */
const avecDetails = {
  reglements: { orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] },
  relances: { orderBy: { date: 'asc' }, include: { envoyePar: true } },
} satisfies Prisma.FactureInclude
type FactureComplete = Prisma.FactureGetPayload<{ include: typeof avecDetails }>

export const toFactureDto = (f: FactureComplete) => ({
  id: f.id,
  numero: f.numero,
  chantierId: f.chantierId,
  situation: f.situation,
  dateFacture: isoDate(f.dateFacture)!,
  montantTTC: Number(f.montantTTC),
  delaiPaiementJours: f.delaiPaiementJours,
  statut: statutFacture.label(f.statut),
  reglements: f.reglements.map((r) => ({ id: r.id, date: isoDate(r.date)!, montant: Number(r.montant), mode: r.mode })),
  relances: f.relances.map((r) => ({
    id: r.id,
    date: isoDate(r.date)!,
    niveau: niveauRelance.label(r.niveau),
    destinataire: destinataireRelance.label(r.destinataire),
    auteur: nomAuteur(r.envoyePar),
    email: r.email,
    statutEnvoi: r.statutEnvoi === 'ENVOYE' ? ('envoyé' as const) : ('échec' as const),
    erreur: r.erreur,
  })),
})

export const charger = async (id: string) => {
  const f = await prisma.facture.findUnique({ where: { id }, include: avecDetails })
  if (!f) throw new NotFoundError('Facture introuvable')
  return f
}

export const facturesRouter = Router()
facturesRouter.use(requireAuth)

export const canWrite = requireRole(Role.DIRECTION, Role.ADMIN, Role.CHARGE_AFFAIRES, Role.ADCI)
const canDelete = requireRole(Role.DIRECTION, Role.ADMIN)
const idParams = z.object({ id: z.string().min(1) })

const schema = z.object({
  numero: z.string().trim().min(1, 'Le numéro est obligatoire').max(50),
  chantierId: z.string().min(1, 'Le chantier est obligatoire'),
  situation: z.string().trim().min(1).max(100),
  dateFacture: z.iso.date(),
  montantTTC: z.number().positive('Le montant TTC doit être positif').max(9_999_999_999),
  delaiPaiementJours: z.number().int().min(0).max(365).default(15),
  statut: z.enum(STATUTS_FACTURE_SAISIS).default('À valider'),
})
type Input = z.infer<typeof schema>

const toData = (v: Partial<Input>) =>
  defini({ ...v, dateFacture: toDate(v.dateFacture) ?? undefined, statut: v.statut && statutFacture.key(v.statut) }) satisfies Prisma.FactureUncheckedUpdateInput

const mapError = erreurEcriture('Ce numéro de facture existe déjà', 'chantierId', 'Chantier introuvable')

facturesRouter.get('/', async (_req, res) => {
  const list = await prisma.facture.findMany({ orderBy: [{ dateFacture: 'desc' }, { numero: 'desc' }], include: avecDetails })
  ok(res, list.map(toFactureDto))
})

// Règlements et relances sont supprimés avec la facture (cascade)
const idsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) })
facturesRouter.post('/supprimer', canDelete, validate({ body: idsSchema }), async (_req, res) => {
  const { ids } = res.locals.body as z.infer<typeof idsSchema>
  const { count } = await prisma.facture.deleteMany({ where: { id: { in: ids } } })
  ok(res, { count })
})

facturesRouter.post('/', canWrite, validate({ body: schema }), async (_req, res) => {
  const data = toData(res.locals.body as Input) as Prisma.FactureUncheckedCreateInput
  const f = await prisma.facture.create({ data, include: avecDetails }).catch(mapError)
  ok(res, toFactureDto(f), { status: 201 })
})

facturesRouter.patch('/:id', canWrite, validate({ params: idParams, body: schema.partial() }), async (_req, res) => {
  const id = res.locals.params.id as string
  await charger(id)
  const f = await prisma.facture.update({ where: { id }, data: toData(res.locals.body as Partial<Input>), include: avecDetails }).catch(mapError)
  ok(res, toFactureDto(f))
})

facturesRouter.delete('/:id', canDelete, validate({ params: idParams }), async (_req, res) => {
  const id = res.locals.params.id as string
  const { count } = await prisma.facture.deleteMany({ where: { id } })
  if (!count) throw new NotFoundError('Facture introuvable')
  ok(res, { id })
})

// ─── Règlements ──────────────────────────────────────────────

const reglementSchema = z.object({
  date: z.iso.date(),
  montant: z.number().positive('Le montant doit être positif').max(9_999_999_999),
  mode: z.string().trim().min(1).max(30),
})

facturesRouter.post('/:id/reglements', canWrite, validate({ params: idParams, body: reglementSchema }), async (_req, res) => {
  const factureId = res.locals.params.id as string
  await charger(factureId)
  const { date, ...r } = res.locals.body as z.infer<typeof reglementSchema>
  await prisma.reglement.create({ data: { ...r, factureId, date: toDate(date)! } })
  ok(res, toFactureDto(await charger(factureId)), { status: 201 })
})

/** Suppression d'un règlement saisi par erreur : renvoie la facture mise à jour. */
export const reglementsRouter = Router()
reglementsRouter.use(requireAuth)

reglementsRouter.delete('/:id', canWrite, validate({ params: idParams }), async (_req, res) => {
  const r = await prisma.reglement.findUnique({ where: { id: res.locals.params.id }, select: { id: true, factureId: true } })
  if (!r) throw new NotFoundError('Règlement introuvable')
  await prisma.reglement.delete({ where: { id: r.id } })
  ok(res, toFactureDto(await charger(r.factureId)))
})
