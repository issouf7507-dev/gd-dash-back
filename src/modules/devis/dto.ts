import type { Devis, Prisma, SuiviDevis } from '../../generated/prisma/client.ts'
import { categorie, planification, relanceDevis, resultatDevis, statutADCI, statutConducteur, typeSuiviDevis } from '../../lib/labels.ts'

const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

/** Historique du devis (validation, envoi, relances), du plus ancien au plus récent, avec son auteur */
export const AVEC_SUIVI = {
  suivi: { orderBy: { date: 'asc' }, include: { auteur: { select: { prenom: true, nom: true } } } },
} satisfies Prisma.DevisInclude

type Suivi = SuiviDevis & { auteur: { prenom: string; nom: string } | null }

const toSuiviDto = (s: Suivi) => ({
  id: s.id,
  date: s.date.toISOString(),
  type: typeSuiviDevis.label(s.type),
  auteur: s.auteur ? `${s.auteur.prenom} ${s.auteur.nom}`.trim() : 'Utilisateur supprimé',
  commentaire: s.commentaire,
  email: s.email,
  objet: s.objet,
  statutEnvoi: s.statutEnvoi === 'ENVOYE' ? ('envoyé' as const) : s.statutEnvoi === 'ECHEC' ? ('échec' as const) : null,
  erreur: s.erreur,
})

/** Devis au format du front (@gd/shared/types), avec les champs ajoutés par l'import mail. Sans historique chargé : [] (devis tout juste créé). */
export function toDevisDto(d: Devis & { suivi?: Suivi[] }) {
  return {
    id: d.id,
    numero: d.numero,
    dateReception: isoDate(d.dateReception),
    planification: planification.label(d.planification),
    categorie: categorie.label(d.categorie),
    clientId: d.clientId,
    adresse: d.adresse,
    descriptif: d.descriptif,
    conducteurId: d.conducteurId,
    datePassage: isoDate(d.datePassage),
    statutConducteur: d.statutConducteur ? statutConducteur.label(d.statutConducteur) : null,
    statutADCI: statutADCI.label(d.statutADCI),
    validePar: d.validePar,
    relance: d.relance ? relanceDevis.label(d.relance) : null,
    commentaires: d.commentaires,
    montantHT: d.montantHT === null ? null : Number(d.montantHT),
    source: d.source === 'MAIL' ? ('Mail' as const) : ('Saisie' as const),
    resultat: resultatDevis.label(d.resultat),
    resultatLe: isoDate(d.resultatLe),
    motifRefus: d.motifRefus,
    resultatMailId: d.resultatMailId,
    valideParId: d.valideParId,
    valideLe: d.valideLe?.toISOString() ?? null,
    envoyeLe: isoDate(d.envoyeLe),
    suivi: (d.suivi ?? []).map(toSuiviDto),
  }
}
