// Traitement des mails relevés : décodage, extraction, contrôles, puis enregistrement
// dans la file imports_mail (« À vérifier ») ou création directe du devis (mode automatique).
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../../config/env.ts'
import { Prisma, SourceDevis, StatutImport } from '../../generated/prisma/client.ts'
import { categorie as categorieMap } from '../../lib/labels.ts'
import { logger } from '../../lib/logger.ts'
import { isUniqueViolation } from '../../lib/prisma-errors.ts'
import { prisma } from '../../lib/prisma.ts'
import { toDevisCreate, type DevisInput } from '../devis/schema.ts'
import { extraire, type ChampsExtraits } from './extract.ts'
import { decoderMail } from './lecture.ts'
import { normaliserNom, rapprocherClient, type Rapprochement } from './match-client.ts'
import { sourceDossier } from './sources/dossier.ts'
import { sourceImap } from './sources/imap.ts'
import type { SourceMails } from './sources/types.ts'

/** Contenu de la colonne `donnees` d'un import. */
export interface DonneesImport {
  champs: ChampsExtraits
  client: Rapprochement
  /** Conducteur reconnu à partir du nom indiqué dans la fiche du mail */
  conducteurId?: string | null
  /** Devis déjà existant avec ce numéro (doublon) */
  devisExistantId?: string
}

export const dossierStockage = () => path.resolve(env.IMPORT_MAIL_STOCKAGE)

export function sourceConfiguree(): SourceMails | null {
  if (env.IMPORT_MAIL_SOURCE === 'dossier') return sourceDossier(path.resolve(env.IMPORT_MAIL_DOSSIER))
  if (env.IMPORT_MAIL_SOURCE === 'imap') {
    return sourceImap({
      host: env.IMAP_HOST,
      port: env.IMAP_PORT,
      user: env.IMAP_USER,
      password: env.IMAP_PASSWORD,
      libelle: env.IMAP_LIBELLE,
      jours: env.IMAP_JOURS,
    })
  }
  return null
}

const expediteurAutorise = (email: string) => {
  const liste = env.IMPORT_MAIL_EXPEDITEURS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return liste.length === 0 || liste.some((e) => email === e || email.endsWith(`@${e}`) || email.endsWith(`.${e}`))
}

/** Liste des points à vérifier. Vide = import sûr. */
export function anomaliesDe(d: DonneesImport, aUnPdf: boolean): string[] {
  const a: string[] = []
  const c = d.champs
  if (!c.numero) a.push('N° de devis introuvable')
  if (d.client.confiance === 'aucun') a.push(c.clientNom ? `Client inconnu : ${c.clientNom}` : 'Client introuvable')
  if (d.client.confiance === 'proche') a.push('Client à confirmer')
  if (!c.adresse) a.push('Adresse des travaux introuvable')
  if (!c.categorie) a.push('Catégorie non détectée')
  else if (c.categorieIncertaine) a.push('Catégorie incertaine')
  if (c.montantHT === null) a.push('Montant HT introuvable')
  if (!aUnPdf) a.push('Pas de PDF joint')
  return a
}

/** Conducteur ou chargé d'affaires actif dont « Prénom Nom » (ou le prénom seul, s'il est unique) correspond. */
async function trouverConducteur(nom: string): Promise<string | null> {
  const users = await prisma.utilisateur.findMany({
    where: { actif: true, role: { in: ['CONDUCTEUR', 'CHARGE_AFFAIRES'] } },
    select: { id: true, prenom: true, nom: true },
  })
  const cible = normaliserNom(nom)
  const complet = users.filter((u) => [normaliserNom(`${u.prenom} ${u.nom}`), normaliserNom(`${u.nom} ${u.prenom}`)].includes(cible))
  if (complet.length === 1) return complet[0].id
  const parPrenom = users.filter((u) => normaliserNom(u.prenom) === cible || normaliserNom(u.nom) === cible)
  return parPrenom.length === 1 ? parPrenom[0].id : null
}

