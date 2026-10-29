import { Router } from 'express'
import path from 'node:path'
import { z } from 'zod'
import { BoiteDemande, StatutDemande, type CategorieDemande, type DemandeMail, type Prisma } from '../../generated/prisma/client.ts'
import { ConflictError, NotFoundError } from '../../lib/app-error.ts'
import { boiteDemande, Role, statutDemande } from '../../lib/labels.ts'
import { isUniqueViolation } from '../../lib/prisma-errors.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth, requireRole } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'
import { toDevisDto } from '../devis/dto.ts'
import { devisSchema, type DevisInput } from '../devis/schema.ts'
import { chantierSchema, mapChantierError, toChantierDto, type ChantierInput } from '../chantiers/routes.ts'
import { interventionSchema, mapInterventionError, toInterventionDto, type InterventionInput } from '../interventions/routes.ts'
import { extraireReglement } from './extract.ts'
import { mailsDuFil, regrouper, separer } from './fils.ts'
import {
  chantierPropose,
  creerChantierDepuisDemande,
  creerDevisDepuisDemande,
  lierChantier,
  marquerTraitee,
  rattacherFacture,
  creerInterventionDepuisDemande,
  devisPropose,
  dossierStockage,
  etatReleve,
  interventionProposee,
  relever,
  type DonneesDemande,
  type PieceStockee,
} from './service.ts'

export const demandesDevisRouter = Router()
demandesDevisRouter.use(requireAuth, requireRole(Role.DIRECTION, Role.ADMIN, Role.ADCI))

const idParams = z.object({ id: z.string().min(1) })
const BOITES = ['Devis', 'Intervention', 'Chantier', 'Facture'] as const

/** Les mails pas encore rangés (reçus avant les demandes d'intervention) sont dans la boîte Devis. */
const boiteDe = (d: Pick<DemandeMail, 'boite'>) => boiteDemande.label(d.boite ?? BoiteDemande.DEVIS)
const dansBoite = (boite: (typeof BOITES)[number]): Prisma.DemandeMailWhereInput =>
  boite === 'Devis' ? { OR: [{ boite: BoiteDemande.DEVIS }, { boite: null }] } : { boite: boiteDemande.key(boite) }

/** Une demande traitée (devis, intervention ou chantier créé, facture rattachée) ne peut plus changer. */
function verifierNonTraitee(d: DemandeMail) {
  if (d.statut === StatutDemande.DEVIS_CREE) throw new ConflictError('Le devis de cette demande a déjà été créé')
  if (d.statut === StatutDemande.INTERVENTION_CREEE) throw new ConflictError('L’intervention de cette demande a déjà été créée')
  if (d.statut === StatutDemande.CHANTIER_CREE) throw new ConflictError('Le chantier de cette demande a déjà été créé')
  if (d.statut === StatutDemande.FACTURE_RATTACHEE) throw new ConflictError('Ce mail est déjà rattaché à une facture')
}

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
    interventionProposee: donnees.champs ? interventionProposee(donnees as DonneesDemande) : null,
    chantierPropose: donnees.champs ? chantierPropose(donnees as DonneesDemande) : null,
    chantierId: d.chantierId,
    // Mails reçus avant la boîte Facture : lu à la volée dans l'objet et le texte
    reglementLu: donnees.reglement ?? extraireReglement([d.objet, d.corps].join('\n'), d.recuLe),
    factureId: d.factureId,
    boite: boiteDe(d),
    interventionId: d.interventionId,
    // Le nom du fichier stocké reste côté serveur : le front télécharge par index
    pieces: (d.pieces as unknown as PieceStockee[]).map((p) => ({ nom: p.nom, type: p.type })),
    erreur: d.erreur,
    devisId: d.devisId,
    traiteLe: d.traiteLe?.toISOString() ?? null,
    categorieId: d.categorieId,
    dossierId: d.dossierId,
    // Les mails pas encore rattachés forment un fil à eux seuls
    filId: d.filId ?? d.id,
  }
}

async function trouver(id: string) {
  const d = await prisma.demandeMail.findUnique({ where: { id } })
  if (!d) throw new NotFoundError('Demande introuvable')
  return d
}

/** Demandes à traiter dans chaque boîte (pastilles du menu) */
const aTraiter = async () => {
  const compter = (boite: (typeof BOITES)[number]) => prisma.demandeMail.count({ where: { statut: StatutDemande.A_TRAITER, ...dansBoite(boite) } })
  const [devis, interventions, chantiers, factures] = await Promise.all([compter('Devis'), compter('Intervention'), compter('Chantier'), compter('Facture')])
  return { aTraiter: devis, aTraiterInterventions: interventions, aTraiterChantiers: chantiers, aTraiterFactures: factures }
}

/**
 * ?boite=Intervention : les demandes d'intervention (par défaut : les demandes de devis).
 * ?dossier=<id> : les demandes du dossier et de ses sous-dossiers ; ?dossier=aucun : celles qui ne sont dans aucun dossier.
 */
