import { CATEGORIES, PLANIFICATIONS, STATUTS_ADCI } from '@gd/shared/types'
import { Router } from 'express'
import { z } from 'zod'
import type { Intervention, Prisma } from '../../generated/prisma/client.ts'
import { ValidationIntervention } from '../../generated/prisma/client.ts'
import { NotFoundError, ValidationError } from '../../lib/app-error.ts'
import { defini, erreurEcriture } from '../../lib/crud.ts'
import { isoDate, toDate } from '../../lib/dates.ts'
import { categorie, planification, Role, statutADCI, validationIntervention } from '../../lib/labels.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { siteDto, siteSchema } from '../../lib/site.ts'
import { requireAuth, requireRole } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'
import { notifier } from '../notifications/routes.ts'

/** L'équipe (autres techniciens) est chargée avec l'intervention */
export const avecEquipe = { equipe: { select: { id: true } } } satisfies Prisma.InterventionInclude
type AvecEquipe = Intervention & { equipe?: { id: string }[] }

const nombre = (d: Prisma.Decimal | null) => (d === null ? null : Number(d))

export const toInterventionDto = (i: AvecEquipe) => ({
  id: i.id,
  numero: i.numero,
  planification: planification.label(i.planification),
  categorie: categorie.label(i.categorie),
  clientId: i.clientId,
  adresse: i.adresse,
  ...siteDto(i),
  descriptif: i.descriptif,
  technicienId: i.technicienId,
  equipeIds: (i.equipe ?? []).map((e) => e.id),
  heuresPrevues: nombre(i.heuresPrevues),
  budgetAlloue: nombre(i.budgetAlloue),
  datePassage: isoDate(i.datePassage),
  statutADCI: statutADCI.label(i.statutADCI),
  validePar: i.validePar,
  numeroFacture: i.numeroFacture,
  numeroDevis: i.numeroDevis,
  devisADCI: i.devisADCI,
  commentaires: i.commentaires,
  validation: validationIntervention.label(i.validation),
  validationMotif: i.validationMotif,
  valideParId: i.valideParId,
  valideLe: i.valideLe?.toISOString() ?? null,
})

export const interventionsRouter = Router()
interventionsRouter.use(requireAuth)

const canWrite = requireRole(Role.DIRECTION, Role.ADMIN, Role.CONDUCTEUR, Role.ADCI)
const canDelete = requireRole(Role.DIRECTION, Role.ADMIN)
/** Valident les interventions (équipe, heures, budget) */
const VALIDEURS: Role[] = [Role.DIRECTION, Role.ADMIN]
export const valideIntervention = (role: Role) => VALIDEURS.includes(role)

const idParams = z.object({ id: z.string().min(1) })
const date = z.iso.date().nullable()
const texte = (max: number) => z.string().trim().max(max)

export const interventionSchema = z.object({
  numero: texte(50).min(1, 'Le numéro est obligatoire'),
  planification: z.enum(PLANIFICATIONS).default('À planifier'),
  categorie: z.enum(CATEGORIES),
  clientId: z.string().min(1, 'Le client est obligatoire'),
  adresse: texte(500).min(1, 'L’adresse est obligatoire'),
  ...siteSchema,
  descriptif: texte(10_000).default(''),
  technicienId: z.string().min(1).nullable().default(null),
  equipeIds: z.array(z.string().min(1)).max(30).default([]),
  heuresPrevues: z.number().nonnegative().max(999_999).nullable().default(null),
  budgetAlloue: z.number().nonnegative().max(9_999_999_999).nullable().default(null),
  datePassage: date.default(null),
  statutADCI: z.enum(STATUTS_ADCI).default('Non traité'),
  validePar: texte(100).nullable().default(null),
  numeroFacture: texte(50).nullable().default(null),
  numeroDevis: texte(50).nullable().default(null),
  devisADCI: z.boolean().default(false),
  commentaires: texte(10_000).default(''),
})
export type InterventionInput = z.infer<typeof interventionSchema>

