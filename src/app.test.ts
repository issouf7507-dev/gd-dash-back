import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

// La base n'est pas nécessaire pour ces tests : on simule le client Prisma
// Fonction simple plutôt que vi.fn : avec vi.fn, la promesse rejetée remontait comme erreur du test.
let queryRaw: () => Promise<unknown> = () => Promise.resolve([])
vi.mock('./lib/prisma.ts', () => ({ prisma: { $queryRaw: () => queryRaw() } }))

const { createApp } = await import('./app.ts')
const { errorHandler } = await import('./middleware/error-handler.ts')
const { validate } = await import('./middleware/validate.ts')
const { ConflictError } = await import('./lib/app-error.ts')

describe('GET /api/health', () => {
  it('répond ok quand MySQL répond', async () => {
    queryRaw = () => Promise.resolve([{ 1: 1 }])
    const res = await request(createApp()).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'ok', db: 'ok' })
  })

  it('répond 503 au format d’erreur standard quand MySQL est injoignable', async () => {
    queryRaw = () => Promise.reject(new Error('ECONNREFUSED'))
    const res = await request(createApp()).get('/api/health')
    expect(res.status).toBe(503)
    expect(res.body).toEqual({ error: { message: 'Base de données injoignable', code: 'SERVICE_UNAVAILABLE' } })
  })
})

describe('gestion des erreurs', () => {
  it('route inconnue → 404 NOT_FOUND', async () => {
    const res = await request(createApp()).get('/api/inconnue')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it('JSON mal formé → 400 VALIDATION_ERROR', async () => {
    const res = await request(createApp()).post('/api/health').set('content-type', 'application/json').send('{oups')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('AppError levée dans une route async → bon code HTTP', async () => {
    const app = express()
    app.get('/x', async () => {
      throw new ConflictError('Numéro déjà utilisé')
    })
    app.use(errorHandler)
    const res = await request(app).get('/x')
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: { message: 'Numéro déjà utilisé', code: 'CONFLICT' } })
  })

  it('erreur inattendue → 500 sans fuite du message interne', async () => {
    const app = express()
    app.get('/x', () => {
      throw new Error('secret interne')
    })
    app.use(errorHandler)
    const res = await request(app).get('/x')
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: { message: 'Erreur interne', code: 'INTERNAL_ERROR' } })
  })
})

describe('middleware validate', () => {
  const app = express()
  app.use(express.json())
  app.post(
    '/items/:id',
    validate({
      params: z.object({ id: z.string().min(3) }),
      query: z.object({ page: z.coerce.number().int().min(1).default(1) }),
      body: z.object({ nom: z.string().min(1) }),
    }),
    (_req, res) => {
      res.json({ data: res.locals })
    },
  )
  app.use(errorHandler)

  it('transmet les valeurs nettoyées (coercition, défauts)', async () => {
    const res = await request(app).post('/items/abc?page=2').send({ nom: 'Toit' })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ params: { id: 'abc' }, query: { page: 2 }, body: { nom: 'Toit' } })
  })

  it('refuse les entrées invalides avec le détail par partie', async () => {
    const res = await request(app).post('/items/a?page=0').send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
    expect(Object.keys(res.body.error.details).sort()).toEqual(['body', 'params', 'query'])
  })
})
