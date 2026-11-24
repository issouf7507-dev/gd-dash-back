// Import d'une bibliothèque Excel (clients, fournisseurs) : colonnes reconnues d'après l'en-tête,
// valeurs nettoyées, puis rapprochement avec l'existant (par code, sinon par nom) pour créer ou compléter.
import { ValidationError } from './app-error.ts'
import { lireXlsx } from './xlsx.ts'

export interface FicheImport {
  code: string | null
  nom: string
  famille: string | null
  email: string | null
  telephone: string | null
  adresse: string | null
  codePostal: string | null
  ville: string | null
}
type Champ = keyof FicheImport

export interface LigneImport extends FicheImport {
  /** Numéro de la ligne dans Excel */
  ligne: number
}

export interface ErreurImport {
  ligne: number
  message: string
}

/** Fiche déjà en base */
export type Existant = FicheImport & { id: string }

/** Comparaison de libellés : sans accents, casse, espaces ni ponctuation */
const cle = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9@]+/g, '')

/** Codes comparés comme MySQL (casse et espaces de fin ignorés), mais « 001 PIG » ≠ « 001PIG » */
const cleCode = (s: string) => s.trim().toLowerCase()

/** Noms d'en-têtes acceptés pour chaque champ (comparés sans accents ni ponctuation) */
const ENTETES: Record<Champ, string[]> = {
  code: ['code', 'codeclient', 'codefournisseur', 'reference', 'ref'],
  nom: ['raisonsociale', 'nom', 'societe', 'client', 'fournisseur', 'denomination'],
  famille: ['famille', 'categorie', 'type'],
  email: ['email', 'mail', 'courriel', 'adressemail', 'adresseemail'],
  telephone: ['telephone', 'tel', 'portable', 'mobile'],
  adresse: ['adresse', 'adresse1', 'rue'],
  codePostal: ['cp', 'codepostal'],
  ville: ['commune', 'ville', 'localite'],
}

const LONGUEURS: Record<Champ, number> = { code: 30, nom: 191, famille: 60, email: 191, telephone: 30, adresse: 191, codePostal: 10, ville: 100 }

/** Texte sur une ligne : retours à la ligne en virgules, espaces resserrés, virgules en trop retirées */
function propre(v: string | undefined, champ: Champ): string | null {
  const s = (v ?? '')
    .replace(/\s*[\r\n]+\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;]+|[\s,;]+$/g, '')
  return s ? s.slice(0, LONGUEURS[champ]) : null
}

/** Première adresse email valable de la cellule (il y en a parfois plusieurs) */
const email = (v: string | undefined) => /[^\s@,;<>()]+@[^\s@,;<>()]+\.[a-z]{2,}/i.exec(v ?? '')?.[0].toLowerCase().slice(0, 191) ?? null

/** Code postal : les nombres à 4 chiffres ont perdu leur zéro initial dans Excel (01000 → 1000) */
function codePostal(v: string | undefined) {
  const s = propre(v, 'codePostal')
  return s && /^\d{4}$/.test(s) ? `0${s}` : s
}

/** Lignes du classeur : l'en-tête est cherché dans les 10 premières lignes. */
export function lireBibliotheque(fichier: Buffer): { lignes: LigneImport[]; erreurs: ErreurImport[]; colonnes: Champ[] } {
  const brut = lireXlsx(fichier)
  let indexEntete = -1
  let colonnes: Partial<Record<Champ, number>> = {}
  for (const [i, l] of brut.slice(0, 10).entries()) {
    const trouve: Partial<Record<Champ, number>> = {}
    l.cellules.forEach((c, j) => {
      const k = cle(c)
      const champ = (Object.keys(ENTETES) as Champ[]).find((ch) => ENTETES[ch].includes(k))
      if (champ && trouve[champ] === undefined) trouve[champ] = j
    })
    if (trouve.nom !== undefined) {
      indexEntete = i
      colonnes = trouve
      break
    }
  }
  if (indexEntete < 0) throw new ValidationError(undefined, 'Colonne « Raison sociale » (ou « Nom ») introuvable dans la première feuille du fichier')

  const lignes: LigneImport[] = []
  const erreurs: ErreurImport[] = []
  for (const l of brut.slice(indexEntete + 1)) {
    const cellule = (champ: Champ) => (colonnes[champ] === undefined ? undefined : l.cellules[colonnes[champ]!])
    if (l.cellules.every((c) => !c.trim())) continue
    const nom = propre(cellule('nom'), 'nom')
    if (!nom) {
      erreurs.push({ ligne: l.numero, message: 'Raison sociale vide : ligne ignorée' })
      continue
    }
    lignes.push({
      ligne: l.numero,
      code: propre(cellule('code'), 'code'),
      nom,
      famille: propre(cellule('famille'), 'famille'),
      email: email(cellule('email')),
      telephone: propre(cellule('telephone'), 'telephone'),
      adresse: propre(cellule('adresse'), 'adresse'),
      codePostal: codePostal(cellule('codePostal')),
      ville: propre(cellule('ville'), 'ville'),
    })
  }
  return { lignes, erreurs, colonnes: Object.keys(colonnes) as Champ[] }
}

