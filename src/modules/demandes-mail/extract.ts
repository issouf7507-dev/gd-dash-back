// Extraction d'une demande de devis client (ordre de service de syndic, demande PDF…)
// à partir du texte du mail et de ses PDF. Fonctions pures (pas de base, pas de réseau).
// Règles écrites sur de vrais mails reçus sur contact@ : un ordre de service Foncia (texte du mail)
// et une demande de devis de syndic (PDF seul).
import type { Categorie } from '@gd/shared/types'
import { detecterCategorie, lignes, parseDate, type MailLu } from '../import-mail/extract.ts'
import { normaliserNom, rapprocherClient, type ClientConnu, type Rapprochement } from '../import-mail/match-client.ts'

export type TypeDemande = 'Ordre de service' | 'Demande de devis' | 'Autre'

export interface ChampsDemande {
  type: TypeDemande
  /** Référence du client : n° d'ordre de service, n° de demande de devis… */
  reference: string | null
  dateDemande: string
  clientNom: string | null
  /** Adresse mail de l'émetteur d'origine (hors GD), pour reconnaître le client */
  clientEmail: string | null
  gestionnaire: string | null
  adresse: string | null
  /** Digicode, code d'accès, gardien… */
  acces: string | null
  /** Personnes à contacter sur place (avec téléphone) */
  contacts: string[]
  descriptif: string | null
  categorie: Categorie | null
  categorieIncertaine: boolean
  urgent: boolean
}

export interface ExtractionDemande {
  estUneDemande: boolean
  champs: ChampsDemande
}

/** Domaines de GD (la boîte relevée et les collègues qui transfèrent) */
const DOMAINE_GD = /@gdcouverture\.(?:fr|com)$/i
/** Messageries grand public : le domaine ne dit rien du client */
const WEBMAIL = /@(?:gmail|googlemail|yahoo|hotmail|outlook|live|msn|orange|wanadoo|free|sfr|neuf|laposte|icloud|me|aol|bbox|numericable)\./i
/** Adresse de GD, imprimée en destinataire sur les demandes PDF */
const ADRESSE_GD = /sainte[- ]marie|92230\s+gennevilliers/i

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const TELEPHONE = /(?:\+33\s?|\b0)[1-9](?:[\s.-]?\d{2}){4}\b/
const VOIE = String.raw`(?:rue|avenue|av\.?|bd|boulevard|all[ée]e|place|impasse|chemin|quai|cours|square|villa|cit[ée]|passage|route|r[ée]sidence|sentier|faubourg|esplanade|promenade|parvis|rond[- ]point|voie)`
/** « 203 rue du Faubourg Saint-Denis 75010 PARIS » */
const ADRESSE = new RegExp(String.raw`\b\d{1,4}\s*(?:bis|ter)?,?\s+${VOIE}\b[^\n]*?\b\d{5}\s+[A-Za-zÀ-ÿ' -]*[A-Za-zÀ-ÿ]`, 'i')

const REFERENCES: RegExp[] = [
  /ordre de service\s*(?:n[°o]\.?|num[ée]ro)?\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,})/i,
  /demande de devis\s*(?:n[°o]\.?|num[ée]ro)\s*:?\s*([A-Z0-9][A-Z0-9./-]{3,})/i,
  /^(?:n\/\s?r[ée]f(?:[ée]rence)?|notre r[ée]f(?:[ée]rence)?|r[ée]f(?:[ée]rence)?(?: dossier| sinistre)?)\.?\s*:\s*([A-Z0-9][A-Z0-9./-]{3,})/im,
]

