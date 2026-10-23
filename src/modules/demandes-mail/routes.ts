import { Router } from 'express'
import path from 'node:path'
import { z } from 'zod'
import { StatutDemande, type CategorieDemande, type DemandeMail } from '../../generated/prisma/client.ts'
import { ConflictError, NotFoundError } from '../../lib/app-error.ts'
import { Role, statutDemande } from '../../lib/labels.ts'
import { isUniqueViolation } from '../../lib/prisma-errors.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth, requireRole } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'
import { toDevisDto } from '../devis/dto.ts'
import { devisSchema, type DevisInput } from '../devis/schema.ts'
import { creerDevisDepuisDemande, devisPropose, dossierStockage, etatReleve, relever, type DonneesDemande, type PieceStockee } from './service.ts'

export const demandesDevisRouter = Router()
demandesDevisRouter.use(requireAuth, requireRole(Role.DIRECTION, Role.ADMIN, Role.ADCI))

const idParams = z.object({ id: z.string().min(1) })

function toDemandeDto(d: DemandeMail) {
  const donnees = d.donnees as unknown as Partial<DonneesDemande>
  return {
    id: d.id,
    recuLe: d.recuLe.toISOString(),
    expediteur: d.expediteur,
    objet: d.objet,
    statut: statutDemande.label(d.statut),
    anomalies: d.anomalies as string[],
    champs: donnees.champs ?? null,
    client: donnees.client ?? null,
    doublonDeId: donnees.doublonDeId ?? null,
    devisPropose: donnees.champs ? devisPropose(donnees as DonneesDemande) : null,
    // Le nom du fichier stocké reste côté serveur : le front télécharge par index
    pieces: (d.pieces as unknown as PieceStockee[]).map((p) => ({ nom: p.nom, type: p.type })),
    erreur: d.erreur,
    devisId: d.devisId,
    traiteLe: d.traiteLe?.toISOString() ?? null,
    categorieId: d.categorieId,
    dossierId: d.dossierId,
  }
}

async function trouver(id: string) {
  const d = await prisma.demandeMail.findUnique({ where: { id } })
  if (!d) throw new NotFoundError('Demande introuvable')
  return d
}

const aTraiter = () => prisma.demandeMail.count({ where: { statut: StatutDemande.A_TRAITER } })

/** ?dossier=<id> : les demandes du dossier et de ses sous-dossiers ; ?dossier=aucun : celles qui ne sont dans aucun dossier. */
demandesDevisRouter.get('/', validate({ query: z.object({ dossier: z.string().min(1).optional() }) }), async (_req, res) => {
  const { dossier } = res.locals.query as { dossier?: string }
  const where = !dossier ? {} : dossier === SANS_DOSSIER ? { dossierId: null } : { dossierId: { in: sousArbre(await dossiersPlats(), dossier) } }
  const demandes = await prisma.demandeMail.findMany({ where, orderBy: { recuLe: 'desc' }, take: 500 })
  ok(res, demandes.map(toDemandeDto))
})

/** État de la relève + nombre de demandes à traiter (pastille du menu). */
demandesDevisRouter.get('/etat', async (_req, res) => {
  ok(res, { ...etatReleve(), aTraiter: await aTraiter() })
})

/** Lance la relève sans l'attendre (elle peut durer plusieurs minutes) : le front suit l'avancement via /etat. */
demandesDevisRouter.post('/relever', async (_req, res) => {
  void relever()
  ok(res, { ...etatReleve(), aTraiter: await aTraiter() })
})

// ─── Catégories (rangement manuel, une catégorie par demande) ───

const COULEURS = ['gray', 'red', 'amber', 'green', 'blue', 'violet', 'orange', 'sky'] as const
const categorieSchema = z.object({ nom: z.string().trim().min(1, 'Indiquez un nom').max(60), couleur: z.enum(COULEURS) })

const toCategorieDto = (c: CategorieDemande) => ({ id: c.id, nom: c.nom, couleur: c.couleur })
const nomPris = (err: unknown): never => {
  if (isUniqueViolation(err)) throw new ConflictError('Une catégorie porte déjà ce nom')
  throw err
}

demandesDevisRouter.get('/categories', async (_req, res) => {
  const categories = await prisma.categorieDemande.findMany({ orderBy: { nom: 'asc' } })
  ok(res, categories.map(toCategorieDto))
})

demandesDevisRouter.post('/categories', validate({ body: categorieSchema }), async (_req, res) => {
  const c = await prisma.categorieDemande.create({ data: res.locals.body }).catch(nomPris)
  ok(res, toCategorieDto(c), { status: 201 })
})

