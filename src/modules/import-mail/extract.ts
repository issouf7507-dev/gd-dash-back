// Extraction des champs d'un devis à partir du mail SolutionsBTP et du texte de son PDF.
// Fonctions pures (pas de base, pas de réseau) : testées sur des mails d'exemple.
// ⚠️ Règles écrites sur un mail fictif : à ajuster dès qu'on aura un vrai mail (jalon M5).
import { CATEGORIES, type Categorie } from '@gd/shared/types'

export interface MailLu {
  objet: string
  corps: string
  /** Texte de tous les PDF joints, mis bout à bout */
  textePdf: string
  expediteur: { nom: string; email: string }
  destinataires: { nom: string; email: string }[]
  date: Date
}

export interface ChampsExtraits {
  numero: string | null
  dateReception: string | null
  clientNom: string | null
  clientEmail: string | null
  adresse: string | null
  descriptif: string | null
  categorie: Categorie | null
  /** La catégorie vient d'un seul mot-clé, ou de plusieurs métiers à égalité */
  categorieIncertaine: boolean
  montantHT: number | null
  /** Nom du conducteur indiqué dans la fiche du mail (rapproché des utilisateurs par le service) */
  conducteurNom: string | null
  /** Le mail contient la fiche récapitulative du format recommandé */
  ficheTrouvee: boolean
}

export interface Extraction {
  estUnDevis: boolean
  champs: ChampsExtraits
}

/** Numéro SolutionsBTP. Forme supposée : DGD26-0930 (préfixe, année sur 2 chiffres, numéro). */
const NUMERO = /\b([A-Z]{2,5}\d{2}-\d{3,6})\b/
const NUMERO_APRES_DEVIS = /devis\s*(?:n[°o]|num[ée]ro)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-/]{4,})/i