const listeQuery = z.object({ dossier: z.string().min(1).optional(), boite: z.enum(BOITES).default('Devis') })
demandesDevisRouter.get('/', validate({ query: listeQuery }), async (_req, res) => {
  const { dossier, boite } = res.locals.query as z.infer<typeof listeQuery>
  const parDossier = !dossier ? {} : dossier === SANS_DOSSIER ? { dossierId: null } : { dossierId: { in: sousArbre(await dossiersPlats(), dossier) } }
  const demandes = await prisma.demandeMail.findMany({ where: { AND: [parDossier, dansBoite(boite)] }, orderBy: { recuLe: 'desc' }, take: 500 })
  ok(res, demandes.map(toDemandeDto))
})

/** État de la relève + nombre de demandes à traiter (pastille du menu). */
demandesDevisRouter.get('/etat', async (_req, res) => {
  ok(res, { ...etatReleve(), ...(await aTraiter()) })
})

/** Lance la relève sans l'attendre (elle peut durer plusieurs minutes) : le front suit l'avancement via /etat. */
demandesDevisRouter.post('/relever', async (_req, res) => {
  void relever()
  ok(res, { ...etatReleve(), ...(await aTraiter()) })
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

/** Dossiers à plat (le front construit l'arbre), avec le nombre de mails de la boîte rangés directement dans chacun. */
/** ?boite=Intervention : compteurs de la boîte Intervention (par défaut : boîte Devis). */
demandesDevisRouter.get('/dossiers', validate({ query: z.object({ boite: z.enum(BOITES).default('Devis') }) }), async (_req, res) => {
  const { boite } = res.locals.query as { boite: (typeof BOITES)[number] }
  const [dossiers, comptes] = await Promise.all([
    dossiersPlats(),
    prisma.demandeMail.groupBy({ by: ['dossierId', 'statut'], where: dansBoite(boite), _count: { _all: true } }),
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

// ─── Fils de discussion (regroupement automatique, corrigeable à la main) ───

/** Met dans un même fil les mails choisis et tout leur fil. */
demandesDevisRouter.post('/fils/regrouper', validate({ body: z.object({ ids: z.array(z.string().min(1)).min(2).max(500) }) }), async (_req, res) => {
  const filId = await regrouper((res.locals.body as { ids: string[] }).ids)
  if (!filId) throw new NotFoundError('Demandes introuvables')
  ok(res, { filId })
})

/** Sort la demande de son fil. */
demandesDevisRouter.post('/:id/separer', validate({ params: idParams }), async (_req, res) => {
  const d = await trouver(res.locals.params.id)
  await separer(d.id)
  ok(res, toDemandeDto(await trouver(d.id)))
})

demandesDevisRouter.get('/:id', validate({ params: idParams }), async (_req, res) => {
  const d = await trouver(res.locals.params.id)
  const fil = await mailsDuFil(d.id, d.filId)
  ok(res, {
    ...toDemandeDto(d),
    corps: d.corps,
    fil: fil.map((m) => ({ id: m.id, recuLe: m.recuLe.toISOString(), expediteur: m.expediteur, objet: m.objet, statut: statutDemande.label(m.statut), boite: boiteDe(m) })),
  })
})

const TYPES_AFFICHABLES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'])

demandesDevisRouter.get('/:id/pieces/:index', validate({ params: idParams.extend({ index: z.coerce.number().int().min(0) }) }), async (_req, res) => {
  const d = await trouver(res.locals.params.id)
  const p = (d.pieces as unknown as PieceStockee[])[res.locals.params.index as number]
  if (!p) throw new NotFoundError('Pièce jointe introuvable')
  // Pièce envoyée par n'importe qui : seuls les PDF et les images s'ouvrent dans le navigateur.
  // Le reste (HTML, SVG, JS…) est téléchargé, sinon il s'exécuterait sur le domaine de l'appli avec la session de l'utilisateur.
  const type = p.type.toLowerCase().split(';')[0].trim()
  const affichable = TYPES_AFFICHABLES.has(type)
  if (type === 'application/pdf') {
    // La CSP stricte de helmet (object-src 'none') peut empêcher la visionneuse PDF du navigateur de s'afficher
    res.removeHeader('Content-Security-Policy')
  } else {
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
  }
  res.setHeader('Content-Type', affichable ? type : 'application/octet-stream')
  res.setHeader('Content-Disposition', `${affichable ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(p.nom)}`)
  // Nom de fichier généré par le serveur (uuid) : pas de risque de sortie du dossier de stockage
  res.sendFile(path.join(dossierStockage(), path.basename(p.fichier)))
})

/** Crée le devis à partir de la demande, avec les champs vérifiés (et complétés) à l'écran. */
demandesDevisRouter.post('/:id/creer-devis', validate({ params: idParams, body: devisSchema }), async (_req, res) => {
  const d = await trouver(res.locals.params.id)
  verifierNonTraitee(d)
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
  verifierNonTraitee(d)
  const devis = await prisma.devis.findUnique({ where: { numero: res.locals.body.numero }, select: { id: true } })
  if (!devis) throw new NotFoundError(`Aucun devis n° ${res.locals.body.numero}`)
  await marquerTraitee(prisma, d.id, { statut: StatutDemande.DEVIS_CREE, devisId: devis.id, traiteParId: res.locals.user!.id, traiteLe: new Date() })
  ok(res, toDemandeDto(await trouver(d.id)))
})

/** Crée l'intervention à partir de la demande, avec les champs vérifiés (et complétés) à l'écran. */
demandesDevisRouter.post('/:id/creer-intervention', validate({ params: idParams, body: interventionSchema }), async (_req, res) => {
  const d = await trouver(res.locals.params.id)
  verifierNonTraitee(d)
  const intervention = await creerInterventionDepuisDemande(d.id, res.locals.body as InterventionInput, res.locals.user!.id).catch(mapInterventionError)
  ok(res, toInterventionDto(intervention), { status: 201 })
})

/** Crée le chantier à partir de la demande ; `observation` ouvre son journal (texte de la demande, corrigé à l'écran). */
demandesDevisRouter.post(
  '/:id/creer-chantier',
  validate({ params: idParams, body: chantierSchema.extend({ observation: z.string().trim().max(10_000).default('') }) }),
  async (_req, res) => {
    const d = await trouver(res.locals.params.id)
    verifierNonTraitee(d)
    const { observation, ...chantier } = res.locals.body as ChantierInput & { observation: string }
    const c = await creerChantierDepuisDemande(d.id, chantier, observation, res.locals.user!.id).catch(mapChantierError)
    ok(res, toChantierDto(c), { status: 201 })
  },
)

/** Rattache la demande à un chantier existant ; `observation` est ajoutée à son journal. */
demandesDevisRouter.post(
  '/:id/lier-chantier',
  validate({ params: idParams, body: z.object({ chantierId: z.string().min(1, 'Choisissez un chantier'), observation: z.string().trim().max(10_000).default('') }) }),
  async (_req, res) => {
    const d = await trouver(res.locals.params.id)
    verifierNonTraitee(d)
    const { chantierId, observation } = res.locals.body as { chantierId: string; observation: string }
    if (!(await prisma.chantier.findUnique({ where: { id: chantierId }, select: { id: true } }))) throw new NotFoundError('Chantier introuvable')
    ok(res, toDemandeDto(await lierChantier(d.id, chantierId, observation, res.locals.user!.id)))
  },
)

/** Rattache le mail à une facture ; `reglement` (facultatif) enregistre le paiement annoncé par le mail. */
const rattacherFactureSchema = z.object({
  factureId: z.string().min(1, 'Choisissez une facture'),
  reglement: z
    .object({ date: z.iso.date(), montant: z.number().positive('Le montant doit être positif').max(9_999_999_999), mode: z.string().trim().min(1).max(30) })
    .nullable()
    .default(null),
})
demandesDevisRouter.post('/:id/rattacher-facture', validate({ params: idParams, body: rattacherFactureSchema }), async (_req, res) => {
  const d = await trouver(res.locals.params.id)
  verifierNonTraitee(d)
  const { factureId, reglement } = res.locals.body as z.infer<typeof rattacherFactureSchema>
  if (!(await prisma.facture.findUnique({ where: { id: factureId }, select: { id: true } }))) throw new NotFoundError('Facture introuvable')
  ok(res, toDemandeDto(await rattacherFacture(d.id, factureId, reglement, res.locals.user!.id)))
})

/** Déplace la demande dans une autre boîte (mail mal rangé automatiquement). */
demandesDevisRouter.post('/:id/boite', validate({ params: idParams, body: z.object({ boite: z.enum(BOITES) }) }), async (_req, res) => {
  const d = await trouver(res.locals.params.id)
  verifierNonTraitee(d)
  const maj = await prisma.demandeMail.update({ where: { id: d.id }, data: { boite: boiteDemande.key(res.locals.body.boite) } })
  ok(res, toDemandeDto(maj))
})

demandesDevisRouter.post('/:id/ignorer', validate({ params: idParams }), async (_req, res) => {
  const d = await trouver(res.locals.params.id)
  verifierNonTraitee(d)
  await marquerTraitee(prisma, d.id, { statut: StatutDemande.IGNOREE, traiteParId: res.locals.user!.id, traiteLe: new Date() })
  ok(res, toDemandeDto(await trouver(d.id)))
})

/** Remet une demande ignorée dans la file « À traiter ». */
demandesDevisRouter.post('/:id/reprendre', validate({ params: idParams }), async (_req, res) => {
  const d = await trouver(res.locals.params.id)
  if (d.statut !== StatutDemande.IGNOREE) throw new ConflictError('Seule une demande ignorée peut être reprise')
  const maj = await prisma.demandeMail.update({ where: { id: d.id }, data: { statut: StatutDemande.A_TRAITER, traiteParId: null, traiteLe: null } })
  ok(res, toDemandeDto(maj))
})
