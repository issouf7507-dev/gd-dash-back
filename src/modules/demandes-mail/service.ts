// Demandes de devis des clients relevées dans la boîte contact@ (Outlook) : décodage, extraction,
// enregistrement dans la file demandes_mail (« À traiter »), puis création du devis depuis l'écran.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../../config/env.ts'
import { Prisma, SourceDevis, StatutDemande } from '../../generated/prisma/client.ts'
import { logger } from '../../lib/logger.ts'
import { isUniqueViolation } from '../../lib/prisma-errors.ts'
import { prisma } from '../../lib/prisma.ts'
import { toDevisCreate, type DevisInput } from '../devis/schema.ts'
import { decoderMail } from '../import-mail/lecture.ts'
import type { Rapprochement } from '../import-mail/match-client.ts'
import { sourceDossier } from '../import-mail/sources/dossier.ts'
import { sourceGraph } from '../import-mail/sources/graph.ts'
import type { Progression, SourceMails } from '../import-mail/sources/types.ts'
import { extraireDemande, rapprocherClientDemande, type ChampsDemande } from './extract.ts'
import { rattacherAuFil } from './fils.ts'

/** Contenu de la colonne `donnees` d'une demande. */
export interface DonneesDemande {
  champs: ChampsDemande
  client: Rapprochement
  /** Autre demande déjà reçue avec la même référence (ex. mail envoyé sur deux adresses) */
  doublonDeId?: string
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

/** Crée le devis à partir d'une demande et la marque « Devis créé », en une seule transaction. */
export async function creerDevisDepuisDemande(demandeId: string, input: DevisInput, userId: string) {
  return prisma.$transaction(async (tx) => {
    const devis = await tx.devis.create({ data: { ...toDevisCreate(input), source: SourceDevis.MAIL } })
    await tx.demandeMail.update({
      where: { id: demandeId },
      data: { statut: StatutDemande.DEVIS_CREE, devisId: devis.id, traiteParId: userId, traiteLe: new Date() },
    })
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

  const { estUneDemande, champs } = extraireDemande(mail)
  const clients = await prisma.client.findMany({ where: { actif: true }, select: { id: true, nom: true, email: true } })
  const donnees: DonneesDemande = {
    champs,
    client: rapprocherClientDemande(clients, champs, [mail.objet, mail.corps, mail.textePdf].join('\n')),
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
  let statut: StatutDemande = StatutDemande.A_TRAITER
  let anomalies: string[]
  if (!estUneDemande && !illisible) {
    statut = StatutDemande.IGNOREE
    anomalies = ['Ce mail ne ressemble pas à une demande de devis']
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
