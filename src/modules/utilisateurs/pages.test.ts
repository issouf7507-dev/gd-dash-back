// Pages ouvertes à chaque compte : celles du rôle par défaut, ou celles cochées par l'Admin. Base gd_test.
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.ts'
import { Role } from '../../generated/prisma/client.ts'
import { hashPassword } from '../../lib/password.ts'
import { prisma } from '../../lib/prisma.ts'

if (!process.env.DATABASE_URL?.includes('/gd_test')) throw new Error('Les tests doivent tourner sur la base gd_test')

const app = createApp()
const PASSWORD = 'MotDePasse-Test-123'
let admin: ReturnType<typeof request.agent>
const ids: Record<string, string> = {}

async function connecter(email: string) {
  const agent = request.agent(app)
  await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)
  return agent
}

beforeAll(async () => {
  await prisma.utilisateur.deleteMany({ where: { email: { endsWith: '@pages.test' } } })
  const passwordHash = await hashPassword(PASSWORD)
  await prisma.utilisateur.create({ data: { prenom: 'Ada', nom: 'Admin', email: 'admin@pages.test', role: Role.ADMIN, passwordHash } })
  ids.conducteur = (await prisma.utilisateur.create({ data: { prenom: 'Nuno', nom: 'Cond', email: 'conducteur@pages.test', role: Role.CONDUCTEUR, passwordHash } })).id
  ids.adci = (await prisma.utilisateur.create({ data: { prenom: 'Kassa', nom: 'Adci', email: 'adci@pages.test', role: Role.ADCI, passwordHash } })).id
  admin = await connecter('admin@pages.test')
})

afterAll(() => prisma.$disconnect())

describe('pages par compte', () => {
  it('par défaut : celles du rôle (gestion fermée au conducteur, demandes ouvertes à l’ADCI)', async () => {
    const conducteur = await connecter('conducteur@pages.test')
    expect((await conducteur.get('/api/auth/me').expect(200)).body.data.pages).toBeNull()
    expect((await conducteur.get('/api/gestion/exercices')).status).toBe(403)
    expect((await conducteur.get('/api/imports-devis')).status).toBe(403)
    const adci = await connecter('adci@pages.test')
    expect((await adci.get('/api/imports-devis')).status).not.toBe(403)
  })

  it('page cochée en plus : la gestion s’ouvre au conducteur', async () => {
    const maj = await admin.patch(`/api/utilisateurs/${ids.conducteur}`).send({ pages: ['devis', 'interventions', 'gestion'] }).expect(200)
    expect(maj.body.data.pages).toEqual(['devis', 'interventions', 'gestion'])
    const conducteur = await connecter('conducteur@pages.test')
    expect((await conducteur.get('/api/gestion/exercices')).status).toBe(200)
  })

  it('page retirée : l’ADCI perd les imports et la gestion complète des demandes', async () => {
    await admin.patch(`/api/utilisateurs/${ids.adci}`).send({ pages: ['devis', 'interventions'] }).expect(200)
    const adci = await connecter('adci@pages.test')
    expect((await adci.get('/api/imports-devis')).status).toBe(403)
    expect((await adci.post('/api/demandes-devis/relever')).status).toBe(403)
  })

  it('exactement les pages du rôle, ou null : rien de personnalisé', async () => {
    const r = await admin
      .patch(`/api/utilisateurs/${ids.conducteur}`)
      .send({ pages: ['devis', 'interventions', 'chantiers', 'factures', 'planning', 'clients', 'fournisseurs', 'techniciens'] })
      .expect(200)
    expect(r.body.data.pages).toBeNull()
    await admin.patch(`/api/utilisateurs/${ids.adci}`).send({ pages: null }).expect(200)
    expect((await prisma.utilisateur.findUniqueOrThrow({ where: { id: ids.adci } })).pages).toBeNull()
    expect((await admin.patch(`/api/utilisateurs/${ids.adci}`).send({ pages: ['inconnue'] })).status).toBe(400)
  })
})
