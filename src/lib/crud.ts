import { Prisma } from '../generated/prisma/client.ts'
import { ConflictError, ValidationError } from './app-error.ts'
import { isUniqueViolation } from './prisma-errors.ts'

/** Montant en euros (Decimal Prisma → number), null conservé. */
export const montant = (d: Prisma.Decimal | null) => (d === null ? null : Number(d))

/** Retire les clés `undefined` (champs absents d'un PATCH) pour ne mettre à jour que ce qui est envoyé. */
export const defini = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

/**
 * Traduit les erreurs Prisma d'une écriture : numéro déjà pris (409),
 * ou référence vers un élément inexistant (client, chantier… : 400 sur le champ concerné).
 */
export function erreurEcriture(numeroPris: string, champ: string, introuvable: string) {
  return (err: unknown): never => {
    if (isUniqueViolation(err)) throw new ConflictError(numeroPris)
    if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2003' || err.code === 'P2025')) {
      throw new ValidationError({ body: { fieldErrors: { [champ]: [introuvable] } } })
    }
    throw err
  }
}
