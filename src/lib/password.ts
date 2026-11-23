import { randomInt } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'

export const hashPassword = (password: string) => hash(password)

// Hash factice : on vérifie quand même un mot de passe quand l'email est inconnu,
// pour que le temps de réponse ne révèle pas si un compte existe.
let dummyHash: Promise<string> | undefined

export async function verifyPassword(hashValue: string | null | undefined, password: string): Promise<boolean> {
  if (!hashValue) {
    dummyHash ??= hash('mot-de-passe-factice')
    await verify(await dummyHash, password).catch(() => false)
    return false
  }
  return verify(hashValue, password).catch(() => false)
}

/** Règle de mot de passe : 12 caractères min., avec majuscule, minuscule et chiffre. */
export const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{12,128}$/
export const PASSWORD_RULE_MESSAGE = '12 caractères minimum, avec au moins une majuscule, une minuscule et un chiffre'

// Sans caractères ambigus (0/O, 1/l/I) : le mot de passe provisoire est recopié depuis un email
const ALPHABET_PROVISOIRE = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'

/** Mot de passe provisoire lisible, ex. « Kp7d-Xm9q-Tr4w » : 12 caractères tirés au hasard, conforme à PASSWORD_RULE. */
export function motDePasseProvisoire(): string {
  for (;;) {
    // randomInt : tirage uniforme (pas de biais de modulo)
    const car = Array.from({ length: 12 }, () => ALPHABET_PROVISOIRE[randomInt(ALPHABET_PROVISOIRE.length)])
    const mdp = [0, 4, 8].map((i) => car.slice(i, i + 4).join('')).join('-')
    if (PASSWORD_RULE.test(mdp)) return mdp
  }
}
