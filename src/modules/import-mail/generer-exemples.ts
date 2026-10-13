// Dépose les faux mails dans le dossier relevé par la source « dossier ».
// Usage : pnpm --filter @gd/server import:exemples [dossier]   (défaut : IMPORT_MAIL_DOSSIER ou data/mails-entrants)
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { exemplesMails } from './exemples.ts'

const dossier = path.resolve(process.argv[2] ?? process.env.IMPORT_MAIL_DOSSIER ?? 'data/mails-entrants')
await mkdir(dossier, { recursive: true })
for (const [nom, contenu] of Object.entries(exemplesMails())) {
  await writeFile(path.join(dossier, nom), contenu)
  console.log(`✔ ${path.join(dossier, nom)}`)
}