/** Champs du devis pré-remplis à partir de l'import (ce que l'écran de vérification propose). */
export function devisPropose(d: DonneesImport): Partial<DevisInput> {
  const c = d.champs
  return {
    numero: c.numero ?? '',
    dateReception: c.dateReception,
    categorie: c.categorie ?? 'Couverture',
    ...(d.client.clientId && { clientId: d.client.clientId }),
    ...(d.conducteurId && { conducteurId: d.conducteurId }),
    adresse: c.adresse ?? '',
    descriptif: c.descriptif ?? '',
    montantHT: c.montantHT,
    statutADCI: 'Non traité',
    planification: 'À planifier',
  }
}

/** Crée le devis à partir d'un import et marque l'import « Importé », en une seule transaction. */
export async function creerDevisDepuisImport(importId: string, input: DevisInput, userId: string | null) {
  return prisma.$transaction(async (tx) => {
    const devis = await tx.devis.create({ data: { ...(toDevisCreate(input)), source: SourceDevis.MAIL } })
    await tx.importMail.update({
      where: { id: importId },
      data: { statut: StatutImport.IMPORTE, devisId: devis.id, traiteParId: userId, traiteLe: new Date() },
    })
    return devis
  })
}

async function stockerPdf(contenu: Buffer) {
  await mkdir(dossierStockage(), { recursive: true })
  const fichier = `${randomUUID()}.pdf`
  await writeFile(path.join(dossierStockage(), fichier), contenu)
  return fichier
}

export type ResultatTraitement = 'à vérifier' | 'importé' | 'ignoré' | 'erreur' | 'déjà traité'

/** Traite un mail brut. Ne lève pas d'erreur : un mail illisible est enregistré en « Erreur ». */
export async function traiterMail(brut: Buffer, ref: string): Promise<ResultatTraitement> {
  const empreinte = `sans-id:${createHash('sha256').update(brut).digest('hex').slice(0, 32)}`
  let mail
  try {
    mail = await decoderMail(brut, empreinte)
  } catch (err) {
    logger.warn({ err, ref }, 'import mail : mail illisible')
    await prisma.importMail
      .create({
        data: {
          messageId: empreinte,
          recuLe: new Date(),
          expediteur: '',
          objet: `(mail illisible : ${ref})`,
          corps: '',
          statut: StatutImport.ERREUR,
          donnees: {},
          anomalies: [],
          erreur: err instanceof Error ? err.message : String(err),
        },
      })
      .catch((e) => {
        if (!isUniqueViolation(e)) throw e
      })
    return 'erreur'
  }

  if (await prisma.importMail.findUnique({ where: { messageId: mail.messageId }, select: { id: true } })) return 'déjà traité'

  // La boîte relevée (ex. le Gmail de test en copie) n'est pas le client
  const boite = env.IMAP_USER.toLowerCase()
  const { estUnDevis, champs } = extraire({ ...mail, destinataires: mail.destinataires.filter((d) => d.email !== boite) })
  const clients = await prisma.client.findMany({ where: { actif: true }, select: { id: true, nom: true, email: true } })
  const donnees: DonneesImport = {
    champs,
    client: rapprocherClient(clients, champs.clientNom, champs.clientEmail),
    conducteurId: champs.conducteurNom ? await trouverConducteur(champs.conducteurNom) : null,
  }

  let statut: StatutImport = StatutImport.A_VERIFIER
  let anomalies: string[]
  if (!expediteurAutorise(mail.expediteur.email)) {
    statut = StatutImport.IGNORE
    anomalies = [`Expéditeur non retenu : ${mail.expediteur.email}`]
  } else if (!estUnDevis) {
    statut = StatutImport.IGNORE
    anomalies = ['Ce mail ne ressemble pas à un devis']
  } else {
    const existant = champs.numero ? await prisma.devis.findUnique({ where: { numero: champs.numero }, select: { id: true } }) : null
    if (existant) {
      statut = StatutImport.IGNORE
      donnees.devisExistantId = existant.id
      anomalies = [`Devis ${champs.numero} déjà enregistré`]
    } else {
      anomalies = anomaliesDe(donnees, mail.pdfs.length > 0)
    }
  }

  const pdf = statut === StatutImport.IGNORE ? undefined : mail.pdfs[0]
  const imp = await prisma.importMail.create({
    data: {
      messageId: mail.messageId,
      recuLe: mail.date,
      expediteur: (mail.expediteur.nom ? `${mail.expediteur.nom} <${mail.expediteur.email}>` : mail.expediteur.email).slice(0, 255),
      objet: mail.objet.slice(0, 500),
      corps: mail.corps.slice(0, 20_000),
      statut,
      donnees: donnees as unknown as Prisma.InputJsonValue,
      anomalies,
      pdfNom: pdf?.nom ?? null,
      pdfFichier: pdf ? await stockerPdf(pdf.contenu) : null,
    },
  })

  // Mode automatique : un import sans aucune anomalie devient directement un devis
  if (statut === StatutImport.A_VERIFIER && anomalies.length === 0 && env.IMPORT_MAIL_AUTO) {
    const input = { ...devisPropose(donnees), clientId: donnees.client.clientId!, categorie: champs.categorie! } as DevisInput
    try {
      await creerDevisDepuisImport(imp.id, { ...defautsDevis, ...input }, null)
      return 'importé'
    } catch (err) {
      // Ex. numéro créé entre-temps à la main : l'import reste « À vérifier »
      logger.warn({ err, importId: imp.id }, 'import mail : création automatique impossible')
    }
  }
  return statut === StatutImport.IGNORE ? 'ignoré' : 'à vérifier'
}

