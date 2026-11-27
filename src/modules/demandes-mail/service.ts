// Demandes des clients relevées dans la boîte contact@ (Outlook) : décodage, extraction,
// enregistrement dans la file demandes_mail (« À traiter »), rangée dans la boîte Devis ou Intervention,
// puis création du devis ou de l'intervention depuis l'écran.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../../config/env.ts'
import { BoiteDemande, Prisma, ResultatDevis, SourceDevis, StatutDemande, type Role } from '../../generated/prisma/client.ts'
import { ConflictError } from '../../lib/app-error.ts'
import { logger } from '../../lib/logger.ts'
import { isUniqueViolation } from '../../lib/prisma-errors.ts'
import { prisma } from '../../lib/prisma.ts'
import { toDevisCreate, type DevisInput } from '../devis/schema.ts'
import { boiteDemande } from '../../lib/labels.ts'
import { toChantierData, type ChantierInput } from '../chantiers/routes.ts'
import { avecEquipe, demanderValidation, toInterventionData, validationCreation, type InterventionInput } from '../interventions/routes.ts'
import { decoderMail } from '../import-mail/lecture.ts'
import type { Rapprochement } from '../import-mail/match-client.ts'
import { sourceDossier } from '../import-mail/sources/dossier.ts'
import { sourceGraph } from '../import-mail/sources/graph.ts'
import type { Progression, SourceMails } from '../import-mail/sources/types.ts'
import { boiteDe, DOSSIERS_AUTO, dossierAutoDe, estMailDeDemandeDevis, extraireDemande, numerosDevisCites, resultatDevisDans, rapprocherClientDemande, type ChampsDemande, type ReglementLu } from './extract.ts'
import { emailDe, rattacherAuFil } from './fils.ts'

/** Contenu de la colonne `donnees` d'une demande. */
export interface DonneesDemande {
  champs: ChampsDemande
  client: Rapprochement
  /** Autre demande déjà reçue avec la même référence (ex. mail envoyé sur deux adresses) */
  doublonDeId?: string
  /** Paiement ou facture cités (mails reçus depuis la boîte Facture) */
  reglement?: ReglementLu
  /** Dossier automatique où le mail a été rangé une fois (il n'y est pas remis s'il en est sorti à la main) */
  dossierAuto?: string
  /** Demande de devis écrite par un client : affichée dans la rubrique « Demandes de devis » */
  demandeDevis?: boolean
}

/** Contenu de la colonne `pieces`. */
export interface PieceStockee {
  nom: string
  fichier: string
  type: string
}

export const dossierStockage = () => path.resolve(env.DEMANDES_STOCKAGE)

export function sourceConfiguree(): SourceMails | null {
  if (env.DEMANDES_SOURCE === 'dossier') return sourceDossier(path.resolve(env.DEMANDES_DOSSIER))
  if (env.DEMANDES_SOURCE === 'graph') {
    return sourceGraph({
      tenantId: env.GRAPH_TENANT_ID,
      clientId: env.GRAPH_CLIENT_ID,
      clientSecret: env.GRAPH_CLIENT_SECRET,
      boite: env.GRAPH_BOITE,
      dossier: env.GRAPH_DOSSIER,
      jours: env.DEMANDES_JOURS,
    })
  }
  return null
}

/** Points à vérifier avant de créer le devis. */
export function anomaliesDe(d: DonneesDemande, lisible: boolean): string[] {
  const a: string[] = []
  const c = d.champs
  if (!lisible) a.push('Contenu illisible (PDF scanné ?) : à lire dans la pièce jointe')
  if (d.client.confiance === 'aucun') a.push(c.clientNom ? `Client inconnu : ${c.clientNom}` : 'Client à identifier')
  if (d.client.confiance === 'proche') a.push('Client à confirmer')
  if (!c.adresse) a.push('Adresse des travaux introuvable')
  if (!c.categorie) a.push('Catégorie non détectée')
  if (d.doublonDeId) a.push(`Déjà reçue (réf. ${c.reference})`)
  return a
}

