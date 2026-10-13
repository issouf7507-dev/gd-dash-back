// Correspondance clés Prisma ↔ libellés affichés par le front (@gd/shared/types).
// Le client Prisma manipule les clés (ex. CHARGE_AFFAIRES) ; l'API n'expose que les libellés.
import {
  type Categorie as CategorieLabel,
  type Planification as PlanificationLabel,
  type StatutADCI as StatutADCILabel,
  type StatutConducteur as StatutConducteurLabel,
  type TypeClient as TypeClientLabel,
  type Role as RoleLabel,
  type NiveauRelance as NiveauRelanceLabel,
  type Relance,
  type StatutChantier as StatutChantierLabel,
  type StatutFactureSaisi,
  type TypeIntervenant as TypeIntervenantLabel,
} from '@gd/shared/types'
import {
  Categorie,
  DestinataireRelance,
  NiveauRelance,
  Planification,
  RelanceDevis,
  Role,
  StatutADCI,
  StatutChantier,
  StatutConducteur,
  StatutFacture,
  StatutImport,
  TypeClient,
  TypeIntervenant,
} from '../generated/prisma/client.ts'

export const ROLE_LABELS: Record<Role, RoleLabel> = {
  DIRECTION: 'Direction',
  ADMIN: 'Admin',
  CHARGE_AFFAIRES: "Chargé d'affaires",
  CONDUCTEUR: 'Conducteur de travaux',
  ADCI: 'ADCI',
}

const ROLE_KEYS = Object.fromEntries(Object.entries(ROLE_LABELS).map(([k, v]) => [v, k])) as Record<RoleLabel, Role>

export const roleLabel = (r: Role): RoleLabel => ROLE_LABELS[r]
export const roleKey = (label: RoleLabel): Role => ROLE_KEYS[label]
export { Role }

// ─── Devis ───────────────────────────────────────────────────

/** Table clé Prisma ↔ libellé, dans les deux sens. */
function mapping<K extends string, L extends string>(labels: Record<K, L>) {
  const keys = Object.fromEntries(Object.entries(labels).map(([k, v]) => [v, k])) as Record<L, K>
  return { label: (k: K): L => labels[k], key: (l: L): K => keys[l] }
}

export const categorie = mapping<Categorie, CategorieLabel>({
  COUVERTURE: 'Couverture',
  PLOMBERIE: 'Plomberie',
  ETANCHEITE: 'Étanchéité',
  RAVALEMENT_PEINTURE: 'Ravalement / Peinture',
})
export const planification = mapping<Planification, PlanificationLabel>({
  A_PLANIFIER: 'À planifier',
  PLANIFIE: 'Planifié',
  EN_ATTENTE: 'En attente',
  ANNULE: 'Annulé',
})
export const statutADCI = mapping<StatutADCI, StatutADCILabel>({
  NON_TRAITE: 'Non traité',
  EN_ATTENTE_VALIDATION: 'En attente validation',
  VALIDE: 'Validé',
  ENVOYE: 'Envoyé',
  TRANSFERE: 'Transféré',
  A_VENIR: 'À venir',
  ANNULE: 'Annulé',
})
export const statutConducteur = mapping<StatutConducteur, StatutConducteurLabel>({ A_VERIFIER: 'À vérifier', VALIDE: 'Validé' })
export const relanceDevis = mapping<RelanceDevis, 'OUI' | 'NON' | 'RAS'>({ OUI: 'OUI', NON: 'NON', RAS: 'RAS' })
export const statutImport = mapping<StatutImport, 'À vérifier' | 'Importé' | 'Ignoré' | 'Erreur'>({
  A_VERIFIER: 'À vérifier',
  IMPORTE: 'Importé',
  IGNORE: 'Ignoré',
  ERREUR: 'Erreur',
})
export const typeClient = mapping<TypeClient, TypeClientLabel>({
  SYNDIC: 'Syndic / Gestionnaire',
  ARCHITECTE: 'Architecte',
  PARTICULIER: 'Particulier',
  ENTREPRISE: 'Entreprise',
})

// ─── Intervenants, chantiers, factures ───────────────────────

export const typeIntervenant = mapping<TypeIntervenant, TypeIntervenantLabel>({ INTERNE: 'Interne', SOUS_TRAITANT: 'Sous-traitant' })
export const statutChantier = mapping<StatutChantier, StatutChantierLabel>({
  A_VENIR: 'À venir',
  EN_ATTENTE_SIGNATURE: 'En attente signature',
  EN_COURS: 'En cours',
  EN_STAND_BY: 'En stand-by',
  TERMINE: 'Terminé',
  ANNULE: 'Annulé',
})
export const statutFacture = mapping<StatutFacture, StatutFactureSaisi>({ A_VALIDER: 'À valider', VALIDEE: 'Validée' })
export const niveauRelance = mapping<NiveauRelance, NiveauRelanceLabel>({ R1: 'R1', R2: 'R2', R3: 'R3', MD: 'MD' })
export const destinataireRelance = mapping<DestinataireRelance, Relance['destinataire']>({
  CLIENT: 'client',
  CHARGE_AFFAIRES: "chargé d'affaires",
})