/** Formules qui marquent sans ambiguïté une demande de chiffrage ou de travaux */
const DEMANDE_FORTE = /ordre de service|demande de devis|(?:[ée]tablir|faire|chiffrer|transmettre|adresser|envoyer|faire parvenir|proposer)\b[^.\n]{0,40}\bdevis|devis pour|chiffrage|bon de commande|merci d['’]intervenir|intervention urgente/i

/** Lignes qui terminent le descriptif (formules de politesse, observations, transferts…) */
const FIN_DESCRIPTIF =
  /^(?:sinc[eè]res salutations|cordialement|bien cordialement|bien [àa] vous|salutations|meilleures salutations|en vous remerciant|dans l['’]attente|date de r[ée]ception|observations?\s*:|merci de nous confirmer la bonne ex[ée]cution|afin de faciliter|de\s*:|from\s*:|_{4,}|-{4,}|\[)/i

const nettoyer = (s: string) => s.replace(/^[-–•*\s]+/, '').replace(/[\s,;.-]+$/, '').trim()

/** Valeur d'une ligne « Libellé : valeur » (la ligne suivante si la valeur est vide) */
function apres(ls: string[], etiquette: RegExp): string | null {
  for (let i = 0; i < ls.length; i++) {
    const m = ls[i].match(new RegExp(String.raw`^(?:${etiquette.source})\s*:?\s*(.*)$`, 'i'))
    if (!m) continue
    if (m[1].trim()) return m[1].trim()
    if (ls[i + 1] && !/:\s*$/.test(ls[i + 1])) return ls[i + 1]
  }
  return null
}

/** Adresse après une étiquette, sur la même ligne ou les suivantes (jusqu'au code postal) */
function adresseEtiquetee(ls: string[]): string | null {
  const etiquette = /^(?:adresse de l['’]immeuble(?: concern[ée])?|adresse (?:du |des |de l['’])?(?:chantier|travaux|bien|intervention|sinistre|immeuble)|lieu (?:du chantier|des travaux|d['’]intervention)|adresse de livraison|adresse)\s*:?\s*(.*)$/i
  for (let i = 0; i < ls.length; i++) {
    const m = ls[i].match(etiquette)
    if (!m) continue
    const morceaux = m[1] ? [m[1]] : []
    for (let k = i + 1; k < ls.length && morceaux.length < 3 && !/\b\d{5}\b/.test(morceaux.join(' ')); k++) morceaux.push(ls[k])
    const adresse = nettoyer(morceaux.join(' ').replace(/\s+,/g, ','))
    if (/\b\d{5}\b/.test(adresse) && !ADRESSE_GD.test(adresse)) return adresse
  }
  return null
}

/** Adresse de l'émetteur d'origine : « De : … <x@y> » des mails transférés, sinon l'expéditeur. */
function emailOrigine(mail: MailLu): string | null {
  const transferts = lignes(mail.corps)
    .filter((l) => /^(?:de|from|exp[ée]diteur)\s*:/i.test(l))
    .flatMap((l) => l.match(EMAIL) ?? [])
  return [...transferts, mail.expediteur.email].map((e) => e.toLowerCase()).find((e) => !DOMAINE_GD.test(e)) ?? null
}

/** « no-reply@foncia.com » → « FONCIA » (rien pour une messagerie grand public) */
function nomDuDomaine(email: string | null): string | null {
  if (!email || WEBMAIL.test(email)) return null
  const morceaux = email.split('@')[1].split('.')
  return morceaux.length >= 2 ? morceaux[morceaux.length - 2].replace(/[-_]/g, ' ').toUpperCase() : null
}

function descriptifDe(ls: string[], objetMail: string): string | null {
  // « Objet : … » propre à la demande (pas l'en-tête d'un transfert qui reprend l'objet du mail)
  const objet = ls
    .map((l) => l.match(/^objet\s*:\s*(.+)$/i)?.[1])
    .filter((o): o is string => !!o && !/ordre de service|demande de devis|^(?:re|tr|fw|fwd)\s*:/i.test(o))
    .at(-1)

  // Début du texte : après « prestations suivantes : », sinon après la dernière formule d'appel
  const ETIQUETTE = /^.*?(?:prestations suivantes|travaux suivants|nature des travaux|description des travaux|objet de la demande)\s*:?\s*/i
  const APPEL = /^(?:bonjour|madame,? monsieur|madame|monsieur|messieurs)\W*/i
  let debut = ls.findIndex((l) => ETIQUETTE.test(l))
  const etiquetee = debut >= 0
  if (!etiquetee) debut = ls.findLastIndex((l) => APPEL.test(l))
  const texte: string[] = []
  if (debut >= 0) {
    // Texte sur la même ligne que l'étiquette ou la formule d'appel (« Bonjour, merci d'intervenir… »)
    const suite = ls[debut].replace(etiquetee ? ETIQUETTE : APPEL, '')
    if (suite) texte.push(suite)
    for (let k = debut + 1; k < ls.length && !FIN_DESCRIPTIF.test(ls[k]); k++) texte.push(ls[k])
  }
  const tout = [objet, texte.join('\n')].filter(Boolean).join('\n').trim()
  const repli = objetMail.replace(/^(?:\s*(?:re|tr|fw|fwd)\s*:\s*)+/i, '').trim()
  return (tout || repli || null)?.slice(0, 3000) ?? null
}

export function extraireDemande(mail: MailLu): ExtractionDemande {
  const corps = lignes(mail.corps)
  const pdf = lignes(mail.textePdf)
  const ls = [...corps, ...pdf]
  const tout = [mail.objet, ...ls].join('\n')

  const reference = REFERENCES.map((r) => tout.match(r)?.[1]).find(Boolean)?.replace(/[.-]+$/, '') ?? null
  const type: TypeDemande = /ordre de service/i.test(tout) ? 'Ordre de service' : /demande de devis/i.test(tout) ? 'Demande de devis' : 'Autre'

  // « Courbevoie, 12 octobre 2026 » en tête de courrier, sinon la date du mail
  const ligneDate = ls.find((l) => /^[A-ZÀ-Ü][\w' -]+,\s*(?:le\s+)?\d{1,2}(?:er)?[\s/]/.test(l))
  const dateDemande = (ligneDate && parseDate(ligneDate)) || mail.date.toISOString().slice(0, 10)

  const clientEmail = emailOrigine(mail)
  const cabinet = tout.match(/cabinet de gestion[^:\n]*:\s*([^,\n]+)/i)?.[1] ?? tout.match(/^syndic\s*:\s*([^,\n]+)/im)?.[1]
  const clientNom = (cabinet && nettoyer(cabinet)) || nomDuDomaine(clientEmail) || (DOMAINE_GD.test(mail.expediteur.email) ? null : mail.expediteur.nom || null)

  const gestionnaire = apres(ls, /gestionnaire|dossier suivi par|suivi par|votre interlocut(?:eur|rice)/) ?? tout.match(/repr[ée]sent[ée](?:\(e\))?\s+par\s+([^,.\n]+)/i)?.[1]?.trim() ?? null

  const adresse = adresseEtiquetee(ls) ?? [mail.objet, ...ls].map((l) => l.match(ADRESSE)?.[0]).find((a) => a && !ADRESSE_GD.test(a)) ?? null

  const acces = ls
    .filter((l) => /digicode|code d['’]acc[eè]s|code (?:porte|portail|entr[ée]e)|interphone|gardien|badge|cl[ée]s?\s+(?:chez|aupr[eè]s|[àa] r[ée]cup)/i.test(l))
    .filter((l) => !/:\s*$/.test(l))
    .map(nettoyer)
    .filter((l, i, a) => l.length > 0 && a.indexOf(l) === i)
    .slice(0, 4)
    .join(' · ')

  // Lignes avec un téléphone, hors coordonnées du cabinet (« Téléphone : », « Fax », signature)
  const contacts = ls
    .filter((l) => TELEPHONE.test(l) && !/^(?:t[ée]l[ée]phone|t[ée]l|fax|standard|ligne directe|mobile)\s*:|gestionnaire/i.test(l))
    .map(nettoyer)
    .filter((l, i, a) => a.indexOf(l) === i)
    .slice(0, 8)

  const descriptif = descriptifDe(ls, mail.objet)
  // « GD Couverture » (en-tête des PDF, destinataires) ne dit rien du métier demandé
  const { categorie, incertaine } = detecterCategorie([mail.objet, descriptif ?? '', ...pdf].join('\n').replace(/gd\s*couverture/gi, ''))

  const estUneDemande = DEMANDE_FORTE.test(tout) || (/\b(?:devis|intervention|intervenir|travaux)\b/i.test(tout) && categorie !== null)

  return {
    estUneDemande,
    champs: {
      type,
      reference,
      dateDemande,
      clientNom,
      clientEmail,
      gestionnaire: gestionnaire && nettoyer(gestionnaire),
      adresse,
      acces: acces || null,
      contacts,
      descriptif,
      categorie,
      categorieIncertaine: incertaine,
      urgent: /\burgen(?:t|te|ts|tes|ce)\b/i.test(tout),
    },
  }
}

/**
 * Client de la demande : même adresse mail (ou même domaine) qu'une fiche client,
 * sinon nom d'un client cité dans le mail (ex. « FONCIA SEINE OUEST »), sinon nom proposé.
 */
export function rapprocherClientDemande(clients: ClientConnu[], champs: ChampsDemande, texte: string): Rapprochement {
  const email = champs.clientEmail?.toLowerCase()
  if (email) {
    const exact = clients.find((c) => c.email?.toLowerCase() === email)
    if (exact) return { clientId: exact.id, confiance: 'sûr' }
    if (!WEBMAIL.test(email)) {
      const domaine = email.split('@')[1]
      const memeDomaine = clients.filter((c) => c.email?.toLowerCase().endsWith(`@${domaine}`))
      if (memeDomaine.length === 1) return { clientId: memeDomaine[0].id, confiance: 'sûr' }
      if (memeDomaine.length > 1) {
        // Plusieurs agences du même groupe : celle dont le nom apparaît dans le mail
        const cite = memeDomaine.find((c) => ` ${normaliserNom(texte)} `.includes(` ${normaliserNom(c.nom)} `))
        return { clientId: (cite ?? memeDomaine[0]).id, confiance: cite ? 'sûr' : 'proche' }
      }
    }
  }
  // Nom d'un client cité tel quel dans le mail : le plus long l'emporte (« FONCIA SEINE OUEST » plutôt que « FONCIA »)
  const t = ` ${normaliserNom(texte)} `
  const cite = clients
    .map((c) => ({ c, n: normaliserNom(c.nom) }))
    .filter(({ n }) => n.length >= 5 && t.includes(` ${n} `))
    .sort((a, b) => b.n.length - a.n.length)[0]
  if (cite) return { clientId: cite.c.id, confiance: cite.n.length >= 8 ? 'sûr' : 'proche' }
  return rapprocherClient(clients, champs.clientNom, null)
}
