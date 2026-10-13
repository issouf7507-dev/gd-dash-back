import type { Utilisateur } from '../generated/prisma/client.ts'

declare global {
  namespace Express {
    interface Locals {
      /** Utilisateur connecté, renseigné par requireAuth */
      user?: Utilisateur
    }
  }
}

export {}
