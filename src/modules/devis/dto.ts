import type { Devis } from '../../generated/prisma/client.ts'
import { categorie, planification, relanceDevis, statutADCI, statutConducteur } from '../../lib/labels.ts'

const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

/** Devis au format du front (@gd/shared/types), avec les champs ajoutés par l'import mail. */
export function toDevisDto(d: Devis) {
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
  }
}
