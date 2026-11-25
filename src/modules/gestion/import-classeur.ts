// Import du classeur « Tableau de bord » (Excel) : les lignes sont retrouvées par leur libellé,
// pas par leur numéro, pour résister aux lignes ajoutées ou déplacées d'une année à l'autre.
import {
  douze,
  exerciceVide,
  heuresPrevues,
  salairesDuMois,
  previsionVide,
  realiseVide,
  type CompteFraisGeneraux,
  type ExerciceGestion,
  type LigneSalaire,
  type PrevisionMois,
  type RealiseMois,
} from '@gd/shared/gestion'
import { ValidationError } from '../../lib/app-error.ts'
import { lireClasseur, type FeuilleTableur, type LigneTableur } from '../../lib/xlsx.ts'

/** Libellé comparable : sans accents, casse, espaces ni ponctuation */
const cle = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, '')

const nombre = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null
  const n = Number(v.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/** Colonnes des 12 mois : C à N dans Prévisions, Suivi et Saisie de données */
const COLS_MOIS = Array.from({ length: 12 }, (_, i) => 2 + i)

class Feuille {
  readonly f: FeuilleTableur
  constructor(f: FeuilleTableur) {
    this.f = f
  }
  /** Première ligne dont la colonne `col` porte ce libellé */
  ligne(libelle: string, col = 0): LigneTableur | undefined {
    const k = cle(libelle)
    return this.f.lignes.find((l) => cle(l.cellules[col] ?? '') === k)
  }
  /** Les 12 valeurs mensuelles d'une ligne (vide = null) */
  mois(libelle: string): (number | null)[] {
    const l = this.ligne(libelle)
    return COLS_MOIS.map((c) => nombre(l?.cellules[c]))
  }
  /** Valeur à droite d'un libellé, n'importe où dans la feuille */
  apres(libelle: string, decalage = 1): number | null {
    const k = cle(libelle)
    for (const l of this.f.lignes) {
      const j = l.cellules.findIndex((c) => cle(c ?? '') === k)
      if (j >= 0) return nombre(l.cellules[j + decalage])
    }
    return null
  }
}

function feuille(feuilles: FeuilleTableur[], ...noms: string[]): Feuille | null {
  for (const nom of noms) {
    const f = feuilles.find((x) => cle(x.nom) === cle(nom))
    if (f) return new Feuille(f)
  }
  return null
}

/** Comptes de frais généraux : lignes « 604000000 Achats… » */
const COMPTE = /^(\d{6,9})\s+(.+)$/

function comptes(f: Feuille): Map<string, { libelle: string; valeurs: (number | null)[]; ordre: number }> {
  const out = new Map<string, { libelle: string; valeurs: (number | null)[]; ordre: number }>()
  f.f.lignes.forEach((l, ordre) => {
    const m = COMPTE.exec((l.cellules[0] ?? '').trim())
    if (!m || out.has(m[1])) return
    out.set(m[1], { libelle: m[2].trim(), valeurs: COLS_MOIS.map((c) => nombre(l.cellules[c])), ordre })
  })
  return out
}

export interface ResumeImportGestion {
  annee: number
  caAnnuelPrevu: number
  moisSuivis: number
  caRealise: number
  comptes: number
  salaries: number
  interimaires: number
  avertissements: string[]
}

/** Lit le classeur et construit l'exercice ; `annee` sert si le classeur ne l'indique pas. */
export function lireClasseurGestion(buf: Buffer, anneeParDefaut: number): { exercice: ExerciceGestion; resume: ResumeImportGestion } {
  const feuilles = lireClasseur(buf)
  const prev = feuille(feuilles, 'Prévisions')
  const suivi = feuille(feuilles, 'Suivi')
  if (!prev || !suivi) throw new ValidationError(undefined, 'Ce classeur n’a pas les feuilles « Prévisions » et « Suivi » du tableau de bord')
  const saisie = feuille(feuilles, 'SAISIE DE DONNES', 'SAISIE DE DONNEES', 'Saisie de données')
  const salaire = feuille(feuilles, 'Suivi salaire')
  const avertissements: string[] = []

  // Année : cellule à droite de « Cellules à saisir ----> »
  const anneeLue = prev.apres('Cellules à saisir ----->', 2) ?? suivi.apres('Cellules à saisir ----->', 2)
  const annee = anneeLue && anneeLue > 2000 && anneeLue < 2100 ? anneeLue : anneeParDefaut
  const ex = exerciceVide(annee)

  /* Paramètres */
  ex.parametres.caAnnuel = prev.apres('C.A / an') ?? 0
  ex.parametres.shmPrevu = prev.apres('SHM chargé') ?? 0
  ex.parametres.coutsDirects = {
    mainOeuvre: prev.apres("% Main d'Oeuvre / CD", 4) ?? 0,
    materiaux: prev.apres('% Matériaux / CD', 4) ?? 0,
    autresFrais: prev.apres('% Autres Frais / CD', 4) ?? 0,
    sousTraitance: prev.apres('% Sous Traitants / CD', 4) ?? 0,
  }
  if (!ex.parametres.caAnnuel) avertissements.push('CA annuel visé introuvable (« C.A / an ») : à saisir dans les prévisions')

  /* Prévisions mensuelles */
  const champsPrev: [keyof PrevisionMois, string][] = [
    ['joursOuvrables', 'Nbre jours ouvrables'],
    ['joursFermeture', 'Nbre de jours de fermeture'],
    ['congesPayes', 'Jours de congés payés'],
    ['effectif', 'Effectif Entreprise'],
    ['apprentis', 'Apprentis'],
    ['interimaires', 'Intérimaires'],
    ['horaireJour', 'Horaire Jour'],
    ['absenteisme', 'Absentéisme en %'],
    ['intemperiesJours', 'Intempéries en Jours'],
    ['intemperiesPart', '% effectif en intempéries'],
    ['formationH', 'Formations en Heure'],
    ['travauxEntrepriseH', "Travaux pour l'ent. en H"],
    ['autresHNonVendables', 'Autres H non vendables'],
  ]
  const valeursPrev = Object.fromEntries(champsPrev.map(([k, lib]) => [k, prev.mois(lib)])) as Record<keyof PrevisionMois, (number | null)[]>
  ex.previsions = douze(previsionVide).map((p, i) => {
    for (const [k] of champsPrev) p[k] = valeursPrev[k][i] ?? (k === 'horaireJour' ? p.horaireJour : 0)
    return p
  })

  /* Réalisé : saisie de données (CA et coûts) + suivi (heures non vendables, remboursements, en-cours) */
  const ca = saisie?.mois('Chiffre Affaire') ?? douze(() => null)
  const mat = saisie?.mois('Coût Matériaux') ?? douze(() => null)
  const af = saisie?.mois('Coût Autres Frais') ?? douze(() => null)
  const st = saisie?.mois('Coût Sous Traitant') ?? douze(() => null)
  if (!saisie) avertissements.push('Feuille « SAISIE DE DONNES » absente : CA et coûts réels non repris')
  const suiviH = (lib: string) => suivi.mois(lib)
  const intemp = suiviH('Intempéries totales en H')
  const form = suiviH('Formations en Heure')
  const trav = suiviH("Travaux pour l'ent. en H")
  const autres = suiviH('Autres H non vendables')
  const remb = suiviH('Remboursements')
  const encours = suiviH('En cours fin de mois')
  const heuresSuivi = suiviH('Heures Payées')
  ex.realise = douze(realiseVide).map(
    (_, i): RealiseMois => ({
      ca: ca[i],
      materiaux: mat[i],
      autresFrais: af[i],
      sousTraitance: st[i],
      remboursements: remb[i],
      enCours: encours[i],
      heuresPayees: null,
      intemperiesH: intemp[i],
      formationH: form[i],
      travauxEntrepriseH: trav[i],
      autresHNonVendables: autres[i],
    }),
  )
  // Mois suivis : derniers mois dont le CA est saisi
  const dernier = ca.reduce<number>((n, v, i) => (v !== null ? i + 1 : n), 0)
  ex.parametres.moisSuivis = dernier

  /* Frais généraux : comptes de la feuille Prévisions, réalisé de la feuille Suivi */
  const fgPrev = comptes(prev)
  const fgReel = comptes(suivi)
  const tous = new Map([...fgPrev, ...[...fgReel].filter(([k]) => !fgPrev.has(k))])
  ex.fraisGeneraux = [...tous.entries()]
    .sort((a, b) => (fgPrev.has(a[0]) ? 0 : 1) - (fgPrev.has(b[0]) ? 0 : 1) || a[1].ordre - b[1].ordre)
    .map(
      ([compte, c]): CompteFraisGeneraux => ({
        compte,
        libelle: c.libelle.slice(0, 120),
        prevu: (fgPrev.get(compte)?.valeurs ?? douze(() => 0)).map((v) => v ?? 0),
        // Réalisé sur les mois suivis, montants actualisés au-delà (vides : prévu repris)
        // Compte absent du Suivi : rien de dépensé ni d'attendu (le classeur le compte à 0)
        realise: fgReel.get(compte)?.valeurs ?? douze(() => (fgReel.size ? 0 : null)),
      }),
    )

  /* Salaires : bloc PRODUCTION (brut, charges, heures par mois) puis bloc INTERIM (coût, heures) */
  ex.salaires = salaire ? lireSalaires(salaire, avertissements) : []
  if (!salaire) avertissements.push('Feuille « Suivi salaire » absente : salaires non repris')

  // Heures payées forcées dans le Suivi (ex. mois de fermeture) : reprises seulement si elles diffèrent du calcul
  ex.realise.forEach((r, i) => {
    const lu = heuresSuivi[i]
    if (lu === null) return
    const calcule = salairesDuMois(ex.salaires, i).heures || heuresPrevues(ex.previsions[i]).heuresPayees
    if (Math.abs(lu - calcule) > 0.5) r.heuresPayees = lu
  })

  const resume: ResumeImportGestion = {
    annee,
    caAnnuelPrevu: ex.parametres.caAnnuel,
    moisSuivis: dernier,
    caRealise: ca.reduce<number>((s, v) => s + (v ?? 0), 0),
    comptes: ex.fraisGeneraux.length,
    salaries: ex.salaires.filter((s) => s.type === 'Production').length,
    interimaires: ex.salaires.filter((s) => s.type === 'Intérim').length,
    avertissements,
  }
  return { exercice: ex, resume }
}

const MOIS_LONGS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre']

function lireSalaires(f: Feuille, avertissements: string[]): LigneSalaire[] {
  const lignes = f.f.lignes
  const out: LigneSalaire[] = []
  const iProd = lignes.findIndex((l) => cle(l.cellules[0] ?? '') === 'production')
  const iInterim = lignes.findIndex((l) => cle(l.cellules[0] ?? '') === 'interim')
  /** Colonne de début de chaque mois : ligne d'en-tête des mois au-dessus du bloc */
  const colonnesMois = (avant: number) => {
    for (let i = avant; i >= Math.max(0, avant - 4); i--) {
      const cols = MOIS_LONGS.map((m) => lignes[i].cellules.findIndex((c) => cle(c ?? '') === m))
      if (cols.every((c) => c >= 0)) return cols
    }
    return null
  }
  const nomValide = (n: string) => n.trim() && !/^(total|production|interim|interimaires)$/i.test(cle(n))

  if (iProd >= 0) {
    const cols = colonnesMois(iProd - 1)
    if (!cols) avertissements.push('Salaires de production : en-tête des mois introuvable')
    else
      for (let i = iProd + 1; i < lignes.length; i++) {
        const nom = (lignes[i].cellules[0] ?? '').trim()
        if (!nom) break
        if (!nomValide(nom)) break
        const c = lignes[i].cellules
        out.push({
          nom: nom.slice(0, 120),
          type: 'Production',
          brut: cols.map((k) => nombre(c[k])),
          charges: cols.map((k) => nombre(c[k + 1])),
          heures: cols.map((k) => nombre(c[k + 2])),
        })
      }
  }
  if (iInterim >= 0) {
    const cols = colonnesMois(iInterim - 1) ?? colonnesMois(iInterim - 2)
    if (!cols) avertissements.push('Intérim : en-tête des mois introuvable')
    else
      for (let i = iInterim + 1; i < lignes.length; i++) {
        const nom = (lignes[i].cellules[0] ?? '').trim()
        if (!nom || !nomValide(nom)) break
        const c = lignes[i].cellules
        out.push({ nom: nom.slice(0, 120), type: 'Intérim', brut: cols.map((k) => nombre(c[k])), charges: douze(() => null), heures: cols.map((k) => nombre(c[k + 1])) })
      }
  }
  // Une ligne sans aucune valeur sur l'année n'apporte rien
  return out.filter((s) => [...s.brut, ...s.charges, ...s.heures].some((v) => v))
}