/** Modification : seuls les champs envoyés changent (sans les valeurs par défaut de la création, qui videraient l'équipe) */
const modificationSchema = z.object(
  Object.fromEntries(Object.entries(interventionSchema.shape).map(([k, s]) => [k, (s instanceof z.ZodDefault ? s.unwrap() : s).optional()])),
) as unknown as ReturnType<typeof interventionSchema.partial>
type Input = InterventionInput

/**
 * Libellés → valeurs Prisma.
 * N° de devis : choisi parmi les devis de la plateforme, ou saisi à la main s'il vient d'ADCI (case cochée).
 * Un numéro connu de la plateforme est toujours relié à son devis (il n'est alors pas « ADCI »).
 */
export async function toInterventionData(v: Partial<Input>, creation = false) {
  const { equipeIds, ...reste } = v
  let devisId: string | null | undefined
  let devisADCI = v.devisADCI
  if (v.numeroDevis !== undefined) {
    const devis = v.numeroDevis ? await prisma.devis.findUnique({ where: { numero: v.numeroDevis }, select: { id: true } }) : null
    if (v.numeroDevis && !devis && !v.devisADCI)
      throw new ValidationError(
        { body: { fieldErrors: { numeroDevis: [`Le devis ${v.numeroDevis} n’existe pas dans la plateforme : choisissez-le dans la liste, ou cochez « N° de devis ADCI »`] } } },
        'Devis introuvable',
      )
    devisId = devis?.id ?? null
    if (devis) devisADCI = false
    if (!v.numeroDevis) devisADCI = false
  }
  // Le responsable n'est pas répété dans l'équipe
  const equipe = equipeIds === undefined ? undefined : [...new Set(equipeIds)].filter((id) => id !== v.technicienId).map((id) => ({ id }))
  return defini({
    ...reste,
    planification: v.planification && planification.key(v.planification),
    categorie: v.categorie && categorie.key(v.categorie),
    statutADCI: v.statutADCI && statutADCI.key(v.statutADCI),
    datePassage: toDate(v.datePassage),
    devisId,
    devisADCI,
    equipe: equipe && (creation ? { connect: equipe } : { set: equipe }),
  }) satisfies Prisma.InterventionUncheckedUpdateInput
}

/** Statut de validation d'une nouvelle intervention : validée d'office si la Direction ou l'Admin la crée */
export function validationCreation(user: { id: string; role: Role }) {
  return valideIntervention(user.role)
    ? { validation: ValidationIntervention.VALIDEE, valideParId: user.id, valideLe: new Date() }
    : { validation: ValidationIntervention.A_VALIDER }
}

/** Prévient la Direction et l'Admin qu'une intervention attend leur validation */
export async function demanderValidation(i: { id: string; numero: string }, par: { prenom: string; nom: string }, modifiee: boolean) {
  const valideurs = await prisma.utilisateur.findMany({ where: { role: { in: VALIDEURS }, actif: true }, select: { id: true } })
  const auteur = `${par.prenom} ${par.nom}`.trim()
  for (const v of valideurs)
    await notifier({
      utilisateurId: v.id,
      type: 'validation-intervention',
      titre: `Intervention ${i.numero} à valider`,
      texte: modifiee ? 'Équipe, heures ou budget modifiés : à valider de nouveau' : 'Nouvelle intervention : équipe, heures et budget à valider',
      lien: `/interventions/${i.id}`,
      par: auteur,
    })
}

export const mapInterventionError = erreurEcriture('Ce numéro d’intervention existe déjà', 'clientId', 'Client ou technicien introuvable')

interventionsRouter.get('/', async (_req, res) => {
  const list = await prisma.intervention.findMany({ orderBy: [{ datePassage: 'desc' }, { numero: 'desc' }], include: avecEquipe })
  ok(res, list.map(toInterventionDto))
})

const idsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) })
interventionsRouter.post('/supprimer', canDelete, validate({ body: idsSchema }), async (_req, res) => {
  const { ids } = res.locals.body as z.infer<typeof idsSchema>
  const { count } = await prisma.intervention.deleteMany({ where: { id: { in: ids } } })
  ok(res, { count })
})

