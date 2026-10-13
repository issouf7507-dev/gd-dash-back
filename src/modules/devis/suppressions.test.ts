// Suppressions (devis, clients, utilisateurs) sur la base gd_test.
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.ts'
import { Categorie, Role, TypeClient } from '../../generated/prisma/client.ts'
import { hashPassword } from '../../lib/password.ts'
import { prisma } from '../../lib/prisma.ts'

if (!process.env.DATABASE_URL?.includes('/gd_test')) throw new Error('Les tests doivent tourner sur la base gd_test')

const app = createApp()
const PASSWORD = 'MotDePasse-Test-123'
const ids: Record<string, string> = {}
let admin: ReturnType<typeof request.agent>
let direction: ReturnType<typeof request.agent>
let adci: ReturnType<typeof request.agent>

async function connecter(email: string) {
  const agent = request.agent(app)
  await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)
  return agent
}

const devis = (numero: string, clientId: string, conducteurId: string | null = null) =>
  prisma.devis.create({ data: { numero, clientId, conducteurId, adresse: 'Paris', descriptif: '', commentaires: '', categorie: Categorie.COUVERTURE } })

beforeAll(async () => {
  await prisma.importMail.deleteMany()
  await prisma.intervention.deleteMany()
  await prisma.devis.deleteMany()
  await prisma.client.deleteMany()
  await prisma.utilisateur.deleteMany()
  const passwordHash = await hashPassword(PASSWORD)
  for (const [key, data] of Object.entries({
    admin: { prenom: 'Ada', nom: 'Admin', email: 'admin@test.local', role: Role.ADMIN, passwordHash },
    direction: { prenom: 'Dir', nom: 'Ection', email: 'direction@test.local', role: Role.DIRECTION, passwordHash },
    adci: { prenom: 'Kassa', nom: 'ADCI', email: 'adci@test.local', role: Role.ADCI, passwordHash },
    conducteur: { prenom: 'Nuno', nom: 'BRANCO', email: 'conducteur@test.local', role: Role.CONDUCTEUR },
    libre: { prenom: 'Libre', nom: 'Sans', email: 'libre@test.local', role: Role.CONDUCTEUR },
  })) {
    ids[key] = (await prisma.utilisateur.create({ data })).id
  }
  ids.clientAvecDevis = (await prisma.client.create({ data: { nom: 'ATRIUM GESTION', type: TypeClient.SYNDIC } })).id
  ids.clientLibre = (await prisma.client.create({ data: { nom: 'CLIENT SANS DEVIS', type: TypeClient.SYNDIC } })).id
  ids.d1 = (await devis('DGD26-0001', ids.clientAvecDevis, ids.conducteur)).id
  ids.d2 = (await devis('DGD26-0002', ids.clientAvecDevis)).id
  ids.d3 = (await devis('DGD26-0003', ids.clientAvecDevis)).id
  admin = await connecter('admin@test.local')
  direction = await connecter('direction@test.local')
  adci = await connecter('adci@test.local')
})

afterAll(() => prisma.$disconnect())

describe('suppression groupée de devis', () => {
  it('403 pour un rôle non autorisé, 400 sans ids', async () => {
    expect((await adci.post('/api/devis/supprimer').send({ ids: [ids.d2] })).status).toBe(403)
    expect((await direction.post('/api/devis/supprimer').send({ ids: [] })).status).toBe(400)
  })

  it('supprime la sélection (ids inconnus ignorés)', async () => {
    const res = await direction.post('/api/devis/supprimer').send({ ids: [ids.d2, ids.d3, 'inconnu'] })
    expect(res.status).toBe(200)
    expect(res.body.data.count).toBe(2)
    expect(await prisma.devis.count()).toBe(1)
  })
})

describe('suppression de clients', () => {
  it('403 pour un rôle non autorisé, 404 si inexistant', async () => {
    expect((await adci.delete(`/api/clients/${ids.clientLibre}`)).status).toBe(403)
    expect((await direction.delete('/api/clients/inconnu')).status).toBe(404)
  })

  it('refuse un client qui a des devis (409)', async () => {
    const res = await direction.delete(`/api/clients/${ids.clientAvecDevis}`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('CONFLICT')
  })

  it('supprime un client sans historique', async () => {
    expect((await direction.delete(`/api/clients/${ids.clientLibre}`)).status).toBe(200)
    expect(await prisma.client.findUnique({ where: { id: ids.clientLibre } })).toBeNull()
  })
})

describe('suppression d’utilisateurs', () => {
  it('réservée aux admins', async () => {
    expect((await direction.delete(`/api/utilisateurs/${ids.libre}`)).status).toBe(403)
  })

  it('refuse sa propre suppression et un conducteur qui a des devis', async () => {
    expect((await admin.delete(`/api/utilisateurs/${ids.admin}`)).status).toBe(403)
    expect((await admin.delete(`/api/utilisateurs/${ids.conducteur}`)).status).toBe(409)
  })

  it('supprime un utilisateur sans historique', async () => {
    expect((await admin.delete(`/api/utilisateurs/${ids.libre}`)).status).toBe(200)
    expect((await admin.delete(`/api/utilisateurs/${ids.libre}`)).status).toBe(404)
  })
})
