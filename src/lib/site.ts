// Site d'intervention (devis, interventions, chantiers) : adresse découpée et position, en plus du champ « adresse ».
import { z } from 'zod'

const texte = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => s || null)
    .nullable()
    .optional()

/** Champs facultatifs : absents d'un PATCH, ils ne sont pas modifiés. */
export const siteSchema = {
  codePostal: texte(10),
  ville: texte(100),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
}

export const siteDto = (x: { codePostal: string | null; ville: string | null; latitude: number | null; longitude: number | null }) => ({
  codePostal: x.codePostal,
  ville: x.ville,
  latitude: x.latitude,
  longitude: x.longitude,
})
