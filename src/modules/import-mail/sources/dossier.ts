import { mkdir, readdir, readFile, rename } from 'node:fs/promises'
import path from 'node:path'
import type { SourceMails } from './types.ts'

/**
 * Source de développement : lit les fichiers .eml déposés dans un dossier,
 * puis les range dans le sous-dossier `traites/` (jamais supprimés).
 */
export function sourceDossier(dossier: string): SourceMails {
  const traites = path.join(dossier, 'traites')
  return {
    nom: `dossier ${dossier}`,
    async lire() {
      await mkdir(dossier, { recursive: true })
      const fichiers = (await readdir(dossier)).filter((f) => f.toLowerCase().endsWith('.eml')).sort()
      return Promise.all(fichiers.map(async (f) => ({ ref: f, brut: await readFile(path.join(dossier, f)) })))
    },
    async marquerTraite(ref) {
      await mkdir(traites, { recursive: true })
      await rename(path.join(dossier, ref), path.join(traites, ref))
    },
  }
}
