// Lecture d'un classeur Excel (.xlsx) sans dépendance : un .xlsx est une archive zip de fichiers XML.
// On ne lit que les valeurs de la première feuille (texte, nombres, booléens), pas les formats ni les formules.
import { inflateRawSync } from 'node:zlib'
import { ValidationError } from './app-error.ts'

const invalide = (detail: string) => new ValidationError(undefined, `Fichier Excel illisible : ${detail}. Enregistrez-le au format .xlsx puis réessayez.`)

/** Fichiers de l'archive zip (nom → contenu décompressé). */
function lireZip(buf: Buffer): Map<string, Buffer> {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) {
    // Ancien format .xls (binaire OLE) : pas un zip
    throw invalide(buf.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) ? 'ancien format .xls' : 'ce n’est pas un fichier .xlsx')
  }
  // Fin du répertoire central : cherchée depuis la fin (un commentaire peut la suivre)
  let fin = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      fin = i
      break
    }
  }
  if (fin < 0) throw invalide('archive incomplète')
  const nombre = buf.readUInt16LE(fin + 10)
  let p = buf.readUInt32LE(fin + 16)
  const fichiers = new Map<string, Buffer>()
  for (let n = 0; n < nombre; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw invalide('répertoire de l’archive abîmé')
    const methode = buf.readUInt16LE(p + 10)
    const taille = buf.readUInt32LE(p + 20)
    const lgNom = buf.readUInt16LE(p + 28)
    const lgExtra = buf.readUInt16LE(p + 30)
    const lgComm = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const nom = buf.toString('utf8', p + 46, p + 46 + lgNom)
    p += 46 + lgNom + lgExtra + lgComm
    // En-tête local : sa propre longueur de nom et d'extra précède les données
    const debut = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const donnees = buf.subarray(debut, debut + taille)
    if (methode === 0) fichiers.set(nom, donnees)
    else if (methode === 8) fichiers.set(nom, inflateRawSync(donnees))
  }
  return fichiers
}

const decoder = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    // Caractères échappés par Excel (_x000D_ pour un retour chariot)
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))

/** Texte d'un nœud <si> ou <is> : les morceaux <t>, sans les annotations phonétiques <rPh>. */
const texte = (xml: string) =>
  decoder(
    [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''),
  )

/** Index de colonne (0 pour A) d'une référence de cellule comme « AB12 ». */
function colonne(ref: string) {
  let n = 0
  for (const c of ref.replace(/\d+$/, '')) n = n * 26 + (c.charCodeAt(0) - 64)
  return n - 1
}

export interface LigneTableur {
  /** Numéro de la ligne dans Excel (1 pour la première) */
  numero: number
  cellules: string[]
}

/** Lignes de la première feuille du classeur, valeurs converties en texte. */
export function lireXlsx(buf: Buffer): LigneTableur[] {
  const zip = lireZip(buf)
  const lire = (nom: string) => zip.get(nom)?.toString('utf8')

  const classeur = lire('xl/workbook.xml')
  if (!classeur) throw invalide('classeur introuvable dans l’archive')
  // Première feuille dans l'ordre du classeur, et son fichier d'après les relations
  const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(classeur)?.[1]
  const cible = rid && new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(lire('xl/_rels/workbook.xml.rels') ?? '')?.[1]
  const chemin = cible ? (cible.startsWith('/') ? cible.slice(1) : `xl/${cible}`) : 'xl/worksheets/sheet1.xml'
  const feuille = lire(chemin)
  if (!feuille) throw invalide('feuille introuvable')

  const partages = [...(lire('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texte(m[1]))

  const lignes: LigneTableur[] = []
  for (const r of feuille.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const numero = Number(/\br="(\d+)"/.exec(r[1])?.[1] ?? lignes.length + 1)
    const cellules: string[] = []
    for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1]
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
      const corps = c[2] ?? ''
      const v = /<v>([\s\S]*?)<\/v>/.exec(corps)?.[1]
      let valeur = ''
      if (type === 's') valeur = partages[Number(v)] ?? ''
      else if (type === 'inlineStr') valeur = texte(corps)
      else if (type === 'b') valeur = v === '1' ? 'VRAI' : v === '0' ? 'FAUX' : ''
      else if (v !== undefined) valeur = decoder(v)
      cellules[ref ? colonne(ref) : cellules.length] = valeur
    }
    lignes.push({ numero, cellules: Array.from(cellules, (x) => x ?? '') })
  }
  return lignes
}