export interface PlanImport {
  creations: LigneImport[]
  misesAJour: { id: string; ligne: number; nom: string; data: Partial<FicheImport> }[]
  inchanges: number
  /** Noms modifiés pour rester uniques (clients) */
  renommes: { ligne: number; avant: string; apres: string }[]
  erreurs: ErreurImport[]
}

const CHAMPS_COMPLETES: Champ[] = ['famille', 'email', 'telephone', 'adresse', 'codePostal', 'ville']

/**
 * Ce que l'import va faire, sans rien écrire.
 * - Une fiche existante est retrouvée par son code, sinon par son nom (si elle n'a pas encore de code).
 * - Elle est complétée avec les valeurs du fichier ; une cellule vide n'efface rien, le nom n'est pas changé.
 * - Si le nom doit être unique (clients), un doublon reçoit la commune ou le code en suffixe.
 */
export function planifierImport(lignes: LigneImport[], existants: Existant[], { nomUnique }: { nomUnique: boolean }): PlanImport {
  const plan: PlanImport = { creations: [], misesAJour: [], inchanges: 0, renommes: [], erreurs: [] }
  const parCode = new Map(existants.filter((e) => e.code).map((e) => [cleCode(e.code!), e]))
  const parNom = new Map<string, Existant>()
  for (const e of existants) if (!e.code && !parNom.has(cle(e.nom))) parNom.set(cle(e.nom), e)
  const nomsPris = new Set(existants.map((e) => cle(e.nom)))
  const codesVus = new Map<string, number>()
  const retrouves = new Set<string>()

  for (const l of lignes) {
    if (l.code) {
      const vu = codesVus.get(cleCode(l.code))
      if (vu) {
        plan.erreurs.push({ ligne: l.ligne, message: `Code ${l.code} déjà utilisé ligne ${vu} : ligne ignorée` })
        continue
      }
      codesVus.set(cleCode(l.code), l.ligne)
    }

    const existant = (l.code && parCode.get(cleCode(l.code))) || parNom.get(cle(l.nom))
    if (existant && !retrouves.has(existant.id)) {
      retrouves.add(existant.id)
      parNom.delete(cle(existant.nom))
      const data: Partial<FicheImport> = {}
      if (l.code && !existant.code) data.code = l.code
      for (const ch of CHAMPS_COMPLETES) if (l[ch] && l[ch] !== existant[ch]) data[ch] = l[ch]
      if (Object.keys(data).length) plan.misesAJour.push({ id: existant.id, ligne: l.ligne, nom: existant.nom, data })
      else plan.inchanges++
      continue
    }

    let nom = l.nom
    if (nomUnique && nomsPris.has(cle(nom))) {
      const candidats = [l.ville && `${l.nom} – ${l.ville}`, l.code && `${l.nom} (${l.code})`, `${l.nom} (ligne ${l.ligne})`]
      nom = (candidats.find((c) => c && !nomsPris.has(cle(c))) || `${l.nom} (ligne ${l.ligne})`).slice(0, LONGUEURS.nom)
      plan.renommes.push({ ligne: l.ligne, avant: l.nom, apres: nom })
    }
    nomsPris.add(cle(nom))
    plan.creations.push({ ...l, nom })
  }
  return plan
}

/** Réponse de l'API : les compteurs, et le détail des renommages et des lignes ignorées */
export function resumeImport(simulation: boolean, total: number, plan: PlanImport, erreursLecture: ErreurImport[]) {
  const erreurs = [...erreursLecture, ...plan.erreurs].sort((a, b) => a.ligne - b.ligne)
  return {
    simulation,
    total,
    crees: plan.creations.length,
    misAJour: plan.misesAJour.length,
    inchanges: plan.inchanges,
    ignores: erreurs.length,
    renommes: plan.renommes.slice(0, 100),
    erreurs: erreurs.slice(0, 100),
    apercu: plan.creations.slice(0, 5).map(({ ligne, ...f }) => ({ ligne, ...f })),
  }
}

/** Écrit par paquets pour ne pas tenir une transaction trop longue */
export async function parPaquets<T>(items: T[], taille: number, f: (paquet: T[]) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += taille) await f(items.slice(i, i + taille))
}
