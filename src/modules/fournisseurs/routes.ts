// Fournisseurs (sous-traitants, négoces, loueurs…) : liste, saisie, import de la bibliothèque Excel.
import express, { Router } from 'express'
import { z } from 'zod'
import type { Fournisseur } from '../../generated/prisma/client.ts'
import { ConflictError, NotFoundError } from '../../lib/app-error.ts'
import { lireBibliotheque, parPaquets, planifierImport, resumeImport } from '../../lib/import-referentiel.ts'
import { Role } from '../../lib/labels.ts'
import { isUniqueViolation } from '../../lib/prisma-errors.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth, requireRole } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'

export const toFournisseurDto = (f: Fournisseur) => ({
  id: f.id,
  code: f.code,
  nom: f.nom,
  famille: f.famille,
  email: f.email,
  telephone: f.telephone,
  adresse: f.adresse,
  codePostal: f.codePostal,
  ville: f.ville,
  actif: f.actif,
})

export const fournisseursRouter = Router()
fournisseursRouter.use(requireAuth)

const canWrite = requireRole(Role.DIRECTION, Role.ADMIN, Role.ADCI)
const canDelete = requireRole(Role.DIRECTION, Role.ADMIN)

const idParams = z.object({ id: z.string().min(1) })
const texte = (max: number) => z.string().trim().max(max).transform((s) => s || null).nullable().optional()
const createSchema = z.object({
  nom: z.string().trim().min(1).max(191),
  code: texte(30),
  famille: texte(60),
  email: z.email().trim().toLowerCase().nullable().optional(),
  telephone: texte(30),
  adresse: texte(191),
  codePostal: texte(10),
  ville: texte(100),
  actif: z.boolean().optional(),
})
const updateSchema = createSchema.partial()

const conflict = (err: unknown) => {
  if (isUniqueViolation(err)) throw new ConflictError('Un fournisseur existe déjà avec ce code')
  throw err
}

fournisseursRouter.get('/', async (_req, res) => {
  const liste = await prisma.fournisseur.findMany({ orderBy: { nom: 'asc' } })
  ok(res, liste.map(toFournisseurDto))
})

/** Import de la bibliothèque fournisseurs (.xlsx brut dans le corps) ; ?simulation=1 n'écrit rien. */
fournisseursRouter.post('/import', canWrite, express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
  const simulation = req.query.simulation === '1'
  const { lignes, erreurs } = lireBibliotheque(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0))
  const existants = await prisma.fournisseur.findMany({
    select: { id: true, code: true, nom: true, famille: true, email: true, telephone: true, adresse: true, codePostal: true, ville: true },
  })
  const plan = planifierImport(lignes, existants, { nomUnique: false })
  if (!simulation) {
    await parPaquets(plan.creations, 200, (paquet) => prisma.fournisseur.createMany({ data: paquet.map(({ ligne: _ligne, ...f }) => f) })).catch(conflict)
    await parPaquets(plan.misesAJour, 100, (paquet) =>
      prisma.$transaction(paquet.map((m) => prisma.fournisseur.update({ where: { id: m.id }, data: m.data }))),
    ).catch(conflict)
  }
  ok(res, resumeImport(simulation, lignes.length + erreurs.length, plan, erreurs))
})

fournisseursRouter.post('/', canWrite, validate({ body: createSchema }), async (_req, res) => {
  const f = await prisma.fournisseur.create({ data: res.locals.body as z.infer<typeof createSchema> }).catch(conflict)
  ok(res, toFournisseurDto(f), { status: 201 })
})

fournisseursRouter.patch('/:id', canWrite, validate({ params: idParams, body: updateSchema }), async (_req, res) => {
  const id = res.locals.params.id as string
  if (!(await prisma.fournisseur.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError('Fournisseur introuvable')
  const f = await prisma.fournisseur.update({ where: { id }, data: res.locals.body as z.infer<typeof updateSchema> }).catch(conflict)
  ok(res, toFournisseurDto(f))
})

fournisseursRouter.delete('/:id', canDelete, validate({ params: idParams }), async (_req, res) => {
  const id = res.locals.params.id as string
  if (!(await prisma.fournisseur.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError('Fournisseur introuvable')
  await prisma.fournisseur.delete({ where: { id } })
  ok(res, { id })
})
