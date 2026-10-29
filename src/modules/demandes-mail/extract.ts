// Extraction d'une demande de devis client (ordre de service de syndic, demande PDF…)
// à partir du texte du mail et de ses PDF. Fonctions pures (pas de base, pas de réseau).
// Règles écrites sur de vrais mails reçus sur contact@ : un ordre de service Foncia (texte du mail)
// et une demande de devis de syndic (PDF seul).
import type { Categorie } from '@gd/shared/types'
import { detecterCategorie, lignes, parseDate, parseMontant, type MailLu } from '../import-mail/extract.ts'
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

export type Boite = 'Devis' | 'Intervention' | 'Chantier' | 'Facture'

export interface ExtractionDemande {
  estUneDemande: boolean
  /** Boîte où ranger le mail : demande de chiffrage, demande d'intervention (dépannage, fuite, ordre de service…), gros chantier ou facturation */
  boite: Boite
  champs: ChampsDemande
  /** Paiement ou facture cités dans le mail (utile dans la boîte Facture) */
  reglement: ReglementLu
}

export interface ReglementLu {
  /** N° de facture GD cité (ex. FGD26-00012) */
  numeroFacture: string | null
  montant: number | null
  /** Virement, Chèque, Prélèvement… */
  mode: string | null
  /** Date du paiement (AAAA-MM-JJ) */
  date: string | null
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

/** Le client demande un chiffrage (pas encore de travaux commandés) */
const DEMANDE_DEVIS = /demande de devis|(?:[ée]tablir|faire|chiffrer|transmettre|adresser|envoyer|faire parvenir|proposer)\b[^.\n]{0,40}\bdevis|devis pour|chiffrage/i

/** Le client demande qu'on passe sur place : dépannage, urgence, ordre de service, sinistre… */
const DEMANDE_INTERVENTION =
  /ordre de service|bon d['’]intervention|merci d['’]intervenir|\bintervenir\b|\binterventions?\b|d[ée]pann|r[ée]paration|\bfuites?\b|infiltrations?|d[ée]g[aâ]ts? des eaux|sinistre|\burgen(?:t|te|ts|tes|ce)\b|recherche de fuite|b[aâ]chage|mise en s[ée]curit[ée]|engorg|bouch[ée]e?s?\b|tuiles? (?:tomb|cass|envol|d[ée]plac)|passer (?:sur place|voir|constater)/i

/** Vocabulaire des gros chantiers : marché, consultation, suivi de chantier, maîtrise d'œuvre… */
const GROS_CHANTIER =
  /r[ée]union de chantier|compte[- ]rendu (?:de |du )?chantier|\bCR de chantier|planning (?:des travaux|de chantier|du chantier)|d[ée]marrage (?:des travaux|du chantier)|ordre de d[ée]marrage|[ée]chafaudage|ma[îi]tr(?:e|ise) d['’](?:[œo]e?uvre|ouvrage)|\bMOE\b|appel d['’]offres?|\bDCE\b|\bCCTP\b|\bDPGF\b|\blot n[°o]|PV de r[ée]ception|lev[ée]e des r[ée]serves|travaux vot[ée]s|r[ée]fection (?:compl[eè]te|totale|int[ée]grale)|gros chantier/i

/** Paiement annoncé ou réclamé : sans ambiguïté, l'emporte sur tout le reste */
const PAIEMENT =
  /avis de (?:paiement|virement|r[èe]glement|domiciliation)|virement (?:effectu[ée]|[ée]mis|bancaire|de \d)|remise de ch[èe]que|lettre[- ]ch[èe]que|\bimpay[ée]e?s?\b|relance (?:de paiement|facture|pour (?:la )?facture)|bon pour paiement|attestation de paiement|mise en paiement|paiement (?:de|du|des) (?:la |votre |vos |notre )?factures?|r[èe]glement (?:de|du|des) (?:la |votre |vos |notre )?factures?/i
/** Facture citée : moins fort qu'un paiement, un ordre de service parle souvent de « votre facture » */
const FACTURE = /\bfacture\s*n[°o]|\bFGD\d{2}-\d+|situation (?:de travaux|n[°o])|\bavoir n[°o]|duplicata|relev[ée] de compte|(?:ci-joint|vous trouverez)[^.\n]{0,30}\bfacture/i

/**
 * Boîte du mail. Un paiement l'emporte ; puis le vocabulaire de gros chantier ; un ordre de service commande des travaux ;
 * une facture citée va en facturation ; sinon une demande de chiffrage explicite reste un devis.
 */
export function boiteDe(texte: string): Boite {
  if (PAIEMENT.test(texte)) return 'Facture'
  if (GROS_CHANTIER.test(texte)) return 'Chantier'
  if (/ordre de service|bon d['’]intervention/i.test(texte)) return 'Intervention'
  if (FACTURE.test(texte)) return 'Facture'
  if (DEMANDE_DEVIS.test(texte)) return 'Devis'
  return DEMANDE_INTERVENTION.test(texte) ? 'Intervention' : 'Devis'
}

/** Candidature : CV en pièce jointe, ou mail qui parle de CV / candidature */
const CV_PIECE = /(?:^|[^a-z])(?:cv|curriculum)(?:[^a-z]|$)/i
const CV_TEXTE = /\bcv\b|curriculum vitae|candidature|lettre de motivation|recherche d['’](?:un )?(?:emploi|stage|alternance)|offre d['’]emploi/i
/** Rubriques d'un CV : il en faut au moins deux dans le PDF */
const RUBRIQUES_CV = [/exp[ée]riences? professionnelles?/i, /\bformations?\b/i, /comp[ée]tences/i, /centres? d['’]int[ée]r[êe]ts?/i, /\blangues\b/i, /\bdipl[ôo]mes?\b/i]

/** Le mail ressemble à une candidature (CV) : texte du mail, noms des pièces jointes, texte des PDF. */
export function ressembleACv(texteMail: string, nomsPieces: string[], textePdf = ''): boolean {
  if (nomsPieces.some((n) => CV_PIECE.test(n.replace(/\.[a-z0-9]+$/i, '')))) return true
  if (CV_TEXTE.test(texteMail)) return true
  return RUBRIQUES_CV.filter((r) => r.test(textePdf)).length >= 2
}

/** Ce qu'on regarde pour ranger un mail dans un dossier automatique */
export interface MailARanger {
  /** Objet et texte du mail */
  texte: string
  /** Adresse de l'expéditeur */
  expediteur: string
  nomsPieces: string[]
  textePdf?: string
}

export interface DossierAuto {
  nom: string
  /** Motif affiché quand le mail est écarté */
  motif: string
  /** Le mail n'est pas une demande client : il sort de la file « À traiter » */
  ecarter: boolean
}

const NEGOCES =
  /@(?:[\w-]+\.)*(?:pointp|cedeo|lariviere|gedimat|bigmat|raboni|sfic|prolians|dispano|chausson|wienerberger|terreal|edilians|monier|bmigroup|vmzinc|siga|soprema|siplast|velux|descours-cabaud|tout-faire)\.[a-z]+$/i
const FOURNISSEUR = /bon de livraison|confirmation de (?:votre )?commande|accus[ée] de r[ée]ception de (?:votre )?commande|avis d['’]exp[ée]dition|votre commande n[°o]|proforma|bon de commande fournisseur/i
const SOUS_TRAITANT = /attestation de vigilance|\bk-?bis\b|sous[- ]trait(?:ant|ance)|\bDC4\b|attestation (?:urssaf|fiscale) de r[ée]gularit[ée]/i
const ASSURANCE =
  /\bexpert(?:ise)?s?\b|cabinet d['’]expertise|n[°o] de sinistre|r[ée]f(?:[ée]rence)?\.? sinistre|\bassureurs?\b|compagnie d['’]assurance|d[ée]cennale|attestation d['’]assurance|dommages[- ]ouvrage/i
const MARCHE_PUBLIC =
  /avis d['’]appel public|\bBOAMP\b|march[ée]s? publics?|achatpublic|maximilien|place des march[ée]s|marches-publics\.gouv|dematis|aws-achat|\bJOUE\b|profil acheteur/i
const ADMINISTRATIF =
  /\burssaf\b|impots\.gouv|\bDGFiP\b|net-entreprises|pro ?btp\b|\bCIBTP\b|btp[- ]pr[ée]voyance|caisse (?:des )?cong[ée]s pay[ée]s|relev[ée] (?:de compte )?bancaire|pr[ée]l[èe]vement SEPA|avis d['’]imp[ôo]t|d[ée]claration sociale nominative|\bDSN\b/i
const PUBLICITE =
  /se d[ée]sabonner|d[ée]sinscri(?:re|ption|vez)|unsubscribe|newsletter|webinaire|webinar|offre promotionnelle|promotions? du mois|voir (?:la )?version en ligne|ne plus recevoir (?:nos|ces) (?:e-?mails|messages|offres)/i

/** Dossiers remplis automatiquement, dans l'ordre où ils sont essayés (le premier qui correspond l'emporte). */
export const DOSSIERS_AUTO: (DossierAuto & { correspond: (m: MailARanger) => boolean })[] = [
  {
    nom: 'CV',
    motif: 'Candidature (CV) : rangée dans le dossier CV',
    ecarter: true,
    correspond: (m) => ressembleACv(m.texte, m.nomsPieces, m.textePdf),
  },
  // Assurances et marchés publics peuvent mener à des travaux : rangés mais gardés « À traiter »
  { nom: 'Assurances / sinistres', motif: 'Rangé dans le dossier Assurances / sinistres', ecarter: false, correspond: (m) => ASSURANCE.test(m.texte) },
  { nom: 'Marchés publics', motif: 'Rangé dans le dossier Marchés publics', ecarter: false, correspond: (m) => MARCHE_PUBLIC.test(m.texte) },
  // Une newsletter de négoce est d'abord une publicité
  { nom: 'Publicité / newsletters', motif: 'Publicité ou newsletter : rangée dans le dossier Publicité / newsletters', ecarter: true, correspond: (m) => PUBLICITE.test(m.texte) },
  { nom: 'Sous-traitants', motif: 'Mail de sous-traitant : rangé dans le dossier Sous-traitants', ecarter: true, correspond: (m) => SOUS_TRAITANT.test(m.texte) },
  { nom: 'Administratif', motif: 'Mail administratif : rangé dans le dossier Administratif', ecarter: true, correspond: (m) => ADMINISTRATIF.test(m.texte) },
  {
    nom: 'Fournisseurs',
    motif: 'Mail de fournisseur : rangé dans le dossier Fournisseurs',
    ecarter: true,
    correspond: (m) => NEGOCES.test(m.expediteur) || FOURNISSEUR.test(m.texte),
  },
]

/** Dossier automatique du mail (null : aucun). */
export function dossierAutoDe(m: MailARanger): DossierAuto | null {
  const d = DOSSIERS_AUTO.find((x) => x.correspond(m))
  return d ? { nom: d.nom, motif: d.motif, ecarter: d.ecarter } : null
}

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

const MONTANT = String.raw`(\d{1,3}(?:[\s .]\d{3})*(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s*(?:€|eur(?:os?)?\b)`

/** N° de facture, montant, mode et date d'un paiement cités dans le mail. */
export function extraireReglement(texte: string, dateMail: Date): ReglementLu {
  const numeroFacture =
    texte.match(/\b(FGD\d{2}-\d{3,6})\b/i)?.[1]?.toUpperCase() ?? texte.match(/facture\s*n[°o]\.?\s*:?\s*([A-Z0-9][A-Z0-9/-]{2,})/i)?.[1] ?? null
  // Le montant le plus proche d'un mot de paiement, sinon le premier montant en euros
  const proche = texte.match(new RegExp(String.raw`(?:montant|somme|total|virement|r[èe]glement|paiement|ch[èe]que)[^\n€]{0,40}?${MONTANT}`, 'i'))?.[1]
  const brut = proche ?? texte.match(new RegExp(MONTANT, 'i'))?.[1]
  const montant = brut ? parseMontant(brut) : null
  const mode = /virement/i.test(texte)
    ? 'Virement'
    : /ch[èe]que/i.test(texte)
      ? 'Chèque'
      : /pr[ée]l[èe]vement/i.test(texte)
        ? 'Prélèvement'
        : null
  const date =
    lignes(texte)
      .filter((l) => /(?:date (?:de |du )?(?:paiement|virement|r[èe]glement|valeur|op[ée]ration)|vir[ée] le|pay[ée] le|effectu[ée] le)/i.test(l))
      .map(parseDate)
      .find(Boolean) ?? dateMail.toISOString().slice(0, 10)
  return { numeroFacture, montant: montant && montant > 0 ? montant : null, mode, date }
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

  const boite = boiteDe(tout)
  // Tout ce qui ressemble à une intervention ou à un gros chantier est gardé, même sans métier reconnu
  const estUneDemande = DEMANDE_FORTE.test(tout) || (/\b(?:devis|intervention|intervenir|travaux)\b/i.test(tout) && categorie !== null) || boite !== 'Devis'

  return {
    estUneDemande,
    boite,
    reglement: extraireReglement([mail.objet, ...ls].join('\n'), mail.date),
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
