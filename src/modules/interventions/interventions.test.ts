// Interventions : n° de devis (plateforme ou ADCI), équipe, heures, budget et validation, sur la base gd_test.
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.ts'
import { Categorie, Role, TypeClient, TypeIntervenant } from '../../generated/prisma/client.ts'
import { hashPassword } from '../../lib/password.ts'
import { prisma } from '../../lib/prisma.ts'

if (!process.env.DATABASE_URL?.includes('/gd_test')) throw new Error('Les tests doivent tourner sur la base gd_test')

const app = createApp()
const PASSWORD = 'MotDePasse-Test-123'
const ids: Record<string, string> = {}
let direction: ReturnType<typeof request.agent>
let adci: ReturnType<typeof request.agent>

const base = () => ({ numero: `INT-${Math.random().toString(36).slice(2, 8)}`, categorie: 'Couverture', clientId: ids.client, adresse: '1 rue de Paris' })

beforeAll(async () => {
  await prisma.notification.deleteMany()
  await prisma.importMail.deleteMany()
  await prisma.intervention.deleteMany()
  await prisma.devis.deleteMany()
  await prisma.intervenant.deleteMany()
  await prisma.client.deleteMany()
  await prisma.utilisateur.deleteMany()
  const passwordHash = await hashPassword(PASSWORD)
  ids.direction = (await prisma.utilisateur.create({ data: { prenom: 'Dir', nom: 'Ection', email: 'dir-int@test.local', role: Role.DIRECTION, passwordHash } })).id
  ids.adci = (await prisma.utilisateur.create({ data: { prenom: 'Kassa', nom: 'Adci', email: 'adci-int@test.local', role: Role.ADCI, passwordHash } })).id
  ids.client = (await prisma.client.create({ data: { nom: 'ATRIUM', type: TypeClient.SYNDIC } })).id
  ids.devis = (await prisma.devis.create({ data: { numero: 'DGD26-0100', clientId: ids.client, adresse: 'x', descriptif: '', commentaires: '', categorie: Categorie.COUVERTURE } })).id
  ids.chef = (await prisma.intervenant.create({ data: { nom: 'Chef', specialites: [] } })).id
  ids.aide = (await prisma.intervenant.create({ data: { nom: 'Aide', specialites: [] } })).id
  ids.st = (await prisma.intervenant.create({ data: { nom: 'Sous-traitant', type: TypeIntervenant.SOUS_TRAITANT, specialites: [] } })).id
  direction = request.agent(app)
  await direction.post('/api/auth/login').send({ email: 'dir-int@test.local', password: PASSWORD }).expect(200)
  adci = request.agent(app)
  await adci.post('/api/auth/login').send({ email: 'adci-int@test.local', password: PASSWORD }).expect(200)
})

afterAll(() => prisma.$disconnect())

describe('n° de devis', () => {
  it('un devis de la plateforme est relié ; un numéro inconnu est refusé sans la case ADCI', async () => {
    const i = (await adci.post('/api/interventions').send({ ...base(), numeroDevis: 'DGD26-0100' }).expect(201)).body.data
    expect(i).toMatchObject({ numeroDevis: 'DGD26-0100', devisADCI: false })
    expect((await prisma.intervention.findUniqueOrThrow({ where: { id: i.id } })).devisId).toBe(ids.devis)

    const r = await adci.post('/api/interventions').send({ ...base(), numeroDevis: 'ADCI-77' })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toMatch(/ADCI/)
  })

  it('numéro saisi venant d’ADCI : accepté et marqué ADCI', async () => {
    const i = (await adci.post('/api/interventions').send({ ...base(), numeroDevis: 'ADCI-77', devisADCI: true }).expect(201)).body.data
    expect(i).toMatchObject({ numeroDevis: 'ADCI-77', devisADCI: true })
  })
})

describe('équipe, heures, budget et validation', () => {
  it('créée par l’ADCI : à valider, la Direction est prévenue ; équipe sans le responsable', async () => {
    const i = (
      await adci
        .post('/api/interventions')
        .send({ ...base(), technicienId: ids.chef, equipeIds: [ids.aide, ids.st, ids.chef], heuresPrevues: 16, budgetAlloue: 2500 })
        .expect(201)
    ).body.data
    ids.int = i.id
    expect(i).toMatchObject({ technicienId: ids.chef, heuresPrevues: 16, budgetAlloue: 2500, validation: 'À valider', valideParId: null })
    expect([...i.equipeIds].sort()).toEqual([ids.aide, ids.st].sort())
    const notif = await prisma.notification.findFirst({ where: { utilisateurId: ids.direction, type: 'validation-intervention', lien: `/interventions/${i.id}` } })
    expect(notif?.titre).toMatch(/à valider/)
  })

  it('seules la Direction et l’Admin valident ; un refus demande un motif', async () => {
    expect((await adci.post(`/api/interventions/${ids.int}/validation`).send({ decision: 'Validée' })).status).toBe(403)
    expect((await direction.post(`/api/interventions/${ids.int}/validation`).send({ decision: 'Refusée' })).status).toBe(400)
    const v = (await direction.post(`/api/interventions/${ids.int}/validation`).send({ decision: 'Validée' }).expect(200)).body.data
    expect(v).toMatchObject({ validation: 'Validée', valideParId: ids.direction })
  })

  it('budget changé par l’ADCI : à valider de nouveau ; commentaire changé : reste validée', async () => {
    const r1 = (await adci.patch(`/api/interventions/${ids.int}`).send({ commentaires: 'Accès par la cour' }).expect(200)).body.data
    expect(r1.validation).toBe('Validée')
    const r2 = (await adci.patch(`/api/interventions/${ids.int}`).send({ budgetAlloue: 3000 }).expect(200)).body.data
    expect(r2).toMatchObject({ validation: 'À valider', valideParId: null, budgetAlloue: 3000 })
  })

  it('créée ou modifiée par la Direction : validée d’office', async () => {
    const i = (await direction.post('/api/interventions').send({ ...base(), heuresPrevues: 8 }).expect(201)).body.data
    expect(i).toMatchObject({ validation: 'Validée', valideParId: ids.direction })
  })
})
