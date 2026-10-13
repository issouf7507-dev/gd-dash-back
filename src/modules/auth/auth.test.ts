// Tests d'intégration sur la base gd_test (vraie base MySQL, pas de simulation).
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.ts'
import { Role } from '../../generated/prisma/client.ts'
import { hashPassword } from '../../lib/password.ts'
import { prisma } from '../../lib/prisma.ts'

// Garde-fou : ces tests vident la table des utilisateurs
if (!process.env.DATABASE_URL?.includes('/gd_test')) throw new Error('Les tests doivent tourner sur la base gd_test')

const app = createApp()
const PASSWORD = 'MotDePasse-Test-123'
const ids: Record<string, string> = {}

async function loginAs(email: string, password = PASSWORD) {
  const agent = request.agent(app)
  const res = await agent.post('/api/auth/login').send({ email, password })
  return { agent, res }
}

beforeAll(async () => {
  await prisma.utilisateur.deleteMany()
  const passwordHash = await hashPassword(PASSWORD)
  for (const [key, data] of Object.entries({
    admin: { prenom: 'Ada', nom: 'Admin', email: 'admin@test.local', role: Role.ADMIN, passwordHash },
    conducteur: { prenom: 'Coco', nom: 'Conduc', email: 'conducteur@test.local', role: Role.CONDUCTEUR, passwordHash },
    inactif: { prenom: 'Ina', nom: 'Actif', email: 'inactif@test.local', role: Role.ADCI, passwordHash, actif: false },
    sansMdp: { prenom: 'Sam', nom: 'SansMdp', email: 'sans-mdp@test.local', role: Role.ADCI },
  })) {
    ids[key] = (await prisma.utilisateur.create({ data })).id
  }
})

afterAll(() => prisma.$disconnect())

describe('POST /api/auth/login', () => {
  it('connecte avec les bons identifiants : cookie httpOnly + utilisateur sans hash', async () => {
    const { res } = await loginAs('ADMIN@test.local') // l'email est insensible à la casse
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ email: 'admin@test.local', role: 'Admin', aMotDePasse: true })
    expect(res.body.data).not.toHaveProperty('passwordHash')
    const cookie = String(res.headers['set-cookie'])
    expect(cookie).toMatch(/gd_session=/)
    expect(cookie).toMatch(/HttpOnly/i)
  })

  it.each([
    ['mauvais mot de passe', 'admin@test.local', 'Faux-mot-de-passe-1'],
    ['email inconnu', 'inconnu@test.local', PASSWORD],
    ['compte désactivé', 'inactif@test.local', PASSWORD],
    ['compte sans mot de passe', 'sans-mdp@test.local', PASSWORD],
  ])('refuse : %s, avec le même message', async (_cas, email, password) => {
    const { res } = await loginAs(email, password)
    expect(res.status).toBe(401)
    expect(res.body.error).toEqual({ message: 'Email ou mot de passe incorrect', code: 'UNAUTHENTICATED' })
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('valide le format', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: 'pas-un-email' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('GET /api/auth/me et déconnexion', () => {
  it('401 sans session ou avec un jeton falsifié', async () => {
    expect((await request(app).get('/api/auth/me')).status).toBe(401)
    const res = await request(app).get('/api/auth/me').set('Cookie', 'gd_session=jeton.falsifie.xyz')
    expect(res.status).toBe(401)
  })

  it('renvoie l’utilisateur connecté, puis 401 après déconnexion', async () => {
    const { agent } = await loginAs('conducteur@test.local')
    const me = await agent.get('/api/auth/me')
    expect(me.status).toBe(200)
    expect(me.body.data).toMatchObject({ email: 'conducteur@test.local', role: 'Conducteur de travaux' })
    await agent.post('/api/auth/logout').expect(200)
    expect((await agent.get('/api/auth/me')).status).toBe(401)
  })

  it('coupe immédiatement un compte désactivé, même avec une session ouverte', async () => {
    const { agent } = await loginAs('conducteur@test.local')
    await prisma.utilisateur.update({ where: { id: ids.conducteur }, data: { actif: false } })
    expect((await agent.get('/api/auth/me')).status).toBe(401)
    await prisma.utilisateur.update({ where: { id: ids.conducteur }, data: { actif: true } })
  })
})

describe('/api/utilisateurs (Admin uniquement)', () => {
  it('401 sans session, 403 pour un non-admin', async () => {
    expect((await request(app).get('/api/utilisateurs')).status).toBe(401)
    const { agent } = await loginAs('conducteur@test.local')
    const res = await agent.get('/api/utilisateurs')
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('FORBIDDEN')
  })

  it('annuaire ouvert à tout utilisateur connecté, sans données de compte', async () => {
    expect((await request(app).get('/api/utilisateurs/annuaire')).status).toBe(401)
    const { agent } = await loginAs('conducteur@test.local')
    const res = await agent.get('/api/utilisateurs/annuaire')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(4)
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['actif', 'email', 'id', 'nom', 'prenom', 'role'])
  })

  it('liste les utilisateurs sans exposer les hash', async () => {
    const { agent } = await loginAs('admin@test.local')
    const res = await agent.get('/api/utilisateurs')
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(4)
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/)
  })

  it('crée un utilisateur avec mot de passe initial, qui peut ensuite se connecter', async () => {
    const { agent } = await loginAs('admin@test.local')
    const res = await agent
      .post('/api/utilisateurs')
      .send({ prenom: 'Nouveau', email: 'Nouveau@Test.local', role: "Chargé d'affaires", motDePasse: 'Initial-Pass-2026' })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ email: 'nouveau@test.local', role: "Chargé d'affaires", aMotDePasse: true })
    expect((await loginAs('nouveau@test.local', 'Initial-Pass-2026')).res.status).toBe(200)
  })

  it('refuse un email déjà utilisé (409) et un mot de passe trop faible (400)', async () => {
    const { agent } = await loginAs('admin@test.local')
    const dup = await agent.post('/api/utilisateurs').send({ prenom: 'X', email: 'admin@test.local', role: 'ADCI' })
    expect(dup.status).toBe(409)
    const faible = await agent.post('/api/utilisateurs').send({ prenom: 'X', email: 'x@test.local', role: 'ADCI', motDePasse: 'court' })
    expect(faible.status).toBe(400)
  })

  it('modifie le rôle d’un utilisateur', async () => {
    const { agent } = await loginAs('admin@test.local')
    const res = await agent.patch(`/api/utilisateurs/${ids.sansMdp}`).send({ role: 'Direction' })
    expect(res.status).toBe(200)
    expect(res.body.data.role).toBe('Direction')
  })

  it('empêche un admin de se désactiver ou de perdre son rôle', async () => {
    const { agent } = await loginAs('admin@test.local')
    expect((await agent.patch(`/api/utilisateurs/${ids.admin}`).send({ actif: false })).status).toBe(403)
    expect((await agent.patch(`/api/utilisateurs/${ids.admin}`).send({ role: 'ADCI' })).status).toBe(403)
  })

  it('404 pour un utilisateur inexistant', async () => {
    const { agent } = await loginAs('admin@test.local')
    expect((await agent.patch('/api/utilisateurs/inexistant').send({ prenom: 'Y' })).status).toBe(404)
  })
})
