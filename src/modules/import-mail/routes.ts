import { Router } from 'express'
import path from 'node:path'
import { z } from 'zod'
import { StatutImport, type ImportMail } from '../../generated/prisma/client.ts'
import { ConflictError, NotFoundError } from '../../lib/app-error.ts'
import { Role, statutImport } from '../../lib/labels.ts'
import { isUniqueViolation } from '../../lib/prisma-errors.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth, requireRole } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'
import { toDevisDto } from '../devis/dto.ts'
import { devisSchema, type DevisInput } from '../devis/schema.ts'
import { creerDevisDepuisImport, devisPropose, dossierStockage, etatReleve, relever, type DonneesImport } from './service.ts'

export const importsDevisRouter = Router()
importsDevisRouter.use(requireAuth, requireRole(Role.DIRECTION, Role.ADMIN, Role.ADCI))

const idParams = z.object({ id: z.string().min(1) })

function toImportDto(i: ImportMail) {
  const donnees = i.donnees as unknown as DonneesImport
  return {
    id: i.id,
    recuLe: i.recuLe.toISOString(),
    expediteur: i.expediteur,
    objet: i.objet,
    statut: statutImport.label(i.statut),
    anomalies: i.anomalies as string[],
    champs: donnees.champs ?? null,
    client: donnees.client ?? null,
    devisExistantId: donnees.devisExistantId ?? null,
    devisPropose: donnees.champs ? devisPropose(donnees) : null,
    pdfNom: i.pdfNom,
    aUnPdf: i.pdfFichier !== null,
    erreur: i.erreur,
    devisId: i.devisId,
    traiteLe: i.traiteLe?.toISOString() ?? null,
  }
}

importsDevisRouter.get('/', async (_req, res) => {
  const imports = await prisma.importMail.findMany({ orderBy: { recuLe: 'desc' }, take: 500 })
  ok(res, imports.map(toImportDto))
})

/** État de la relève + nombre d'imports à vérifier (pastille du menu). */
importsDevisRouter.get('/etat', async (_req, res) => {
  const aVerifier = await prisma.importMail.count({ where: { statut: StatutImport.A_VERIFIER } })
  ok(res, { ...etatReleve(), aVerifier })
})

importsDevisRouter.post('/relever', async (_req, res) => {
  const etat = await relever()
  const aVerifier = await prisma.importMail.count({ where: { statut: StatutImport.A_VERIFIER } })
  ok(res, { ...etat, aVerifier })
})

importsDevisRouter.get('/:id', validate({ params: idParams }), async (_req, res) => {
  const i = await prisma.importMail.findUnique({ where: { id: res.locals.params.id } })
  if (!i) throw new NotFoundError('Import introuvable')
  ok(res, { ...toImportDto(i), corps: i.corps })
})

importsDevisRouter.get('/:id/pdf', validate({ params: idParams }), async (_req, res) => {
  const i = await prisma.importMail.findUnique({ where: { id: res.locals.params.id }, select: { pdfFichier: true, pdfNom: true } })
  if (!i?.pdfFichier) throw new NotFoundError('Pas de PDF pour cet import')
  // Nom de fichier généré par le serveur (uuid) : pas de risque de sortie du dossier de stockage
  // La CSP stricte de helmet (object-src 'none') peut empêcher la visionneuse PDF du navigateur de s'afficher
  res.removeHeader('Content-Security-Policy')
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(i.pdfNom ?? 'devis.pdf')}"`)
  res.sendFile(path.join(dossierStockage(), path.basename(i.pdfFichier)))
})

/** Crée le devis à partir de l'import, avec les champs vérifiés (et éventuellement corrigés) à l'écran. */
importsDevisRouter.post('/:id/valider', validate({ params: idParams, body: devisSchema }), async (_req, res) => {
  const id = res.locals.params.id as string
  const i = await prisma.importMail.findUnique({ where: { id }, select: { statut: true } })
  if (!i) throw new NotFoundError('Import introuvable')
  if (i.statut === StatutImport.IMPORTE) throw new ConflictError('Ce devis a déjà été importé')
  try {
    const devis = await creerDevisDepuisImport(id, res.locals.body as DevisInput, res.locals.user!.id)
    ok(res, toDevisDto(devis), { status: 201 })
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('Ce numéro de devis existe déjà')
    throw err
  }
})

importsDevisRouter.post('/:id/ignorer', validate({ params: idParams }), async (_req, res) => {
  const id = res.locals.params.id as string
  const i = await prisma.importMail.findUnique({ where: { id }, select: { statut: true, anomalies: true } })
  if (!i) throw new NotFoundError('Import introuvable')
  if (i.statut === StatutImport.IMPORTE) throw new ConflictError('Ce devis a déjà été importé')
  const maj = await prisma.importMail.update({
    where: { id },
    data: { statut: StatutImport.IGNORE, traiteParId: res.locals.user!.id, traiteLe: new Date() },
  })
  ok(res, toImportDto(maj))
})

/** Remet un import ignoré dans la file « À vérifier ». */
importsDevisRouter.post('/:id/reprendre', validate({ params: idParams }), async (_req, res) => {
  const id = res.locals.params.id as string
  const i = await prisma.importMail.findUnique({ where: { id }, select: { statut: true } })
  if (!i) throw new NotFoundError('Import introuvable')
  if (i.statut !== StatutImport.IGNORE) throw new ConflictError('Seul un import ignoré peut être repris')
  const maj = await prisma.importMail.update({ where: { id }, data: { statut: StatutImport.A_VERIFIER, traiteParId: null, traiteLe: null } })
  ok(res, toImportDto(maj))
})
