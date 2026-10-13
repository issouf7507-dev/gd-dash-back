import { CATEGORIES, PLANIFICATIONS, RELANCES_DEVIS, STATUTS_ADCI, STATUTS_CONDUCTEUR } from '@gd/shared/types'
import { z } from 'zod'
import type { Prisma } from '../../generated/prisma/client.ts'
import { categorie, planification, relanceDevis, statutADCI, statutConducteur } from '../../lib/labels.ts'

const date = z.iso.date().nullable()
const texte = (max: number) => z.string().trim().max(max)

/** Champs d'un devis tels que le front les envoie (libellés). */
export const devisSchema = z.object({
  numero: texte(50).min(1, 'Le numéro est obligatoire'),
  dateReception: date.default(null),
  planification: z.enum(PLANIFICATIONS).default('À planifier'),
  categorie: z.enum(CATEGORIES),
  clientId: z.string().min(1, 'Le client est obligatoire'),
  adresse: texte(500).min(1, 'L’adresse est obligatoire'),
  descriptif: texte(10_000).default(''),
  conducteurId: z.string().min(1).nullable().default(null),
  datePassage: date.default(null),
  statutConducteur: z.enum(STATUTS_CONDUCTEUR).nullable().default(null),
  statutADCI: z.enum(STATUTS_ADCI).default('Non traité'),
  validePar: texte(100).nullable().default(null),
  relance: z.enum(RELANCES_DEVIS).nullable().default(null),
  commentaires: texte(10_000).default(''),
  montantHT: z.number().nonnegative().max(9_999_999_999).nullable().default(null),
})
export type DevisInput = z.infer<typeof devisSchema>

const toDate = (d: string | null | undefined) => (d === undefined ? undefined : d === null ? null : new Date(`${d}T00:00:00Z`))

/** Libellés → valeurs Prisma (n'inclut que les champs présents, pour PATCH). */
export function toDevisData(input: Partial<DevisInput>, creation = false) {
  const { clientId, conducteurId, ...v } = input
  return {
    ...(v.numero !== undefined && { numero: v.numero }),
    ...(v.dateReception !== undefined && { dateReception: toDate(v.dateReception) }),
    ...(v.planification !== undefined && { planification: planification.key(v.planification) }),
    ...(v.categorie !== undefined && { categorie: categorie.key(v.categorie) }),
    ...(clientId !== undefined && { client: { connect: { id: clientId } } }),
    ...(v.adresse !== undefined && { adresse: v.adresse }),
    ...(v.descriptif !== undefined && { descriptif: v.descriptif }),
    ...(conducteurId !== undefined && { conducteur: conducteurId ? { connect: { id: conducteurId } } : creation ? undefined : { disconnect: true } }),
    ...(v.datePassage !== undefined && { datePassage: toDate(v.datePassage) }),
    ...(v.statutConducteur !== undefined && { statutConducteur: v.statutConducteur && statutConducteur.key(v.statutConducteur) }),
    ...(v.statutADCI !== undefined && { statutADCI: statutADCI.key(v.statutADCI) }),
    ...(v.validePar !== undefined && { validePar: v.validePar }),
    ...(v.relance !== undefined && { relance: v.relance && relanceDevis.key(v.relance) }),
    ...(v.commentaires !== undefined && { commentaires: v.commentaires }),
    ...(v.montantHT !== undefined && { montantHT: v.montantHT }),
  } satisfies Prisma.DevisUpdateInput
}

/** Données Prisma d'un nouveau devis (toutes les valeurs par défaut du schéma appliquées). */
export const toDevisCreate = (input: DevisInput) => toDevisData(input, true) as Prisma.DevisCreateInput
