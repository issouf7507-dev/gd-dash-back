// Liens à usage unique (invitation, mot de passe oublié) : le jeton part dans l'email, seul son hash est en base.
import { createHash, randomBytes } from 'node:crypto'
import { env } from '../config/env.ts'
import type { TypeJeton } from '../generated/prisma/client.ts'
import { prisma } from './prisma.ts'

export const DUREE_JETON_MS: Record<TypeJeton, number> = {
  INVITATION: 7 * 86_400_000,
  REINITIALISATION: 3_600_000,
}

/** Lien envoyé par email, vers la page du front qui définit le mot de passe. */
export const lienMotDePasse = (jeton: string) => `${env.APP_URL}/definir-mot-de-passe?jeton=${jeton}`

const hacher = (jeton: string) => createHash('sha256').update(jeton).digest('hex')

/** Crée un jeton (et annule les précédents non utilisés du même type pour cet utilisateur). Renvoie le jeton en clair. */
export async function creerJeton(utilisateurId: string, type: TypeJeton) {
  const jeton = randomBytes(32).toString('base64url')
  await prisma.$transaction([
    prisma.jetonAuth.deleteMany({ where: { utilisateurId, type, usedAt: null } }),
    prisma.jetonAuth.create({ data: { utilisateurId, type, tokenHash: hacher(jeton), expiresAt: new Date(Date.now() + DUREE_JETON_MS[type]) } }),
  ])
  return jeton
}

/** Jeton valide (ni utilisé, ni expiré, compte actif), avec son utilisateur ; sinon null. */
export async function lireJeton(jeton: string) {
  const j = await prisma.jetonAuth.findUnique({ where: { tokenHash: hacher(jeton) }, include: { utilisateur: true } })
  if (!j || j.usedAt || j.expiresAt < new Date() || !j.utilisateur.actif) return null
  return j
}

/** Marque le jeton comme utilisé ; false s'il l'a déjà été entre-temps (deux clics simultanés). */
export async function consommerJeton(id: string) {
  const { count } = await prisma.jetonAuth.updateMany({ where: { id, usedAt: null }, data: { usedAt: new Date() } })
  return count === 1
}