/** Champs du devis pré-remplis à partir de la demande. Le n° de devis (SolutionsBTP) reste à saisir. */
export function devisPropose(d: DonneesDemande): Partial<DevisInput> {
  const c = d.champs
  const infos = [
    c.reference && `${c.type === 'Autre' ? 'Réf. client' : c.type} : ${c.reference}`,
    c.gestionnaire && `Gestionnaire : ${c.gestionnaire}`,
    c.acces && `Accès : ${c.acces}`,
    c.contacts.length > 0 && `Contacts sur place : ${c.contacts.join(' ; ')}`,
    c.urgent && 'URGENT',
  ].filter(Boolean)
  return {
    numero: '',
    dateReception: c.dateDemande,
    ...(c.categorie && { categorie: c.categorie }),
    ...(d.client.clientId && { clientId: d.client.clientId }),
    adresse: c.adresse ?? '',
    descriptif: c.descriptif ?? '',
    commentaires: infos.join('\n'),
    montantHT: null,
    statutADCI: 'Non traité',
    planification: 'À planifier',
  }
}

/** Champs de l'intervention pré-remplis à partir de la demande. Le n° d'intervention reste à saisir. */
export function interventionProposee(d: DonneesDemande): Partial<InterventionInput> {
  const { numero: _numero, dateReception: _date, montantHT: _montant, ...commun } = devisPropose(d)
  return { ...commun, numero: '', technicienId: null, datePassage: null }
}

/** Statuts d'une demande déjà traitée : elle ne peut plus être traitée une seconde fois. */
const STATUTS_TRAITES = [StatutDemande.DEVIS_CREE, StatutDemande.INTERVENTION_CREEE, StatutDemande.CHANTIER_CREE, StatutDemande.FACTURE_RATTACHEE]

/**
 * Passe la demande au statut donné, seulement si elle n'est pas déjà traitée. Fait en une seule requête
 * (verrou sur la ligne) : deux clics ou deux collègues en même temps ne créent pas deux devis ni deux règlements.
 */
export async function marquerTraitee(db: Prisma.TransactionClient, demandeId: string, data: Prisma.DemandeMailUncheckedUpdateManyInput) {
  const { count } = await db.demandeMail.updateMany({ where: { id: demandeId, statut: { notIn: STATUTS_TRAITES } }, data })
  if (!count) throw new ConflictError('Cette demande vient d’être traitée par ailleurs')
}

/** Crée l'intervention à partir d'une demande et la marque « Intervention créée », en une seule transaction. */
export async function creerInterventionDepuisDemande(demandeId: string, input: InterventionInput, user: { id: string; role: Role; prenom: string; nom: string }) {
  // Validée d'office si la Direction ou l'Admin la crée, sinon à valider
  const data = { ...(await toInterventionData(input, true)), ...validationCreation(user) } as Prisma.InterventionUncheckedCreateInput
  const intervention = await prisma.$transaction(async (tx) => {
    await marquerTraitee(tx, demandeId, { statut: StatutDemande.INTERVENTION_CREEE, traiteParId: user.id, traiteLe: new Date() })
    const i = await tx.intervention.create({ data, include: avecEquipe })
    await tx.demandeMail.update({ where: { id: demandeId }, data: { interventionId: i.id } })
    return i
  })
  if (intervention.validation === 'A_VALIDER') await demanderValidation(intervention, user, false)
  return intervention
}

/** Champs du chantier pré-remplis à partir de la demande. Le n° de chantier reste à saisir. */
export function chantierPropose(d: DonneesDemande): Partial<ChantierInput> & { observation: string } {
  const { clientId, adresse, categorie, descriptif, commentaires } = devisPropose(d)
  return {
    numero: '',
    devisNumeros: [],
    ...(clientId && { clientId }),
    adresse: adresse ?? '',
    ...(categorie && { categorie }),
    statut: 'À venir',
    // Le chantier n'a pas de descriptif : la demande ouvre son journal
    observation: [descriptif, commentaires].filter(Boolean).join('\n\n'),
  }
}