interventionsRouter.post('/', canWrite, validate({ body: interventionSchema }), async (_req, res) => {
  const user = res.locals.user!
  const data = { ...(await toInterventionData(res.locals.body as Input, true)), ...validationCreation(user) } as Prisma.InterventionUncheckedCreateInput
  const i = await prisma.intervention.create({ data, include: avecEquipe }).catch(mapInterventionError)
  if (i.validation === ValidationIntervention.A_VALIDER) await demanderValidation(i, user, false)
  ok(res, toInterventionDto(i), { status: 201 })
})

/** Champs dont la modification demande une nouvelle validation */
function changeValidation(avant: AvecEquipe, v: Partial<Input>) {
  const egal = (a: Prisma.Decimal | null, b: number | null | undefined) => b === undefined || (a === null ? b === null : b !== null && Number(a) === b)
  const equipeAvant = new Set((avant.equipe ?? []).map((e) => e.id))
  const equipe = v.equipeIds && [...new Set(v.equipeIds)].filter((id) => id !== (v.technicienId ?? avant.technicienId))
  return (
    (v.technicienId !== undefined && v.technicienId !== avant.technicienId) ||
    (equipe !== undefined && (equipe.length !== equipeAvant.size || equipe.some((id) => !equipeAvant.has(id)))) ||
    !egal(avant.heuresPrevues, v.heuresPrevues) ||
    !egal(avant.budgetAlloue, v.budgetAlloue)
  )
}

interventionsRouter.patch('/:id', canWrite, validate({ params: idParams, body: modificationSchema }), async (_req, res) => {
  const id = res.locals.params.id as string
  const user = res.locals.user!
  const v = res.locals.body as Partial<Input>
  const avant = await prisma.intervention.findUnique({ where: { id }, include: avecEquipe })
  if (!avant) throw new NotFoundError('Intervention introuvable')
  // Équipe, heures ou budget changés par quelqu'un d'autre que la Direction ou l'Admin : à valider de nouveau
  const aRevalider = !valideIntervention(user.role) && avant.validation !== ValidationIntervention.A_VALIDER && changeValidation(avant, v)
  const data = {
    ...(await toInterventionData(v)),
    ...(aRevalider && { validation: ValidationIntervention.A_VALIDER, validationMotif: null, valideParId: null, valideLe: null }),
  }
  const i = await prisma.intervention.update({ where: { id }, data, include: avecEquipe }).catch(mapInterventionError)
  if (aRevalider) await demanderValidation(i, user, true)
  ok(res, toInterventionDto(i))
})

/** Validation (ou refus, motif obligatoire) par la Direction ou l'Admin */
const validationSchema = z
  .object({ decision: z.enum(['Validée', 'Refusée']), motif: z.string().trim().max(500).nullable().default(null) })
  .refine((v) => v.decision === 'Validée' || !!v.motif, { message: 'Indiquez le motif du refus', path: ['motif'] })
interventionsRouter.post('/:id/validation', requireRole(...VALIDEURS), validate({ params: idParams, body: validationSchema }), async (_req, res) => {
  const id = res.locals.params.id as string
  const { decision, motif } = res.locals.body as z.infer<typeof validationSchema>
  if (!(await prisma.intervention.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError('Intervention introuvable')
  const i = await prisma.intervention.update({
    where: { id },
    data: { validation: validationIntervention.key(decision), validationMotif: decision === 'Refusée' ? motif : null, valideParId: res.locals.user!.id, valideLe: new Date() },
    include: avecEquipe,
  })
  ok(res, toInterventionDto(i))
})

interventionsRouter.delete('/:id', canDelete, validate({ params: idParams }), async (_req, res) => {
  const id = res.locals.params.id as string
  const { count } = await prisma.intervention.deleteMany({ where: { id } })
  if (!count) throw new NotFoundError('Intervention introuvable')
  ok(res, { id })
})
