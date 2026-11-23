// Pièces jointes des mails envoyés depuis l'application.
// Chaque fichier est déposé dès qu'il est ajouté dans la fenêtre de rédaction (dossier « attente »),
// puis rangé avec le mail une fois celui-ci parti. Les dépôts abandonnés sont effacés au bout d'un jour.
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import express, { type NextFunction, type Request, type Response } from 'express'
import { env } from '../../config/env.ts'
import { AppError, ValidationError } from '../../lib/app-error.ts'
import type { PieceJointe } from '../../lib/envoi-mail.ts'
import { logger } from '../../lib/logger.ts'

/** Taille maximale d'un fichier, et de l'ensemble des pièces d'un mail (limite d'Exchange : 35 Mo encodés) */
export const TAILLE_MAX_PIECE = 20 * 1024 * 1024
export const TAILLE_MAX_TOTALE = 25 * 1024 * 1024
export const PIECES_MAX = 20
const DELAI_ABANDON_MS = 24 * 3600 * 1000

export const dossierPiecesEnvoi = () => path.resolve(env.ENVOI_MAIL_PIECES)
const dossierAttente = () => path.join(dossierPiecesEnvoi(), 'attente')

/** Pièce rangée avec le mail envoyé (colonne `pieces` de MailEnvoye) */
export interface PieceEnvoyee {
  nom: string
  type: string
  fichier: string
  taille: number
}

/** Pièce annoncée par le front au moment de l'envoi */
export interface PieceAnnoncee {
  id: string
  nom: string
  type: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Corps brut (tout type de fichier), avec une erreur lisible si le fichier est trop gros */
const corpsBrut = express.raw({ type: () => true, limit: TAILLE_MAX_PIECE })
export function corpsPiece(req: Request, res: Response, next: NextFunction) {
  corpsBrut(req, res, (err?: unknown) => {
    if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.too.large') {
      return next(new AppError('Fichier trop volumineux (20 Mo maximum)', 413, 'VALIDATION_ERROR'))
    }
    next(err)
  })
}

/** Efface les dépôts abandonnés (fenêtre fermée sans envoyer). */
async function purger() {
  const dossier = dossierAttente()
  const limite = Date.now() - DELAI_ABANDON_MS
  for (const f of await readdir(dossier).catch(() => [] as string[])) {
    const chemin = path.join(dossier, f)
    const s = await stat(chemin).catch(() => null)
    if (s && s.mtimeMs < limite) await unlink(chemin).catch(() => {})
  }
}

/** Dépose un fichier en attente d'envoi ; renvoie l'identifiant à rappeler au moment de l'envoi. */
export async function deposer(contenu: Buffer) {
  if (!Buffer.isBuffer(contenu) || contenu.length === 0) throw new ValidationError(null, 'Fichier vide')
  await mkdir(dossierAttente(), { recursive: true })
  const id = randomUUID()
  await writeFile(path.join(dossierAttente(), id), contenu)
  purger().catch((err) => logger.warn({ err }, 'Purge des pièces jointes abandonnées impossible'))
  return { id, taille: contenu.length }
}

/** Pièces prêtes à joindre au mail (fichiers en attente), après contrôle de leur présence et de la taille totale. */
export async function preparer(annoncees: PieceAnnoncee[]): Promise<PieceJointe[]> {
  const pieces: PieceJointe[] = []
  for (const p of annoncees) {
    if (!UUID.test(p.id)) throw new ValidationError(null, 'Pièce jointe inconnue')
    const chemin = path.join(dossierAttente(), p.id)
    const s = await stat(chemin).catch(() => null)
    if (!s) throw new ValidationError(null, `La pièce « ${p.nom} » n’est plus disponible : ajoutez-la de nouveau`)
    pieces.push({ nom: p.nom, type: p.type || 'application/octet-stream', chemin, taille: s.size })
  }
  if (pieces.reduce((t, p) => t + p.taille, 0) > TAILLE_MAX_TOTALE) throw new ValidationError(null, 'Pièces jointes trop volumineuses (25 Mo maximum au total)')
  return pieces
}

/** Le mail est parti : les pièces quittent l'attente et sont rangées avec lui. */
export async function conserver(pieces: PieceJointe[]): Promise<PieceEnvoyee[]> {
  return Promise.all(
    pieces.map(async (p) => {
      const fichier = path.basename(p.chemin)
      await rename(p.chemin, path.join(dossierPiecesEnvoi(), fichier))
      return { nom: p.nom, type: p.type, fichier, taille: p.taille }
    }),
  )
}