/**
 * Crée le chantier à partir d'une demande, ouvre son journal avec le texte de la demande (s'il y en a un)
 * et marque la demande « Chantier créé », en une seule transaction.
 */
export async function creerChantierDepuisDemande(demandeId: string, input: ChantierInput, observation: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    await marquerTraitee(tx, demandeId, { statut: StatutDemande.CHANTIER_CREE, traiteParId: userId, traiteLe: new Date() })
    const chantier = await tx.chantier.create({ data: toChantierData(input) as Prisma.ChantierUncheckedCreateInput })
    if (observation.trim()) {
      await tx.observation.create({ data: { chantierId: chantier.id, date: new Date(new Date().toISOString().slice(0, 10)), texte: observation.trim(), auteurId: userId } })
    }
    await tx.demandeMail.update({ where: { id: demandeId }, data: { chantierId: chantier.id } })
    return chantier
  })
}

/** Rattache la demande à un chantier existant (ex. compte-rendu d'un chantier en cours) et ajoute son texte au journal. */
export async function lierChantier(demandeId: string, chantierId: string, observation: string, userId: string) {
  return prisma.$transaction(async (tx) => {
    await marquerTraitee(tx, demandeId, { statut: StatutDemande.CHANTIER_CREE, chantierId, traiteParId: userId, traiteLe: new Date() })
    if (observation.trim()) {
      await tx.observation.create({ data: { chantierId, date: new Date(new Date().toISOString().slice(0, 10)), texte: observation.trim(), auteurId: userId } })
    }
    return tx.demandeMail.findUniqueOrThrow({ where: { id: demandeId } })
  })
}

/**
 * Rattache la demande à une facture et, si le mail annonce un paiement, enregistre le règlement,
 * puis marque la demande « Facture rattachée », en une seule transaction.
 */
export async function rattacherFacture(
  demandeId: string,
  factureId: string,
  reglement: { date: string; montant: number; mode: string } | null,
  userId: string,
) {
  return prisma.$transaction(async (tx) => {
    await marquerTraitee(tx, demandeId, { statut: StatutDemande.FACTURE_RATTACHEE, factureId, traiteParId: userId, traiteLe: new Date() })
    if (reglement) await tx.reglement.create({ data: { factureId, montant: reglement.montant, mode: reglement.mode, date: new Date(reglement.date) } })
    return tx.demandeMail.findUniqueOrThrow({ where: { id: demandeId } })
  })
}

/** Crée le devis à partir d'une demande et la marque « Devis créé », en une seule transaction. */
export async function creerDevisDepuisDemande(demandeId: string, input: DevisInput, userId: string) {
  return prisma.$transaction(async (tx) => {
    await marquerTraitee(tx, demandeId, { statut: StatutDemande.DEVIS_CREE, traiteParId: userId, traiteLe: new Date() })
    const devis = await tx.devis.create({ data: { ...toDevisCreate(input), source: SourceDevis.MAIL } })
    await tx.demandeMail.update({ where: { id: demandeId }, data: { devisId: devis.id } })
    return devis
  })
}

async function stockerPiece(contenu: Buffer, nom: string) {
  await mkdir(dossierStockage(), { recursive: true })
  const ext = path.extname(nom).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6) || '.bin'
  const fichier = `${randomUUID()}${ext}`
  await writeFile(path.join(dossierStockage(), fichier), contenu)
  return fichier
}

/** Dossier automatique à la racine, créé s'il n'existe pas (une seule création à la fois par dossier). */
const dossiersEnCours = new Map<string, Promise<string>>()
function dossierAuto(nom: string): Promise<string> {
  let p = dossiersEnCours.get(nom)
  if (!p) {
    p = (async () => {
      const existant = await prisma.dossierDemande.findFirst({ where: { nom, parentId: null }, select: { id: true } })
      return existant?.id ?? (await prisma.dossierDemande.create({ data: { nom, parentId: null }, select: { id: true } })).id
    })().finally(() => dossiersEnCours.delete(nom))
    dossiersEnCours.set(nom, p)
  }
  return p
}

