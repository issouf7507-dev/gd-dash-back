// Dates « jour » (colonnes @db.Date) : échangées avec le front au format ISO `YYYY-MM-DD`.

export const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null)

/** `YYYY-MM-DD` → Date à minuit UTC ; undefined reste undefined (champ absent d'un PATCH). */
export const toDate = (d: string | null | undefined) => (d === undefined ? undefined : d === null ? null : new Date(`${d}T00:00:00Z`))