/** Mots-clés métier → catégorie. Le score le plus élevé l'emporte. */
const MOTS_CLES: Record<Categorie, RegExp[]> = {
  Couverture: [/couverture/i, /toiture/i, /\btuiles?\b/i, /ardoises?/i, /\bzinc/i, /goutti[èe]re/i, /ch[ée]neau/i, /fa[îi]tage/i, /\bvelux\b/i, /chatière/i, /charpente/i, /descente[s]? d['’]eaux? pluviale/i],
  Plomberie: [/plomberie/i, /fuite/i, /canalisation/i, /\bwc\b/i, /sanitaire/i, /chauffe[- ]eau/i, /ballon d['’]eau/i, /robinet/i, /colonne/i, /évacuation/i, /siphon/i, /\bpvc\b/i],
  Étanchéité: [/[ée]tanch[ée]it[ée]/i, /terrasse/i, /membrane/i, /bitum/i, /asphalte/i, /\bepdm\b/i, /relev[ée]s? d['’][ée]tanch/i, /toiture[- ]terrasse/i],
  'Ravalement / Peinture': [/ravalement/i, /peinture/i, /fa[çc]ade/i, /enduit/i, /badigeon/i, /\bcrépi/i, /lessivage/i],
}

/** Normalise les espaces (y compris insécables) et coupe en lignes non vides. */
export const lignes = (t: string) =>
  t
    .replace(/[  ]/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

/** « 4 250,00 € » / « 4.250,00 » / « 4250.5 » → 4250 / 4250 / 4250.5 */
export function parseMontant(s: string): number | null {
  const brut = s.replace(/[\s  €]/g, '')
  if (!/\d/.test(brut)) return null
  // Le dernier séparateur suivi de 1 ou 2 chiffres est le séparateur décimal
  const m = brut.match(/^(.*?)[.,](\d{1,2})$/)
  const entier = (m ? m[1] : brut).replace(/[.,]/g, '')
  const n = Number(m ? `${entier}.${m[2]}` : entier)
  return Number.isFinite(n) ? n : null
}

/** « 09/10/2026 », « 9-10-26 » ou « 9 octobre 2026 » → 2026-10-09 */
export function parseDate(s: string): string | null {
  const num = s.match(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/)
  const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
  let j: number, m: number, a: number
  if (num) {
    ;[j, m, a] = [Number(num[1]), Number(num[2]), Number(num[3])]
  } else {
    const txt = s.toLowerCase().match(/\b(\d{1,2})(?:er)?\s+([a-zéû]+)\s+(\d{4})\b/)
    if (!txt) return null
    const idx = MOIS.findIndex((mo) => mo === txt[2] || mo.normalize('NFD').replace(/\p{M}/gu, '') === txt[2])
    if (idx < 0) return null
    ;[j, m, a] = [Number(txt[1]), idx + 1, Number(txt[3])]
  }
  if (a < 100) a += 2000
  if (m < 1 || m > 12 || j < 1 || j > 31) return null
  return `${a}-${String(m).padStart(2, '0')}-${String(j).padStart(2, '0')}`
}

/** Valeur qui suit une étiquette « Libellé : valeur » sur la même ligne, sinon la ligne suivante. */
function apresEtiquette(ls: string[], etiquette: RegExp): string | null {
  for (let i = 0; i < ls.length; i++) {
    const m = ls[i].match(new RegExp(`^(?:${etiquette.source})\\s*:?\\s*(.*)$`, 'i'))
    if (!m) continue
    if (m[1]) return m[1].trim()
    if (ls[i + 1]) return ls[i + 1]
  }
  return null
}

/** Adresse sur une ou deux lignes : « 12 rue X » puis « 75004 PARIS » sont regroupées. */
function adresseApres(ls: string[], etiquette: RegExp): string | null {
  const i = ls.findIndex((l) => new RegExp(`^(?:${etiquette.source})`, 'i').test(l))
  if (i < 0) return null
  const surLaLigne = ls[i].replace(new RegExp(`^(?:${etiquette.source})\\s*:?\\s*`, 'i'), '').trim()
  const morceaux = surLaLigne ? [surLaLigne] : []
  // Complète avec les lignes suivantes tant qu'on n'a pas de code postal
  for (let k = i + 1; k < ls.length && morceaux.length < 3 && !/\b\d{5}\b/.test(morceaux.join(' ')); k++) morceaux.push(ls[k])
  const adresse = morceaux.join(', ').replace(/,\s*(\d{5})/, ' $1')
  return /\d/.test(adresse) ? adresse : null
}

export function detecterCategorie(texte: string): { categorie: Categorie | null; incertaine: boolean } {
  const scores = CATEGORIES.map((c) => ({ c, n: MOTS_CLES[c].filter((r) => r.test(texte)).length })).sort((a, b) => b.n - a.n)
  const [premier, second] = scores
  if (premier.n === 0) return { categorie: null, incertaine: true }
  return { categorie: premier.c, incertaine: premier.n < 2 || premier.n === second.n }
}

/**
 * Fiche récapitulative du FORMAT RECOMMANDÉ (bas du mail, une info par ligne « Libellé : valeur ») :
 *   Réf. devis : DGD26-0930 · Date : 09/10/2026 · Client : … · Adresse chantier : … · Objet : …
 *   Montant HT : 4 250,00 € · Métier : Couverture · Conducteur : …
 * Quand elle est présente, elle est prioritaire sur la lecture du PDF (plus fiable).
 */
const ETIQUETTES_FICHE: [RegExp, keyof Fiche][] = [
  [/^(?:r[ée]f(?:[ée]rence)?\.?|n[°o]|num[ée]ro) ?(?:du )?devis$/, 'numero'],
  [/^date(?: du devis)?$/, 'date'],
  [/^client$/, 'client'],
  [/^adresse (?:du |des )?(?:chantier|travaux)$/, 'adresse'],
  [/^objet$/, 'objet'],
  [/^montant (?:total )?h\.?t\.?$/, 'montant'],
  [/^(?:m[ée]tier|cat[ée]gorie|corps d.[ée]tat)$/, 'metier'],
  [/^(?:conducteur(?: de travaux)?|suivi par|charg[ée] d.affaires?)$/, 'conducteur'],
]
type Fiche = Partial<Record<'numero' | 'date' | 'client' | 'adresse' | 'objet' | 'montant' | 'metier' | 'conducteur', string>>

export function lireFiche(texte: string): Fiche {
  const fiche: Fiche = {}
  for (const l of lignes(texte)) {
    const m = l.match(/^([^:]{2,40}?)\s*:\s*(.+)$/)
    if (!m) continue
    const etiquette = m[1].toLowerCase().trim()
    const cle = ETIQUETTES_FICHE.find(([re]) => re.test(etiquette))?.[1]
    if (cle && !fiche[cle]) fiche[cle] = m[2].trim()
  }
  return fiche
}

const categorieExacte = (s: string | undefined): Categorie | null => {
  if (!s) return null
  const n = s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  return CATEGORIES.find((c) => c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().startsWith(n.slice(0, 4))) ?? null
}

export function extraire(mail: MailLu): Extraction {
  const pdf = lignes(mail.textePdf)
  const fiche = lireFiche(mail.corps)
  // Fiche considérée présente si elle donne au moins le numéro et le client
  const ficheTrouvee = !!(fiche.numero && fiche.client)
  const corps = lignes(mail.corps)
  const tout = [mail.objet, ...corps, ...pdf].join('\n')

  const numero = fiche.numero?.match(NUMERO)?.[1] ?? fiche.numero ?? mail.objet.match(NUMERO)?.[1] ?? mail.textePdf.match(NUMERO)?.[1] ?? tout.match(NUMERO_APRES_DEVIS)?.[1] ?? null
  const estUnDevis = /\bdevis\b/i.test(tout) && (numero !== null || mail.textePdf.length > 0)

  const datePdf = apresEtiquette(pdf, /date(?: du devis)?/)
  const dateReception = (fiche.date && parseDate(fiche.date)) ?? (datePdf && parseDate(datePdf)) ?? mail.date.toISOString().slice(0, 10)

  // Client : bloc « Client » du PDF, sinon nom affiché du destinataire
  const destinataire = mail.destinataires.find((d) => !/solutionsbtp|gdcouverture/i.test(d.email))
  const clientNom = fiche.client ?? apresEtiquette(pdf, /client|destinataire|adress[ée] [àa]/) ?? (destinataire?.nom || null)

  const adresse = fiche.adresse ?? adresseApres(pdf, /adresse (?:du |des )?(?:chantier|travaux)|lieu (?:du chantier|des travaux|d\W?intervention)|chantier/)

  const descriptif = fiche.objet ?? apresEtiquette(pdf, /objet(?: du devis)?|d[ée]signation/) ?? (mail.objet.replace(NUMERO, '').replace(/^\W*devis\W*/i, '').trim() || null)

  const totalHT = pdf.map((l) => l.match(/total\s*(?:net\s*)?h\.?\s*t\.?\s*:?\s*([\d\s.,]+)\s*€?/i)?.[1]).find(Boolean)
  const montantHT = (fiche.montant ? parseMontant(fiche.montant) : null) ?? (totalHT ? parseMontant(totalHT) : null)

  // Métier indiqué dans la fiche = certain ; sinon déduit des mots-clés du devis
  const metier = categorieExacte(fiche.metier)
  const { categorie, incertaine } = metier ? { categorie: metier, incertaine: false } : detecterCategorie([mail.objet, descriptif ?? '', ...pdf].join('\n'))

  return {
    estUnDevis,
    champs: {
      numero,
      dateReception,
      clientNom,
      clientEmail: destinataire?.email ?? null,
      adresse,
      descriptif,
      categorie,
      categorieIncertaine: incertaine,
      montantHT,
      conducteurNom: fiche.conducteur ?? null,
      ficheTrouvee,
    },
  }
}
