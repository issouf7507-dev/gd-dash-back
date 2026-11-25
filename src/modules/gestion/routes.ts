// Tableau de bord de gestion (API /gestion) : une année = prévisions, réalisé, frais généraux et salaires.
// Les salaires y figurent : tout le module est réservé à la Direction et à l'Admin.
import { exerciceVide, realiseVide, douze, TYPES_SALARIE, type ExerciceGestion as Exercice } from '@gd/shared/gestion'
import express, { Router } from 'express'
import { z } from 'zod'
import type { ExerciceGestion, Prisma, Utilisateur } from '../../generated/prisma/client.ts'
import { ConflictError, NotFoundError } from '../../lib/app-error.ts'
import { Role } from '../../lib/labels.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth, requireRole } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'
import { lireClasseurGestion } from './import-classeur.ts'

export const gestionRouter = Router()
gestionRouter.use(requireAuth, requireRole(Role.DIRECTION, Role.ADMIN))

/* ─── Validation ────────────────────────────────────────── */

const montant = z.number().finite().min(-1e12).max(1e12)
const vide = montant.nullable()
const mois12 = <T extends z.ZodTypeAny>(t: T) => z.array(t).length(12)

const parametresSchema = z.object({
  caAnnuel: montant.min(0),
  shmPrevu: montant.min(0),
  coutsDirects: z.object({ mainOeuvre: montant.min(0), materiaux: montant.min(0), autresFrais: montant.min(0), sousTraitance: montant.min(0) }),
  moisSuivis: z.number().int().min(0).max(12),
})

const previsionSchema = z.object({
  joursOuvrables: montant,
  joursFermeture: montant,
  congesPayes: montant,
  effectif: montant,
  apprentis: montant,
  interimaires: montant,
  horaireJour: montant,
  absenteisme: z.number().min(0).max(1),
  intemperiesJours: montant,
  intemperiesPart: z.number().min(0).max(1),
  formationH: montant,
  travauxEntrepriseH: montant,
  autresHNonVendables: montant,
})

const realiseSchema = z.object({
  ca: vide,
  materiaux: vide,
  autresFrais: vide,
  sousTraitance: vide,
  remboursements: vide,
  enCours: vide,
  heuresPayees: vide,
  intemperiesH: vide,
  formationH: vide,
  travauxEntrepriseH: vide,
  autresHNonVendables: vide,
})

const compteSchema = z.object({
  compte: z.string().trim().min(1).max(20),
  libelle: z.string().trim().min(1).max(120),
  prevu: mois12(montant),
  realise: mois12(vide),
})

const salaireSchema = z.object({
  nom: z.string().trim().min(1).max(120),
  type: z.enum(TYPES_SALARIE),
  brut: mois12(vide),
  charges: mois12(vide),
  heures: mois12(vide),
})

/** Sections modifiables (une ou plusieurs à la fois) */
const majSchema = z.object({
  parametres: parametresSchema.optional(),
  previsions: mois12(previsionSchema).optional(),
  realise: mois12(realiseSchema).optional(),
  fraisGeneraux: z.array(compteSchema).max(300).optional(),
  salaires: z.array(salaireSchema).max(500).optional(),
})
type Maj = z.infer<typeof majSchema>

const anneeParams = z.object({ annee: z.coerce.number().int().min(2000).max(2100) })

/* ─── Format de réponse ─────────────────────────────────── */

type AvecAuteur = ExerciceGestion & { modifiePar: Pick<Utilisateur, 'prenom' | 'nom'> | null }

/** Données enregistrées complétées par les valeurs par défaut (champs ajoutés depuis) */
function toDto(e: AvecAuteur): Exercice {
  const base = exerciceVide(e.annee)
  const realise = (e.realise as unknown as Exercice['realise']).map((r) => ({ ...realiseVide(), ...r }))
  return {
    annee: e.annee,
    parametres: { ...base.parametres, ...(e.parametres as object) } as Exercice['parametres'],
    previsions: e.previsions as unknown as Exercice['previsions'],
    realise: realise.length === 12 ? realise : douze(realiseVide),
    fraisGeneraux: e.fraisGeneraux as unknown as Exercice['fraisGeneraux'],
    salaires: e.salaires as unknown as Exercice['salaires'],
    modifieLe: e.updatedAt.toISOString(),
    modifiePar: e.modifiePar ? `${e.modifiePar.prenom} ${e.modifiePar.nom}`.trim() : null,
  }
}

const avecAuteur = { modifiePar: { select: { prenom: true, nom: true } } } satisfies Prisma.ExerciceGestionInclude
const json = (v: unknown) => v as Prisma.InputJsonValue

/* ─── Routes ────────────────────────────────────────────── */

gestionRouter.get('/exercices', async (_req, res) => {
  const liste = await prisma.exerciceGestion.findMany({ orderBy: { annee: 'desc' }, select: { annee: true, updatedAt: true } })
  ok(res, liste.map((e) => ({ annee: e.annee, modifieLe: e.updatedAt.toISOString() })))
})

