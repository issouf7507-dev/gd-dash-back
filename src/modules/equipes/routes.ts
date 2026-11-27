// CRM des équipes : équipes d'utilisateurs, et charge de chacun (demandes reçues qui lui sont affectées).
import { Router } from 'express'
import { z } from 'zod'
import { StatutDemande } from '../../generated/prisma/client.ts'
import { ConflictError, NotFoundError } from '../../lib/app-error.ts'
import { env } from '../../config/env.ts'
import { isUniqueViolation } from '../../lib/prisma-errors.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth, requirePage } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'
import { arrondi, enRetard, joursOuvres, SUIVIES } from '../demandes-mail/delais.ts'

export const equipesRouter = Router()
// CRM des équipes ; aussi utile pour affecter les demandes reçues
equipesRouter.use(requireAuth, requirePage('crm', 'demandes'))

const COULEURS = ['gray', 'red', 'amber', 'green', 'blue', 'violet', 'orange', 'sky'] as const
const equipeSchema = z.object({
  nom: z.string().trim().min(1, 'Indiquez un nom').max(60),
  couleur: z.enum(COULEURS).default('blue'),
  /** Membres de l'équipe (remplace la liste) */
  membres: z.array(z.string().min(1)).max(200).default([]),
})
const idParams = z.object({ id: z.string().min(1) })

const avecMembres = { membres: { select: { id: true } } } as const
const toEquipeDto = (e: { id: string; nom: string; couleur: string; membres: { id: string }[] }) => ({
  id: e.id,
  nom: e.nom,
  couleur: e.couleur,
  membres: e.membres.map((m) => m.id),
})

function nomPris(err: unknown): never {
  if (isUniqueViolation(err)) throw new ConflictError('Une équipe porte déjà ce nom')
  throw err
}

/** Période sur laquelle est mesuré le délai moyen de traitement */
const PERIODE_JOURS = 90

interface Charge {
  aTraiter: number
  total: number
  /** À traiter au-delà du délai attendu */
  enRetard: number
  /** Demandes traitées par la personne sur la période, et leur délai moyen (jours ouvrés entre la réception et le traitement) */
  traitees: number
  delaiMoyen: number | null
}

/**
 * Équipes avec leurs membres, la charge de chaque personne (demandes affectées : à traiter, en retard, total ;
 * délai moyen de traitement sur 90 jours), les demandes de devis à traiter que personne n'a encore prises,
 * et les indicateurs globaux de délai.
 */
equipesRouter.get('/', async (_req, res) => {
  const depuis = new Date(Date.now() - PERIODE_JOURS * 86_400_000)
  const [equipes, charges, retards, nonAffectees, totalRetards, traitees] = await Promise.all([
    prisma.equipe.findMany({ include: avecMembres, orderBy: { nom: 'asc' } }),
    prisma.demandeMail.groupBy({ by: ['affecteAId', 'statut'], where: { affecteAId: { not: null } }, _count: { _all: true } }),
    prisma.demandeMail.groupBy({ by: ['affecteAId'], where: { AND: [enRetard(), { affecteAId: { not: null } }] }, _count: { _all: true } }),
    prisma.demandeMail.count({ where: { affecteAId: null, statut: StatutDemande.A_TRAITER, donnees: { path: '$.demandeDevis', equals: true } } }),
    prisma.demandeMail.count({ where: enRetard() }),
    // Demandes suivies traitées (devis créé, ignorée…) sur la période
    prisma.demandeMail.findMany({
      where: { AND: [SUIVIES, { traiteLe: { gte: depuis } }] },
      select: { recuLe: true, traiteLe: true, traiteParId: true, affecteAId: true },
    }),
  ])
  const charge: Record<string, Charge> = {}
  const ligne = (id: string) => (charge[id] ??= { aTraiter: 0, total: 0, enRetard: 0, traitees: 0, delaiMoyen: null })
  for (const c of charges) {
    const l = ligne(c.affecteAId!)
    l.total += c._count._all
    if (c.statut === StatutDemande.A_TRAITER) l.aTraiter += c._count._all
  }
  for (const r of retards) ligne(r.affecteAId!).enRetard = r._count._all

  // Délai de chaque demande traitée, attribué à la personne qui l'a traitée (à défaut : à qui elle était affectée)
  const sommes = new Map<string, number>()
  let somme = 0
  for (const t of traitees) {
    const delai = joursOuvres(t.recuLe, t.traiteLe!)
    somme += delai
    const qui = t.traiteParId ?? t.affecteAId
    if (!qui) continue
    ligne(qui).traitees++
    sommes.set(qui, (sommes.get(qui) ?? 0) + delai)
  }
  for (const [qui, s] of sommes) charge[qui].delaiMoyen = arrondi(s / charge[qui].traitees)

  ok(res, {
    equipes: equipes.map(toEquipeDto),
    charge,
    nonAffectees,
    enRetard: totalRetards,
    delaiMoyen: traitees.length ? arrondi(somme / traitees.length) : null,
    traitees: traitees.length,
    delaiJours: env.DEMANDES_DELAI_JOURS,
    periodeJours: PERIODE_JOURS,
  })
})

equipesRouter.post('/', validate({ body: equipeSchema }), async (_req, res) => {
  const { nom, couleur, membres } = res.locals.body as z.infer<typeof equipeSchema>
  const e = await prisma.equipe
    .create({ data: { nom, couleur, membres: { connect: membres.map((id) => ({ id })) } }, include: avecMembres })
    .catch(nomPris)
  ok(res, toEquipeDto(e), { status: 201 })
})

equipesRouter.patch('/:id', validate({ params: idParams, body: equipeSchema.partial() }), async (_req, res) => {
  const { id } = res.locals.params as { id: string }
  const { nom, couleur, membres } = res.locals.body as Partial<z.infer<typeof equipeSchema>>
  if (!(await prisma.equipe.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError('Équipe introuvable')
  const e = await prisma.equipe
    .update({ where: { id }, data: { nom, couleur, ...(membres && { membres: { set: membres.map((m) => ({ id: m })) } }) }, include: avecMembres })
    .catch(nomPris)
  ok(res, toEquipeDto(e))
})

/** Supprime l'équipe ; ses membres et leurs demandes affectées ne changent pas. */
equipesRouter.delete('/:id', validate({ params: idParams }), async (_req, res) => {
  const { id } = res.locals.params as { id: string }
  await prisma.equipe.delete({ where: { id } }).catch(() => {
    throw new NotFoundError('Équipe introuvable')
  })
  ok(res, { id })
})
