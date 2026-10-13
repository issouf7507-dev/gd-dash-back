import type { Response } from 'express'

export interface ListMeta {
  page: number
  pageSize: number
  total: number
}

/** Réponse succès uniforme : `{ data }` ou `{ data, meta }` pour les listes. */
export function ok<T>(res: Response, data: T, options: { status?: number; meta?: ListMeta } = {}) {
  return res.status(options.status ?? 200).json(options.meta ? { data, meta: options.meta } : { data })
}
