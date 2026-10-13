import type { Utilisateur } from '../../generated/prisma/client.ts'
import { roleLabel } from '../../lib/labels.ts'

/** Représentation publique d'un utilisateur (jamais le hash du mot de passe). */
export function toUtilisateurDto(u: Utilisateur) {
  return {
    id: u.id,
    prenom: u.prenom,
    nom: u.nom,
    email: u.email,
    role: roleLabel(u.role),
    actif: u.actif,
    aMotDePasse: u.passwordHash !== null,
  }
}
