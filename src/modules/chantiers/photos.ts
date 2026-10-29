// Stockage des photos du journal de chantier : fichiers sur disque (PHOTOS_STOCKAGE), nom aléatoire.
import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../../config/env.ts'
import { logger } from '../../lib/logger.ts'

export const TAILLE_MAX_PHOTO = 10 * 1024 * 1024
export const PHOTOS_MAX_PAR_OBSERVATION = 12

export const dossierPhotos = () => path.resolve(env.PHOTOS_STOCKAGE)

/** Type réel de l'image d'après ses premiers octets (on ne se fie pas à l'en-tête envoyé). */
export function typeImage(b: Buffer): { type: string; ext: string } | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' }
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: 'png' }
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { type: 'image/webp', ext: 'webp' }
  return null
}

export async function ecrirePhoto(contenu: Buffer, ext: string) {
  await mkdir(dossierPhotos(), { recursive: true })
  const fichier = `${randomUUID()}.${ext}`
  await writeFile(path.join(dossierPhotos(), fichier), contenu)
  return fichier
}

/** Supprime des fichiers de photos ; un fichier déjà absent n'est pas une erreur. */
export async function effacerPhotos(fichiers: string[]) {
  await Promise.all(
    fichiers.map((f) =>
      unlink(path.join(dossierPhotos(), path.basename(f))).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') logger.warn({ err, fichier: f }, 'photo : suppression du fichier impossible')
      }),
    ),
  )
}