/** Valeurs par défaut d'un devis complet (mêmes défauts que le schéma de l'API). */
export const defautsDevis: DevisInput = {
  numero: '',
  dateReception: null,
  planification: 'À planifier',
  categorie: categorieMap.label('COUVERTURE'),
  clientId: '',
  adresse: '',
  descriptif: '',
  conducteurId: null,
  datePassage: null,
  statutConducteur: null,
  statutADCI: 'Non traité',
  validePar: null,
  relance: null,
  commentaires: '',
  montantHT: null,
}

// ─── Relève ──────────────────────────────────────────────────

export interface EtatReleve {
  source: string | null
  enCours: boolean
  derniereReleve: string | null
  dernierResultat: Partial<Record<ResultatTraitement, number>> | null
  derniereErreur: string | null
}

const etat: EtatReleve = { source: null, enCours: false, derniereReleve: null, dernierResultat: null, derniereErreur: null }
export const etatReleve = () => ({ ...etat, source: sourceConfiguree()?.nom ?? null })

/** Relève la source configurée. Une seule relève à la fois (les appels concurrents attendent la même). */
let releveEnCours: Promise<EtatReleve> | null = null
export function relever(source = sourceConfiguree()): Promise<EtatReleve> {
  if (!source) return Promise.resolve(etatReleve())
  releveEnCours ??= (async () => {
    etat.enCours = true
    const compte: Partial<Record<ResultatTraitement, number>> = {}
    try {
      const dejaTraite = async (messageId: string) => !!(await prisma.importMail.findUnique({ where: { messageId }, select: { id: true } }))
      for (const m of await source.lire(dejaTraite)) {
        const r = await traiterMail(m.brut, m.ref)
        compte[r] = (compte[r] ?? 0) + 1
        await source.marquerTraite?.(m.ref)
      }
      etat.derniereErreur = null
      if (Object.keys(compte).length) logger.info({ source: source.nom, ...compte }, 'import mail : relève terminée')
    } catch (err) {
      etat.derniereErreur = err instanceof Error ? err.message : String(err)
      logger.error({ err, source: source.nom }, 'import mail : relève impossible')
    } finally {
      etat.enCours = false
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
  logger.info(`import mail : relève toutes les ${env.IMPORT_MAIL_INTERVALLE_MIN} min (${source.nom})`)
  void relever(source)
  const t = setInterval(() => void relever(source), env.IMPORT_MAIL_INTERVALLE_MIN * 60_000)
  t.unref()
  return () => clearInterval(t)
}
