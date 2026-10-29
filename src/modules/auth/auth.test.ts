// Tests d'intégration sur la base gd_test (vraie base MySQL, pas de simulation).
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.ts'
import { env } from '../../config/env.ts'
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

describe('sessions coupées après un changement de mot de passe', () => {
  it('la session ouverte avant le changement est refusée, la nouvelle fonctionne', async () => {
    const { agent: conducteur } = await loginAs('conducteur@test.local')
    expect((await conducteur.get('/api/auth/me')).status).toBe(200)
    const { agent: admin } = await loginAs('admin@test.local')
    expect((await admin.patch(`/api/utilisateurs/${ids.conducteur}`).send({ motDePasse: 'Nouveau-Pass-2026' })).status).toBe(200)
    expect((await conducteur.get('/api/auth/me')).status).toBe(401)
    expect((await loginAs('conducteur@test.local', 'Nouveau-Pass-2026')).res.status).toBe(200)
  })

  it('l’admin qui change son propre mot de passe reste connecté', async () => {
    const { agent } = await loginAs('admin@test.local')
    expect((await agent.patch(`/api/utilisateurs/${ids.admin}`).send({ motDePasse: PASSWORD })).status).toBe(200)
    expect((await agent.get('/api/auth/me')).status).toBe(200)
  })
})

describe('invitation et mot de passe oublié', () => {
  const jetonDuLien = (lien: string) => new URL(lien).searchParams.get('jeton')!

  it('invitation sans envoi d’email : le lien est remis à l’admin, il sert une seule fois', async () => {
    const invite = await prisma.utilisateur.create({ data: { prenom: 'Ivan', nom: 'Invité', email: 'invite@test.local', role: Role.ADCI } })
    const { agent: admin } = await loginAs('admin@test.local')
    const res = await admin.post(`/api/utilisateurs/${invite.id}/inviter`)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ envoye: false, lien: expect.stringContaining('/definir-mot-de-passe?jeton=') })
    const jeton = jetonDuLien(res.body.data.lien)

    const anon = request.agent(app)
    expect((await anon.get(`/api/auth/jeton/${jeton}`)).body.data).toEqual({ type: 'invitation', prenom: 'Ivan', email: 'invite@test.local' })
    expect((await anon.post('/api/auth/definir-mot-de-passe').send({ jeton, motDePasse: 'court' })).status).toBe(400)
    const ok = await anon.post('/api/auth/definir-mot-de-passe').send({ jeton, motDePasse: 'Mon-Pass-Invite-1' })
    expect(ok.status).toBe(200)
    expect(ok.body.data).toMatchObject({ email: 'invite@test.local', aMotDePasse: true })
    expect((await anon.get('/api/auth/me')).status).toBe(200)
    // Lien déjà utilisé
    expect((await anon.get(`/api/auth/jeton/${jeton}`)).status).toBe(404)
    expect((await request(app).post('/api/auth/definir-mot-de-passe').send({ jeton, motDePasse: 'Autre-Pass-2026-x' })).status).toBe(404)
  })

  it('pas d’invitation pour un compte désactivé, ni pour un non-admin', async () => {
    const { agent: admin } = await loginAs('admin@test.local')
    expect((await admin.post(`/api/utilisateurs/${ids.inactif}/inviter`)).status).toBe(409)
    const { agent: conducteur } = await loginAs('conducteur@test.local', 'Nouveau-Pass-2026')
    expect((await conducteur.post(`/api/utilisateurs/${ids.sansMdp}/inviter`)).status).toBe(403)
  })

  it('mot de passe oublié : indisponible sans envoi d’email', async () => {
    expect((await request(app).get('/api/auth/mot-de-passe-oublie')).body.data).toEqual({ disponible: false })
    expect((await request(app).post('/api/auth/mot-de-passe-oublie').send({ email: 'admin@test.local' })).status).toBe(503)
  })

  it('mot de passe oublié : même réponse pour un email inconnu, lien envoyé sinon', async () => {
    const dossier = await mkdtemp(path.join(os.tmpdir(), 'gd-test-mdp-'))
    Object.assign(env, { ENVOI_MAIL: 'dossier', ENVOI_MAIL_DOSSIER: dossier })
    try {
      expect((await request(app).get('/api/auth/mot-de-passe-oublie')).body.data).toEqual({ disponible: true })
      const inconnu = await request(app).post('/api/auth/mot-de-passe-oublie').send({ email: 'personne@test.local' })
      expect(inconnu.status).toBe(200)
      expect(await readdir(dossier)).toHaveLength(0)

      const connu = await request(app).post('/api/auth/mot-de-passe-oublie').send({ email: 'invite@test.local' })
      expect(connu.body).toEqual(inconnu.body)
      const [fichier] = await readdir(dossier)
      const lien = (await readFile(path.join(dossier, fichier), 'utf8')).match(/http\S+/)![0]
      const anon = request.agent(app)
      expect((await anon.get(`/api/auth/jeton/${jetonDuLien(lien)}`)).body.data.type).toBe('reinitialisation')
      expect((await anon.post('/api/auth/definir-mot-de-passe').send({ jeton: jetonDuLien(lien), motDePasse: 'Reinit-Pass-2026' })).status).toBe(200)
      expect((await loginAs('invite@test.local', 'Reinit-Pass-2026')).res.status).toBe(200)
    } finally {
      Object.assign(env, { ENVOI_MAIL: 'off' })
    }
  })
})