const MOTIF_IGNOREE = 'Ce mail ne ressemble ni à une demande de devis ni à une demande d’intervention'
/** Motif des mails écartés avant la mise en place des demandes d'intervention */
const ANCIEN_MOTIF_IGNOREE = 'Ce mail ne ressemble pas à une demande de devis'

export type ResultatTraitement = 'à traiter' | 'ignorée' | 'erreur' | 'déjà traitée'

/** Traite un mail brut. Ne lève pas d'erreur : un mail illisible est enregistré en « Erreur ». */
export async function traiterMail(brut: Buffer, ref: string): Promise<ResultatTraitement> {
  const empreinte = `sans-id:${createHash('sha256').update(brut).digest('hex').slice(0, 32)}`
  let mail
  try {
    mail = await decoderMail(brut, empreinte)
  } catch (err) {
    logger.warn({ err, ref }, 'demandes mail : mail illisible')
    await prisma.demandeMail
      .create({
        data: {
          messageId: empreinte,
          recuLe: new Date(),
          expediteur: '',
          objet: `(mail illisible : ${ref})`,
          corps: '',
          statut: StatutDemande.ERREUR,
          donnees: {},
          anomalies: [],
          pieces: [],
          erreur: err instanceof Error ? err.message : String(err),
        },
      })
      .catch((e) => {
        if (!isUniqueViolation(e)) throw e
      })
    return 'erreur'
  }

  if (await prisma.demandeMail.findUnique({ where: { messageId: mail.messageId }, select: { id: true } })) return 'déjà traitée'

  const { estUneDemande, boite, champs, reglement } = extraireDemande(mail)
  const clients = await prisma.client.findMany({ where: { actif: true }, select: { id: true, nom: true, email: true } })
  const donnees: DonneesDemande = {
    champs,
    client: rapprocherClientDemande(clients, champs, [mail.objet, mail.corps, mail.textePdf].join('\n')),
    reglement,
  }
  if (champs.reference) {
    const doublon = await prisma.demandeMail.findFirst({
      where: { donnees: { path: '$.champs.reference', equals: champs.reference }, statut: { not: StatutDemande.IGNOREE } },
      select: { id: true },
    })
    if (doublon) donnees.doublonDeId = doublon.id
  }

  // Un mail avec un PDF dont on ne tire aucun texte (scan) est gardé : on ne sait pas ce qu'il contient
  const illisible = mail.pdfs.length > 0 && !mail.textePdf.trim() && !mail.corps.trim()
  const auto = dossierAutoDe({
    texte: [mail.objet, mail.corps].join('\n'),
    expediteur: mail.expediteur.email,
    nomsPieces: mail.pieces.map((p) => p.nom),
    textePdf: mail.textePdf,
  })
  if (auto) donnees.dossierAuto = auto.nom
  if (!auto?.ecarter && estMailDeDemandeDevis(mail.objet, mail.corps, mail.expediteur.email)) donnees.demandeDevis = true
  const ecarte = !!auto?.ecarter
  let statut: StatutDemande = StatutDemande.A_TRAITER
  let anomalies: string[]
  if (ecarte) {
    // CV, publicité, fournisseur… : pas une demande client, écartée de la file mais rangée dans son dossier
    statut = StatutDemande.IGNOREE
    anomalies = [auto!.motif]
  } else if (!estUneDemande && !illisible) {
    statut = StatutDemande.IGNOREE
    anomalies = [MOTIF_IGNOREE]
  } else {
    anomalies = anomaliesDe(donnees, !illisible)
  }

  // Pièces jointes conservées même pour un mail ignoré : il peut être remis « À traiter »
  const pieces: PieceStockee[] = []
  for (const p of mail.pieces) pieces.push({ nom: p.nom, type: p.type, fichier: await stockerPiece(p.contenu, p.nom) })

  let id: string
  try {
    const cree = await prisma.demandeMail.create({
      data: {
        messageId: mail.messageId,
        refsFil: mail.refsFil,
        recuLe: mail.date,
        // Colonne VARCHAR(255) : certains en-têtes From ont un nom à rallonge
        expediteur: (mail.expediteur.nom ? `${mail.expediteur.nom} <${mail.expediteur.email}>` : mail.expediteur.email).slice(0, 255),
        objet: mail.objet.slice(0, 500),
        corps: mail.corps.slice(0, 20_000),
        statut,
        // Les mails écartés restent ensemble dans la boîte Devis (boîte générale de contact@)
        boite: ecarte ? BoiteDemande.DEVIS : boiteDemande.key(boite),
        ...(auto && { dossierId: await dossierAuto(auto.nom) }),
        donnees: donnees as unknown as Prisma.InputJsonValue,
        anomalies,
        pieces: pieces as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
    id = cree.id
  } catch (err) {
    // Rien n'est enregistré : on ne garde pas les pièces jointes orphelines
    await Promise.all(pieces.map((p) => rm(path.join(dossierStockage(), p.fichier), { force: true })))
    // Même mail enregistré entre-temps par une autre relève (ex. deux instances pendant un redémarrage)
    if (isUniqueViolation(err)) return 'déjà traitée'
    throw err
  }
  // Le mail est enregistré : un échec du regroupement ne doit pas le faire retraiter
  await rattacherAuFil(id).catch((err) => logger.warn({ err, id }, 'demandes mail : rattachement au fil impossible'))
  // Accord ou refus d'un devis écrit par le client : reporté sur le devis
  await appliquerResultatDevis(id).catch((err) => logger.warn({ err, id }, 'demandes mail : lecture de la réponse au devis impossible'))
  return statut === StatutDemande.IGNOREE ? 'ignorée' : 'à traiter'
}

// ─── Relève ──────────────────────────────────────────────────

export interface EtatReleve {
  source: string | null
  enCours: boolean
  derniereReleve: string | null
  dernierResultat: Partial<Record<ResultatTraitement, number>> | null
  derniereErreur: string | null
  /** Avancement de la relève en cours (null hors relève) */
  progression: Progression | null
}

const etat: EtatReleve = { source: null, enCours: false, derniereReleve: null, dernierResultat: null, derniereErreur: null, progression: null }
export const etatReleve = () => ({ ...etat, source: sourceConfiguree()?.nom ?? null })

/** Relève la source configurée. Une seule relève à la fois (les appels concurrents attendent la même). */
let releveEnCours: Promise<EtatReleve> | null = null
export function relever(source = sourceConfiguree()): Promise<EtatReleve> {
  if (!source) return Promise.resolve(etatReleve())
  releveEnCours ??= (async () => {
    etat.enCours = true
    etat.derniereErreur = null
    const compte: Partial<Record<ResultatTraitement, number>> = {}
    try {
      const dejaTraite = async (messageId: string) => !!(await prisma.demandeMail.findUnique({ where: { messageId }, select: { id: true } }))
      const mails = await source.lire(dejaTraite, (p) => (etat.progression = p))
      let i = 0
      for await (const m of mails) {
        // Une source qui fournit les mails un par un suit elle-même l'avancement (téléchargement)
        if (Array.isArray(mails)) etat.progression = { etape: 'traitement', faits: i++, total: mails.length }
        // Un mail qui échoue ne bloque pas les suivants : il sera retenté à la prochaine relève
        let r: ResultatTraitement
        try {
          r = await traiterMail(m.brut, m.ref)
        } catch (err) {
          logger.error({ err, ref: m.ref }, 'demandes mail : mail non enregistré')
          etat.derniereErreur = `Un mail n'a pas pu être enregistré : ${err instanceof Error ? err.message.split('\n').at(-1) : String(err)}`
          compte.erreur = (compte.erreur ?? 0) + 1
          continue
        }
        compte[r] = (compte[r] ?? 0) + 1
        await source.marquerTraite?.(m.ref)
      }
      if (Object.keys(compte).length) logger.info({ source: source.nom, ...compte }, 'demandes mail : relève terminée')
    } catch (err) {
      etat.derniereErreur = err instanceof Error ? err.message : String(err)
      logger.error({ err, source: source.nom }, 'demandes mail : relève impossible')
    } finally {
      etat.enCours = false
      etat.progression = null
      etat.derniereReleve = new Date().toISOString()
      etat.dernierResultat = compte
      releveEnCours = null
    }
    return etatReleve()
  })()
  return releveEnCours
}

/** Lance la relève périodique (appelé au démarrage du serveur). Renvoie une fonction d'arrêt. */
export function demarrerReleve(): () => void {
  const source = sourceConfiguree()
  if (!source) return () => {}
  logger.info(`demandes mail : relève toutes les ${env.DEMANDES_INTERVALLE_MIN} min (${source.nom})`)
  void relever(source)
  const t = setInterval(() => void relever(source), env.DEMANDES_INTERVALLE_MIN * 60_000)
  t.unref()
  return () => clearInterval(t)
}

/**
 * Range dans une boîte les mails reçus avant les demandes d'intervention (boite vide), d'après leur objet et leur texte.
 * Un mail écarté automatiquement qui ressemble à une intervention est remis « À traiter ». Sans effet une fois fait.
 */
export async function classerAnciens() {
  let total = 0
  let repris = 0
  for (;;) {
    const lot = await prisma.demandeMail.findMany({
      where: { boite: null },
      take: 200,
      select: { id: true, objet: true, corps: true, statut: true, traiteParId: true, anomalies: true, donnees: true },
    })
    if (lot.length === 0) break
    for (const m of lot) {
      // Un mail dont le devis est créé, ou écarté à la main, reste là où l'utilisateur l'a traité
      const dejaTraite = m.statut === StatutDemande.DEVIS_CREE || (m.statut === StatutDemande.IGNOREE && !!m.traiteParId)
      const boite = dejaTraite ? 'Devis' : boiteDe([m.objet, m.corps].join('\n'))
      const reprendre = boite !== 'Devis' && m.statut === StatutDemande.IGNOREE && (m.anomalies as string[]).includes(ANCIEN_MOTIF_IGNOREE)
      await prisma.demandeMail.update({
        where: { id: m.id },
        data: {
          boite: boiteDemande.key(boite),
          ...(reprendre && {
            statut: StatutDemande.A_TRAITER,
            anomalies: (m.donnees as Partial<DonneesDemande>).champs ? anomaliesDe(m.donnees as unknown as DonneesDemande, true) : [],
          }),
        },
      })
      if (reprendre) repris++
    }
    total += lot.length
  }
  if (total) logger.info({ total, repris }, 'demandes mail : anciens mails rangés en boîtes Devis / Intervention')
}

/**
 * Crée les dossiers automatiques (CV, Publicité, Fournisseurs…) et y range les mails reçus avant leur création
 * (les suivants y sont rangés dès leur arrivée). Seuls les mails sans dossier, à traiter ou ignorés, sont concernés.
 * Un mail déjà rangé une fois (donnees.dossierAuto, ou motif CV des premières versions) n'y est pas remis.
 */
export async function rangerDossiersAuto() {
  const dossiers = new Map<string, { id: string; createdAt: Date }>()
  for (const d of DOSSIERS_AUTO) {
    const id = await dossierAuto(d.nom)
    dossiers.set(d.nom, await prisma.dossierDemande.findUniqueOrThrow({ where: { id }, select: { id: true, createdAt: true } }))
  }
  const plusRecent = new Date(Math.max(...[...dossiers.values()].map((d) => d.createdAt.getTime())))
  const mails = await prisma.demandeMail.findMany({
    where: { dossierId: null, createdAt: { lt: plusRecent }, statut: { in: [StatutDemande.A_TRAITER, StatutDemande.IGNOREE] } },
    select: { id: true, objet: true, corps: true, expediteur: true, pieces: true, statut: true, traiteParId: true, anomalies: true, donnees: true, createdAt: true },
  })
  const comptes: Record<string, number> = {}
  for (const m of mails) {
    const donnees = (m.donnees ?? {}) as Partial<DonneesDemande>
    const anomalies = m.anomalies as string[]
    if (donnees.dossierAuto || anomalies.some((a) => a.startsWith('Candidature (CV)'))) continue
    const auto = dossierAutoDe({ texte: [m.objet, m.corps].join('\n'), expediteur: emailDe(m.expediteur), nomsPieces: (m.pieces as unknown as PieceStockee[]).map((p) => p.nom) })
    const dossier = auto && dossiers.get(auto.nom)
    // Reçu après la création du dossier : déjà examiné à l'arrivée
    if (!auto || !dossier || m.createdAt >= dossier.createdAt) continue
    // Une demande ignorée à la main garde son motif
    const ignoreeALaMain = m.statut === StatutDemande.IGNOREE && !!m.traiteParId
    await prisma.demandeMail.update({
      where: { id: m.id },
      data: {
        dossierId: dossier.id,
        donnees: { ...donnees, dossierAuto: auto.nom } as unknown as Prisma.InputJsonValue,
        ...(auto.ecarter && {
          boite: BoiteDemande.DEVIS,
          statut: StatutDemande.IGNOREE,
          anomalies: ignoreeALaMain ? [...anomalies, auto.motif] : [auto.motif],
        }),
      },
    })
    comptes[auto.nom] = (comptes[auto.nom] ?? 0) + 1
  }
  if (Object.keys(comptes).length) logger.info(comptes, 'demandes mail : anciens mails rangés dans les dossiers automatiques')
}

/**
 * Marque les demandes de devis parmi les mails déjà reçus (rubrique « Demandes de devis »), d'après les règles actuelles.
 * Ne change ni la boîte, ni le statut, ni le dossier ; un mail écarté automatiquement (CV, publicité…) n'est pas marqué.
 */
export async function marquerDemandesDevis() {
  let curseur: string | undefined
  let modifies = 0
  for (;;) {
    const lot = await prisma.demandeMail.findMany({
      take: 200,
      ...(curseur && { skip: 1, cursor: { id: curseur } }),
      orderBy: { id: 'asc' },
      select: { id: true, objet: true, corps: true, expediteur: true, statut: true, traiteParId: true, donnees: true },
    })
    if (lot.length === 0) break
    curseur = lot[lot.length - 1].id
    for (const m of lot) {
      const donnees = (m.donnees ?? {}) as Partial<DonneesDemande>
      const ecarte = m.statut === StatutDemande.IGNOREE && !m.traiteParId && !!donnees.dossierAuto
      const demandeDevis = !ecarte && estMailDeDemandeDevis(m.objet, m.corps, emailDe(m.expediteur))
      if (!!donnees.demandeDevis === demandeDevis) continue
      await prisma.demandeMail.update({ where: { id: m.id }, data: { donnees: { ...donnees, demandeDevis } as unknown as Prisma.InputJsonValue } })
      modifies++
    }
  }
  if (modifies) logger.info({ modifies }, 'demandes mail : demandes de devis marquées')
}

// ─── Réponse du client au devis (accord, refus) ─────────────────

/** Devis portant ce n° : le n° exact, sinon la dernière version (« DGD26-0878 » → « DGD26-0878/2 »). */
async function devisDuNumero(numero: string): Promise<string | null> {
  const base = numero.replace(/(-\d{3,6})[/-]\d{1,2}$/, '$1')
  const candidats = await prisma.devis.findMany({
    where: { OR: [{ numero }, { numero: base }, { numero: { startsWith: `${base}/` } }, { numero: { startsWith: `${base}-` } }] },
    select: { id: true, numero: true },
    orderBy: { numero: 'desc' },
  })
  return (candidats.find((d) => d.numero.toUpperCase() === numero) ?? candidats[0])?.id ?? null
}

/**
 * Devis dont parle le mail : n° de devis GD qu'il cite ; sinon le devis auquel il a été lié ; sinon n° cité ou devis lié dans un autre mail du même fil
 * (le mail d'envoi du devis, la demande d'origine) ; sinon devis créé depuis une demande de même référence client.
 * Rien si plusieurs devis sont possibles.
 */
async function devisDuMail(m: { id: string; devisId: string | null; filId: string | null; donnees: Prisma.JsonValue }, numeros: string[]): Promise<string | null> {
  const uniques = (ids: (string | null)[]) => [...new Set(ids.filter((x): x is string => !!x))]
  const parNumeros = async (ns: string[]) => uniques(await Promise.all(ns.map(devisDuNumero)))

  const cites = await parNumeros(numeros)
  if (cites.length) return cites.length === 1 ? cites[0] : null
  // Mail lié à la main à son devis (« Lier à un devis »)
  if (m.devisId) return m.devisId

  if (m.filId) {
    const fil = await prisma.demandeMail.findMany({ where: { filId: m.filId, id: { not: m.id } }, select: { devisId: true, objet: true, corps: true } })
    const lies = uniques(fil.map((f) => f.devisId))
    if (lies.length) return lies.length === 1 ? lies[0] : null
    const duFil = await parNumeros(numerosDevisCites(fil.map((f) => [f.objet, f.corps].join('\n')).join('\n')))
    if (duFil.length) return duFil.length === 1 ? duFil[0] : null
  }

  const reference = (m.donnees as Partial<DonneesDemande> | null)?.champs?.reference
  if (reference) {
    const memeRef = await prisma.demandeMail.findMany({
      where: { id: { not: m.id }, devisId: { not: null }, donnees: { path: '$.champs.reference', equals: reference } },
      select: { devisId: true },
    })
    const ids = uniques(memeRef.map((d) => d.devisId))
    if (ids.length === 1) return ids[0]
  }
  return null
}

/**
 * Lit dans le mail l'accord ou le refus du client, et le reporte sur le devis concerné.
 * Une réponse saisie à la main n'est jamais remplacée ; une réponse lue dans un mail plus ancien l'est.
 * Renvoie le n° du devis mis à jour (null : rien de fait).
 */
export async function appliquerResultatDevis(id: string): Promise<string | null> {
  const m = await prisma.demandeMail.findUnique({ where: { id }, select: { id: true, objet: true, corps: true, expediteur: true, recuLe: true, devisId: true, filId: true, donnees: true } })
  if (!m) return null
  const lu = resultatDevisDans(m.objet, m.corps, emailDe(m.expediteur))
  if (!lu) return null
  const devisId = await devisDuMail(m, lu.numeros)
  if (!devisId) return null
  const devis = await prisma.devis.findUniqueOrThrow({
    where: { id: devisId },
    select: { numero: true, resultat: true, resultatMailId: true, resultatMail: { select: { recuLe: true } } },
  })
  if (devis.resultatMailId === m.id) return null
  const saisieALaMain = devis.resultat !== ResultatDevis.EN_ATTENTE && !devis.resultatMailId
  if (saisieALaMain || (devis.resultatMail && devis.resultatMail.recuLe > m.recuLe)) return null
  await prisma.devis.update({
    where: { id: devisId },
    data: {
      resultat: lu.resultat === 'Accepté' ? ResultatDevis.ACCEPTE : ResultatDevis.REFUSE,
      resultatLe: new Date(`${m.recuLe.toISOString().slice(0, 10)}T00:00:00Z`),
      motifRefus: lu.motif,
      resultatMailId: m.id,
    },
  })
  return devis.numero
}

/** Relit les réponses aux devis dans les mails déjà reçus (au démarrage), du plus ancien au plus récent. */
export async function lireResultatsDevis() {
  const mails = await prisma.demandeMail.findMany({ select: { id: true, objet: true, corps: true, expediteur: true }, orderBy: { recuLe: 'asc' } })
  const maj: string[] = []
  for (const m of mails) {
    if (!resultatDevisDans(m.objet, m.corps, emailDe(m.expediteur))) continue
    const numero = await appliquerResultatDevis(m.id)
    if (numero) maj.push(numero)
  }
  if (maj.length) logger.info({ devis: maj }, 'demandes mail : réponses des clients reportées sur les devis')
}
