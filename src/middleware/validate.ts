import type { NextFunction, Request, Response } from 'express'
import { z, type ZodType } from 'zod'
import { ValidationError } from '../lib/app-error.ts'

interface Schemas {
  body?: ZodType
  query?: ZodType
  params?: ZodType
}

/**
 * Valide body / query / params avec Zod. Les valeurs nettoyées (coercition, valeurs par défaut)
 * sont disponibles dans `res.locals.body`, `res.locals.query` et `res.locals.params`
 * (en Express 5, `req.query` est en lecture seule).
 */
export function validate(schemas: Schemas) {
  return (req: Request, res: Response, next: NextFunction) => {
    const errors: Record<string, unknown> = {}
    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part]
      if (!schema) continue
      const result = schema.safeParse(req[part] ?? {})
      if (result.success) res.locals[part] = result.data
      else errors[part] = z.flattenError(result.error)
    }
    if (Object.keys(errors).length) return next(new ValidationError(errors))
    next()
  }
}
