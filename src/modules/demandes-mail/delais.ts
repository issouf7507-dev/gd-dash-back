// Délais de traitement des demandes reçues, comptés en jours ouvrés (samedi et dimanche ne comptent pas).
import { StatutDemande, type Prisma } from '../../generated/prisma/client.ts'
import { env } from '../../config/env.ts'

const JOUR = 86_400_000
const weekEnd = (t: number) => {
  const j = new Date(t).getUTCDay()
  return j === 0 || j === 6
}

/** Temps ouvré écoulé entre deux instants, en jours (décimaux). */
export function joursOuvres(debut: Date, fin: Date) {
  let total = 0
  for (let t = debut.getTime(); t < fin.getTime(); ) {
    const suivant = Math.min((Math.floor(t / JOUR) + 1) * JOUR, fin.getTime())
    if (!weekEnd(t)) total += suivant - t
    t = suivant
  }
  return total / JOUR
}

/** Instant situé `jours` jours ouvrés avant `maintenant` : une demande reçue avant est en retard. */
export function limiteRetard(maintenant = new Date(), jours = env.DEMANDES_DELAI_JOURS) {
  let t = maintenant.getTime()
  let reste = jours
  while (reste > 1e-9) {
    // Recule jusqu'au début du jour (ou d'un jour entier), en ne décomptant que les jours de semaine
    const debutJour = Math.floor((t - 1) / JOUR) * JOUR
    const pas = Math.min(t - debutJour, reste * JOUR)
    if (!weekEnd(t - 1)) reste -= pas / JOUR
    t -= weekEnd(t - 1) ? t - debutJour : pas
  }
  return new Date(t)
}

/** Demandes suivies : les demandes de devis des clients et toutes les demandes affectées à quelqu'un. */
export const SUIVIES: Prisma.DemandeMailWhereInput = { OR: [{ donnees: { path: '$.demandeDevis', equals: true } }, { affecteAId: { not: null } }] }

/** Demandes suivies encore à traiter au-delà du délai attendu. */
export const enRetard = (maintenant = new Date()): Prisma.DemandeMailWhereInput => ({
  AND: [SUIVIES, { statut: StatutDemande.A_TRAITER, recuLe: { lt: limiteRetard(maintenant) } }],
})

/** Arrondi au dixième de jour, pour l'affichage. */
export const arrondi = (jours: number) => Math.round(jours * 10) / 10
