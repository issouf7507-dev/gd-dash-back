import { Prisma } from '../generated/prisma/client.ts'

/** Vrai si l'erreur Prisma est une violation de contrainte d'unicité (P2002). */
export const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'

/** Vrai si l'erreur Prisma vient d'une clé étrangère (P2003), ex. suppression d'un élément encore référencé. */
export const isForeignKeyViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003'