gestionRouter.get('/exercices/:annee', validate({ params: anneeParams }), async (_req, res) => {
  const e = await prisma.exerciceGestion.findUnique({ where: { annee: res.locals.params.annee }, include: avecAuteur })
  if (!e) throw new NotFoundError('Aucun tableau de bord pour cette année')
  ok(res, toDto(e))
})

/**
 * Nouvelle année. Avec `depuis` : paramètres, prévisions et comptes de frais généraux (montants prévus)
 * repris de cette année ; réalisé et salaires vides, salariés repris sans montants.
 */
const creationSchema = z.object({ annee: z.number().int().min(2000).max(2100), depuis: z.number().int().min(2000).max(2100).nullable().default(null) })
gestionRouter.post('/exercices', validate({ body: creationSchema }), async (_req, res) => {
  const { annee, depuis } = res.locals.body as z.infer<typeof creationSchema>
  if (await prisma.exerciceGestion.findUnique({ where: { annee }, select: { id: true } })) throw new ConflictError(`Le tableau de bord ${annee} existe déjà`)
  const ex = exerciceVide(annee)
  if (depuis) {
    const source = await prisma.exerciceGestion.findUnique({ where: { annee: depuis }, include: avecAuteur })
    if (!source) throw new NotFoundError(`Aucun tableau de bord ${depuis} à reprendre`)
    const s = toDto(source)
    ex.parametres = { ...s.parametres, moisSuivis: 0 }
    ex.previsions = s.previsions
    ex.fraisGeneraux = s.fraisGeneraux.map((c) => ({ ...c, realise: douze(() => null) }))
    ex.salaires = s.salaires.map((l) => ({ ...l, brut: douze(() => null), charges: douze(() => null), heures: douze(() => null) }))
  }
  const e = await prisma.exerciceGestion.create({
    data: {
      annee,
      parametres: json(ex.parametres),
      previsions: json(ex.previsions),
      realise: json(ex.realise),
      fraisGeneraux: json(ex.fraisGeneraux),
      salaires: json(ex.salaires),
      modifieParId: res.locals.user!.id,
    },
    include: avecAuteur,
  })
  ok(res, toDto(e), { status: 201 })
})

gestionRouter.patch('/exercices/:annee', validate({ params: anneeParams, body: majSchema }), async (_req, res) => {
  const annee = res.locals.params.annee as number
  const maj = res.locals.body as Maj
  if (!(await prisma.exerciceGestion.findUnique({ where: { annee }, select: { id: true } }))) throw new NotFoundError('Aucun tableau de bord pour cette année')
  const e = await prisma.exerciceGestion.update({
    where: { annee },
    data: {
      ...(maj.parametres && { parametres: json(maj.parametres) }),
      ...(maj.previsions && { previsions: json(maj.previsions) }),
      ...(maj.realise && { realise: json(maj.realise) }),
      ...(maj.fraisGeneraux && { fraisGeneraux: json(maj.fraisGeneraux) }),
      ...(maj.salaires && { salaires: json(maj.salaires) }),
      modifieParId: res.locals.user!.id,
    },
    include: avecAuteur,
  })
  ok(res, toDto(e))
})

gestionRouter.delete('/exercices/:annee', validate({ params: anneeParams }), async (_req, res) => {
  const { count } = await prisma.exerciceGestion.deleteMany({ where: { annee: res.locals.params.annee } })
  if (!count) throw new NotFoundError('Aucun tableau de bord pour cette année')
  ok(res, { annee: res.locals.params.annee })
})

/**
 * Import du classeur Excel « Tableau de bord » (fichier brut dans le corps).
 * ?simulation=1 : renvoie ce qui serait importé, sans rien écrire. L'année lue dans le classeur remplace la sienne si elle existe.
 */
gestionRouter.post('/import', express.raw({ type: () => true, limit: '25mb' }), async (req, res) => {
  const simulation = req.query.simulation === '1'
  const anneeParDefaut = Number(req.query.annee) || new Date().getFullYear()
  const { exercice: ex, resume } = lireClasseurGestion(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), anneeParDefaut)
  const existe = !!(await prisma.exerciceGestion.findUnique({ where: { annee: ex.annee }, select: { id: true } }))
  if (!simulation) {
    const data = {
      parametres: json(ex.parametres),
      previsions: json(ex.previsions),
      realise: json(ex.realise),
      fraisGeneraux: json(ex.fraisGeneraux),
      salaires: json(ex.salaires),
      modifieParId: res.locals.user!.id,
    }
    await prisma.exerciceGestion.upsert({ where: { annee: ex.annee }, create: { annee: ex.annee, ...data }, update: data })
  }
  ok(res, { simulation, remplace: existe, ...resume })
})
