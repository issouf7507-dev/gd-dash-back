import { Prisma } from '../generated/prisma/client.ts'

/** Vrai si l'erreur Prisma est une violation de contrainte d'unicité (P2002). */
export const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
