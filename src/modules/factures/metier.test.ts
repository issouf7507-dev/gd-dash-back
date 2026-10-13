// Intervenants, interventions, chantiers (+ journal) et factures (+ règlements, relances) sur la base gd_test.
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
let direction: ReturnType<typeof request.agent>
let conducteur: ReturnType<typeof request.agent>
let adci: ReturnType<typeof request.agent>

async function connecter(email: string) {
  const agent = request.agent(app)
  await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)
  return agent
}

async function vider() {
  await prisma.facture.deleteMany()
  await prisma.chantier.deleteMany()
  await prisma.intervention.deleteMany()
  await prisma.intervenant.deleteMany()
  await prisma.importMail.deleteMany()
  await prisma.devis.deleteMany()
  await prisma.client.deleteMany()
  await prisma.utilisateur.deleteMany()
}

beforeAll(async () => {
  await vider()
  const passwordHash = await hashPassword(PASSWORD)
  for (const [key, data] of Object.entries({
    direction: { prenom: 'Dir', nom: 'Ection', email: 'direction@test.local', role: Role.DIRECTION, passwordHash },
    conducteur: { prenom: 'Nuno', nom: 'BRANCO', email: 'conducteur@test.local', role: Role.CONDUCTEUR, passwordHash },
    adci: { prenom: 'Kassa', nom: '', email: 'adci@test.local', role: Role.ADCI, passwordHash },
  })) {
    ids[key] = (await prisma.utilisateur.create({ data })).id
  }
  ids.client = (await prisma.client.create({ data: { nom: 'ATRIUM GESTION', type: TypeClient.SYNDIC } })).id
  ids.devis = (
    await prisma.devis.create({
      data: { numero: 'DGD26-0001', clientId: ids.client, adresse: 'Paris', descriptif: '', commentaires: '', categorie: Categorie.COUVERTURE },
    })
  ).id
  direction = await connecter('direction@test.local')
  conducteur = await connecter('conducteur@test.local')
  adci = await connecter('adci@test.local')
})

afterAll(async () => {
  await vider()
  await prisma.$disconnect()
})

describe('intervenants', () => {
  it('création, modification et lecture', async () => {
    const res = await direction.post('/api/intervenants').send({ nom: 'Pedro', specialites: ['Couverture', 'Plomberie'] })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ nom: 'Pedro', type: 'Interne', specialites: ['Couverture', 'Plomberie'], actif: true })
    ids.tech = res.body.data.id
    expect((await direction.patch(`/api/intervenants/${ids.tech}`).send({ type: 'Sous-traitant' })).body.data.type).toBe('Sous-traitant')
    expect((await adci.get('/api/intervenants')).body.data).toHaveLength(1)
  })

  it('réservé à la direction en écriture, nom unique', async () => {
    expect((await adci.post('/api/intervenants').send({ nom: 'Autre' })).status).toBe(403)
    expect((await direction.post('/api/intervenants').send({ nom: 'Pedro' })).status).toBe(409)
  })
})

describe('interventions', () => {
  it('relie le n° de devis saisi au devis existant', async () => {
    const res = await conducteur.post('/api/interventions').send({
      numero: 'INT26-0001',
      categorie: 'Plomberie',
      clientId: ids.client,
      adresse: '12 rue de Paris',
      technicienId: ids.tech,
      datePassage: '2026-10-14',
      numeroDevis: 'DGD26-0001',
    })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ numero: 'INT26-0001', datePassage: '2026-10-14', statutADCI: 'Non traité', numeroDevis: 'DGD26-0001' })
    ids.intervention = res.body.data.id
    expect((await prisma.intervention.findUnique({ where: { id: ids.intervention } }))?.devisId).toBe(ids.devis)
  })

  it('refuse un client inconnu (400) et un numéro déjà pris (409)', async () => {
    const base = { categorie: 'Couverture', adresse: 'Paris' }
    expect((await direction.post('/api/interventions').send({ ...base, numero: 'INT26-0002', clientId: 'inconnu' })).status).toBe(400)
    expect((await direction.post('/api/interventions').send({ ...base, numero: 'INT26-0001', clientId: ids.client })).status).toBe(409)
  })

  it('un technicien affecté ne peut pas être supprimé', async () => {
    expect((await direction.delete(`/api/intervenants/${ids.tech}`)).status).toBe(409)
  })

  it('la suppression est persistée', async () => {
    expect((await conducteur.delete(`/api/interventions/${ids.intervention}`)).status).toBe(403)
    expect((await direction.post('/api/interventions/supprimer').send({ ids: [ids.intervention] })).body.data.count).toBe(1)
    expect((await direction.get('/api/interventions')).body.data).toHaveLength(0)
    expect((await direction.delete(`/api/intervenants/${ids.tech}`)).status).toBe(200)
  })
})