demandesDevisRouter.patch('/categories/:id', validate({ params: idParams, body: categorieSchema.partial() }), async (_req, res) => {
  const id = res.locals.params.id as string
  if (!(await prisma.categorieDemande.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError('Catégorie introuvable')
  const c = await prisma.categorieDemande.update({ where: { id }, data: res.locals.body }).catch(nomPris)
  ok(res, toCategorieDto(c))
})

/** Les demandes de la catégorie ne sont pas supprimées : elles redeviennent « sans catégorie ». */
demandesDevisRouter.delete('/categories/:id', validate({ params: idParams }), async (_req, res) => {
  const id = res.locals.params.id as string
  if (!(await prisma.categorieDemande.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError('Catégorie introuvable')
  await prisma.categorieDemande.delete({ where: { id } })
  ok(res, { id })
})

/** Range une ou plusieurs demandes dans une catégorie (null : les sort de leur catégorie). */
demandesDevisRouter.post(
  '/ranger',
  validate({ body: z.object({ ids: z.array(z.string().min(1)).min(1).max(500), categorieId: z.string().min(1).nullable() }) }),
  async (_req, res) => {
    const { ids, categorieId } = res.locals.body as { ids: string[]; categorieId: string | null }
    if (categorieId && !(await prisma.categorieDemande.findUnique({ where: { id: categorieId }, select: { id: true } })))
      throw new NotFoundError('Catégorie introuvable')
    const { count } = await prisma.demandeMail.updateMany({ where: { id: { in: ids } }, data: { categorieId } })
    ok(res, { count })
  },
)

// ─── Dossiers (arborescence, un dossier par demande, indépendant de la catégorie) ───

const SANS_DOSSIER = 'aucun'
const dossierSchema = z.object({ nom: z.string().trim().min(1, 'Indiquez un nom').max(60), parentId: z.string().min(1).nullable().optional() })

const dossiersPlats = () => prisma.dossierDemande.findMany({ select: { id: true, nom: true, parentId: true }, orderBy: { nom: 'asc' } })

/** Le dossier et tous ses sous-dossiers. */
function sousArbre(dossiers: { id: string; parentId: string | null }[], racine: string) {
  const ids = [racine]
  for (let i = 0; i < ids.length; i++) for (const d of dossiers) if (d.parentId === ids[i]) ids.push(d.id)
  return ids
}

async function trouverDossier(id: string) {
  const d = await prisma.dossierDemande.findUnique({ where: { id } })
  if (!d) throw new NotFoundError('Dossier introuvable')
  return d
}

/** Deux dossiers de même parent ne peuvent pas porter le même nom. */
async function verifierNomLibre(nom: string, parentId: string | null, saufId?: string) {
  const doublon = await prisma.dossierDemande.findFirst({ where: { nom, parentId, ...(saufId && { NOT: { id: saufId } }) }, select: { id: true } })
  if (doublon) throw new ConflictError('Un dossier porte déjà ce nom à cet endroit')
}

/** Dossiers à plat (le front construit l'arbre), avec le nombre de mails rangés directement dans chacun. */
demandesDevisRouter.get('/dossiers', async (_req, res) => {
  const [dossiers, comptes] = await Promise.all([
    dossiersPlats(),
    prisma.demandeMail.groupBy({ by: ['dossierId', 'statut'], _count: { _all: true } }),
  ])
  const compter = (filtre: (c: (typeof comptes)[number]) => boolean) => {
    const lignes = comptes.filter(filtre)
    return {
      mails: lignes.reduce((s, c) => s + c._count._all, 0),
      aTraiter: lignes.filter((c) => c.statut === StatutDemande.A_TRAITER).reduce((s, c) => s + c._count._all, 0),
    }
  }
  ok(res, {
    dossiers: dossiers.map((d) => ({ ...d, ...compter((c) => c.dossierId === d.id) })),
    sansDossier: compter((c) => c.dossierId === null),
    tous: compter(() => true),
  })
})

demandesDevisRouter.post('/dossiers', validate({ body: dossierSchema }), async (_req, res) => {
  const { nom, parentId = null } = res.locals.body as z.infer<typeof dossierSchema>
  if (parentId) await trouverDossier(parentId)
  await verifierNomLibre(nom, parentId)
  const d = await prisma.dossierDemande.create({ data: { nom, parentId }, select: { id: true, nom: true, parentId: true } })
  ok(res, d, { status: 201 })
})

/** Renomme et/ou déplace un dossier (parentId null : à la racine). */
demandesDevisRouter.patch('/dossiers/:id', validate({ params: idParams, body: dossierSchema.partial() }), async (_req, res) => {
  const actuel = await trouverDossier(res.locals.params.id as string)
  const body = res.locals.body as Partial<z.infer<typeof dossierSchema>>
  const nom = body.nom ?? actuel.nom
  const parentId = body.parentId === undefined ? actuel.parentId : body.parentId
  if (parentId) {
    await trouverDossier(parentId)
    if (sousArbre(await dossiersPlats(), actuel.id).includes(parentId))
      throw new ConflictError('Un dossier ne peut pas être déplacé dans lui-même ni dans un de ses sous-dossiers')
  }
  await verifierNomLibre(nom, parentId, actuel.id)
  const d = await prisma.dossierDemande.update({ where: { id: actuel.id }, data: { nom, parentId }, select: { id: true, nom: true, parentId: true } })
  ok(res, d)
})

/** Supprime le dossier et ses sous-dossiers ; leurs demandes ne sont pas supprimées : elles redeviennent « sans dossier ». */
demandesDevisRouter.delete('/dossiers/:id', validate({ params: idParams }), async (_req, res) => {
  const { id } = await trouverDossier(res.locals.params.id as string)
  await prisma.dossierDemande.delete({ where: { id } })
  ok(res, { id })
})

/** Classe une ou plusieurs demandes dans un dossier (null : les sort de leur dossier). */
demandesDevisRouter.post(
  '/classer',
  validate({ body: z.object({ ids: z.array(z.string().min(1)).min(1).max(500), dossierId: z.string().min(1).nullable() }) }),
  async (_req, res) => {
    const { ids, dossierId } = res.locals.body as { ids: string[]; dossierId: string | null }
    if (dossierId) await trouverDossier(dossierId)
    const { count } = await prisma.demandeMail.updateMany({ where: { id: { in: ids } }, data: { dossierId } })
    ok(res, { count })
  },
)

demandesDevisRouter.get('/:id', validate({ params: idParams }), async (_req, res) => {
  const d = await trouver(res.locals.params.id)
  ok(res, { ...toDemandeDto(d), corps: d.corps })
})

demandesDevisRouter.get('/:id/pieces/:index', validate({ params: idParams.extend({ index: z.coerce.number().int().min(0) }) }), async (_req, res) => {
  const d = await trouver(res.locals.params.id)
  const p = (d.pieces as unknown as PieceStockee[])[res.locals.params.index as number]
  if (!p) throw new NotFoundError('Pièce jointe introuvable')
  // La CSP stricte de helmet (object-src 'none') peut empêcher la visionneuse PDF du navigateur de s'afficher
  res.removeHeader('Content-Security-Policy')
  res.setHeader('Content-Type', p.type)
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(p.nom)}`)
  // Nom de fichier généré par le serveur (uuid) : pas de risque de sortie du dossier de stockage
  res.sendFile(path.join(dossierStockage(), path.basename(p.fichier)))
})

/** Crée le devis à partir de la demande, avec les champs vérifiés (et complétés) à l'écran. */
demandesDevisRouter.post('/:id/creer-devis', validate({ params: idParams, body: devisSchema }), async (_req, res) => {
  const d = await trouver(res.locals.params.id)
  if (d.statut === StatutDemande.DEVIS_CREE) throw new ConflictError('Le devis de cette demande a déjà été créé')
  try {
    const devis = await creerDevisDepuisDemande(d.id, res.locals.body as DevisInput, res.locals.user!.id)
    ok(res, toDevisDto(devis), { status: 201 })
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError('Ce numéro de devis existe déjà')
    throw err
  }
})

/** Rattache la demande à un devis déjà enregistré (ex. arrivé par l'import SolutionsBTP). */
demandesDevisRouter.post('/:id/lier', validate({ params: idParams, body: z.object({ numero: z.string().trim().min(1, 'Indiquez le n° du devis') }) }), async (_req, res) => {
  const d = await trouver(res.locals.params.id)
  if (d.statut === StatutDemande.DEVIS_CREE) throw new ConflictError('Cette demande est déjà rattachée à un devis')
  const devis = await prisma.devis.findUnique({ where: { numero: res.locals.body.numero }, select: { id: true } })
  if (!devis) throw new NotFoundError(`Aucun devis n° ${res.locals.body.numero}`)
  const maj = await prisma.demandeMail.update({
    where: { id: d.id },
    data: { statut: StatutDemande.DEVIS_CREE, devisId: devis.id, traiteParId: res.locals.user!.id, traiteLe: new Date() },
  })
  ok(res, toDemandeDto(maj))
})

demandesDevisRouter.post('/:id/ignorer', validate({ params: idParams }), async (_req, res) => {
  const d = await trouver(res.locals.params.id)
  if (d.statut === StatutDemande.DEVIS_CREE) throw new ConflictError('Le devis de cette demande a déjà été créé')
  const maj = await prisma.demandeMail.update({
    where: { id: d.id },
    data: { statut: StatutDemande.IGNOREE, traiteParId: res.locals.user!.id, traiteLe: new Date() },
  })
  ok(res, toDemandeDto(maj))
})

/** Remet une demande ignorée dans la file « À traiter ». */
demandesDevisRouter.post('/:id/reprendre', validate({ params: idParams }), async (_req, res) => {
  const d = await trouver(res.locals.params.id)
  if (d.statut !== StatutDemande.IGNOREE) throw new ConflictError('Seule une demande ignorée peut être reprise')
  const maj = await prisma.demandeMail.update({ where: { id: d.id }, data: { statut: StatutDemande.A_TRAITER, traiteParId: null, traiteLe: null } })
  ok(res, toDemandeDto(maj))
})