describe('chantiers et journal', () => {
  it('création avec montants et devis multiples', async () => {
    const res = await direction.post('/api/chantiers').send({
      numero: 'CHT26-0001',
      devisNumeros: ['DGD26-0506/1', 'DGD26-0507'],
      adresse: '3 avenue Foch',
      clientId: ids.client,
      categorie: 'Étanchéité',
      montantMarcheHT: 125000.5,
      dateDebut: '2026-11-02',
    })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ devisNumeros: ['DGD26-0506/1', 'DGD26-0507'], montantMarcheHT: 125000.5, statut: 'À venir', dateDebut: '2026-11-02' })
    ids.chantier = res.body.data.id
  })

  it('le conducteur tient le journal mais ne modifie pas le chantier', async () => {
    expect((await conducteur.patch(`/api/chantiers/${ids.chantier}`).send({ statut: 'En cours' })).status).toBe(403)
    const res = await conducteur.post(`/api/chantiers/${ids.chantier}/observations`).send({ date: '2026-11-03', texte: 'Échafaudage monté' })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ chantierId: ids.chantier, date: '2026-11-03', auteur: 'Nuno BRANCO' })
    expect((await adci.get('/api/observations')).body.data).toHaveLength(1)
  })
})

describe('factures, règlements et relances', () => {
  it('création puis règlement', async () => {
    const res = await adci.post('/api/factures').send({ numero: 'FGD26-00001', chantierId: ids.chantier, situation: 'Acompte', dateFacture: '2026-10-01', montantTTC: 1000 })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ statut: 'À valider', delaiPaiementJours: 15, reglements: [], relances: [] })
    ids.facture = res.body.data.id

    const reg = await adci.post(`/api/factures/${ids.facture}/reglements`).send({ date: '2026-10-10', montant: 400, mode: 'Virement' })
    expect(reg.status).toBe(201)
    expect(reg.body.data.reglements).toMatchObject([{ date: '2026-10-10', montant: 400, mode: 'Virement' }])
    ids.reglement = reg.body.data.reglements[0].id
  })

  it('le conducteur n’a pas accès à la facturation en écriture', async () => {
    expect((await conducteur.patch(`/api/factures/${ids.facture}`).send({ statut: 'Validée' })).status).toBe(403)
  })

  it('validation, relance, suppression d’un règlement', async () => {
    expect((await direction.patch(`/api/factures/${ids.facture}`).send({ statut: 'Validée' })).body.data.statut).toBe('Validée')
    const rel = await direction
      .post(`/api/factures/${ids.facture}/relances`)
      .send({ niveau: 'R1', destinataire: "chargé d'affaires", email: 'ca@test.local', objet: 'Rappel', corps: 'Bonjour' })
    expect(rel.status).toBe(201)
    expect(rel.body.data.relances).toMatchObject([{ niveau: 'R1', destinataire: "chargé d'affaires", auteur: 'Dir Ection' }])
    expect((await direction.delete(`/api/reglements/${ids.reglement}`)).body.data.reglements).toHaveLength(0)
  })

  it('un chantier facturé ne peut pas être supprimé', async () => {
    expect((await direction.delete(`/api/chantiers/${ids.chantier}`)).status).toBe(409)
  })

  it('la suppression de la facture, puis du chantier, est persistée', async () => {
    expect((await direction.post('/api/factures/supprimer').send({ ids: [ids.facture] })).body.data.count).toBe(1)
    expect(await prisma.relance.count()).toBe(0)
    expect((await direction.delete(`/api/chantiers/${ids.chantier}`)).status).toBe(200)
    expect(await prisma.observation.count()).toBe(0)
    expect((await direction.get('/api/chantiers')).body.data).toHaveLength(0)
  })
})
