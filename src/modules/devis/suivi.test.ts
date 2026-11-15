// Circuit de validation interne, envoi au client et relances des devis, sur la base gd_test.
import { relanceDevisDue } from '@gd/shared/calculs'
import type { Devis, SuiviDevis } from '@gd/shared/types'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.ts'
import { Categorie, Role, TypeClient } from '../../generated/prisma/client.ts'
import { hashPassword } from '../../lib/password.ts'
import { prisma } from '../../lib/prisma.ts'

if (!process.env.DATABASE_URL?.includes('/gd_test')) throw new Error('Les tests doivent tourner sur la base gd_test')

const app = createApp()
const PASSWORD = 'MotDePasse-Test-123'
let direction: ReturnType<typeof request.agent>
let adci: ReturnType<typeof request.agent>
let clientId: string

async function connecter(email: string) {
  const agent = request.agent(app)
  await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)
  return agent
}

const nouveauDevis = async (numero: string) =>
  (await prisma.devis.create({ data: { numero, clientId, adresse: 'Paris', descriptif: '', commentaires: '', categorie: Categorie.COUVERTURE } })).id

type Suivi = { type: string; auteur: string; commentaire: string | null; statutEnvoi: string | null; email: string | null }

beforeAll(async () => {
  await prisma.demandeMail.deleteMany()
  await prisma.importMail.deleteMany()
  await prisma.intervention.deleteMany()
  await prisma.devis.deleteMany()
  await prisma.client.deleteMany()
  await prisma.utilisateur.deleteMany()
  const passwordHash = await hashPassword(PASSWORD)
  await prisma.utilisateur.create({ data: { prenom: 'Dir', nom: 'ECTION', email: 'direction@test.local', role: Role.DIRECTION, passwordHash } })
  await prisma.utilisateur.create({ data: { prenom: 'Kassa', nom: 'ADCI', email: 'adci@test.local', role: Role.ADCI, passwordHash } })
  clientId = (await prisma.client.create({ data: { nom: 'FONCIA', type: TypeClient.SYNDIC, email: 'gestion@foncia.test' } })).id
  direction = await connecter('direction@test.local')
  adci = await connecter('adci@test.local')
})
afterAll(() => prisma.$disconnect())

describe('circuit de validation des devis', () => {
  it('demande de validation, refus avec motif, validation par la Direction puis envoi', async () => {
    const id = await nouveauDevis('DGD26-0101')
    const etape = (agent: typeof adci, body: object) => agent.post(`/api/devis/${id}/etape`).send(body)

    // L'ADCI ne peut ni valider ni envoyer un devis non validé
    await etape(adci, { action: 'valider' }).expect(403)
    await etape(adci, { action: 'envoyer' }).expect(409)
    await adci.patch(`/api/devis/${id}`).send({ statutADCI: 'Validé' }).expect(403)
    await adci.patch(`/api/devis/${id}`).send({ statutADCI: 'Envoyé' }).expect(409)

    expect((await etape(adci, { action: 'demander' }).expect(200)).body.data.statutADCI).toBe('En attente validation')
    await etape(adci, { action: 'demander' }).expect(409)
    await etape(adci, { action: 'refuser', commentaire: 'Revoir le prix' }).expect(403)
    // Le refus exige un motif
    await etape(direction, { action: 'refuser' }).expect(400)
    expect((await etape(direction, { action: 'refuser', commentaire: 'Revoir le prix' }).expect(200)).body.data.statutADCI).toBe('Non traité')

    await etape(adci, { action: 'demander', commentaire: 'Prix revu' }).expect(200)
    const valide = (await etape(direction, { action: 'valider' }).expect(200)).body.data
    expect(valide).toMatchObject({ statutADCI: 'Validé', validePar: 'Dir ECTION' })
    expect(valide.valideLe).toBeTruthy()

    const envoye = (await etape(adci, { action: 'envoyer', date: '2026-11-02' }).expect(200)).body.data
    expect(envoye).toMatchObject({ statutADCI: 'Envoyé', envoyeLe: '2026-11-02' })
    expect((envoye.suivi as Suivi[]).map((s) => [s.type, s.auteur, s.commentaire])).toEqual([
      ['Validation demandée', 'Kassa ADCI', null],
      ['Validation refusée', 'Dir ECTION', 'Revoir le prix'],
      ['Validation demandée', 'Kassa ADCI', 'Prix revu'],
      ['Validé', 'Dir ECTION', null],
      ['Envoyé au client', 'Kassa ADCI', null],
    ])
    await etape(adci, { action: 'envoyer' }).expect(409)
  })

  it('le formulaire garde le statut sans le rejouer, et la Direction peut envoyer directement', async () => {
    const id = await nouveauDevis('DGD26-0102')
    // Statut inchangé : pas de contrôle ni d'historique
    await adci.patch(`/api/devis/${id}`).send({ statutADCI: 'Non traité', commentaires: 'RAS' }).expect(200)
    const d = (await direction.patch(`/api/devis/${id}`).send({ statutADCI: 'Envoyé' }).expect(200)).body.data
    expect(d.statutADCI).toBe('Envoyé')
    expect(d.envoyeLe).toBe(new Date().toISOString().slice(0, 10))
    expect((d.suivi as Suivi[]).map((s) => s.type)).toEqual(['Envoyé au client'])
  })
})

describe('relances des devis envoyés', () => {
  it('note la relance dans l’historique, refuse un devis pas encore envoyé', async () => {
    const id = await nouveauDevis('DGD26-0103')
    const relance = { email: 'gestion@foncia.test', objet: 'Relance devis DGD26-0103', corps: 'Bonjour, avez-vous pu étudier notre devis ?' }
    await adci.post(`/api/devis/${id}/relances`).send(relance).expect(409)
    await direction.post(`/api/devis/${id}/etape`).send({ action: 'envoyer' }).expect(200)
    const d = (await adci.post(`/api/devis/${id}/relances`).send(relance).expect(201)).body.data
    expect((d.suivi as Suivi[]).at(-1)).toMatchObject({ type: 'Relance', auteur: 'Kassa ADCI', email: 'gestion@foncia.test', statutEnvoi: 'envoyé' })
    // La liste renvoie l'historique de chaque devis
    const liste = (await adci.get('/api/devis').expect(200)).body.data as { id: string; suivi: Suivi[] }[]
    expect(liste.find((x) => x.id === id)!.suivi).toHaveLength(2)
  })
})

describe('relance proposée pour un devis sans réponse', () => {
  const base = { statutADCI: 'Envoyé', resultat: 'En attente', envoyeLe: '2026-11-02', suivi: [] } as unknown as Devis
  const relance = (date: string, statutEnvoi: 'envoyé' | 'échec' = 'envoyé') => ({ type: 'Relance', date: `${date}T10:00:00.000Z`, statutEnvoi }) as SuiviDevis

  it('attend 7 jours après l’envoi, puis propose de relancer', () => {
    expect(relanceDevisDue(base, '2026-11-08')).toMatchObject({ action: 'attendre', depuisEnvoi: 6 })
    expect(relanceDevisDue(base, '2026-11-09')).toMatchObject({ action: 'relancer', depuisContact: 7, relances: 0 })
  })
  it('repart de la dernière relance partie ; un échec ne compte pas', () => {
    expect(relanceDevisDue({ ...base, suivi: [relance('2026-11-09')] }, '2026-11-12')).toMatchObject({ action: 'attendre', relances: 1, depuisContact: 3 })
    expect(relanceDevisDue({ ...base, suivi: [relance('2026-11-09', 'échec')] }, '2026-11-12')).toMatchObject({ action: 'relancer', relances: 0 })
  })
  it('propose de classer sans suite après 3 relances, et ignore les devis qui ont une réponse ou ne sont pas envoyés', () => {
    const trois = [relance('2026-11-09'), relance('2026-11-16'), relance('2026-11-23')]
    expect(relanceDevisDue({ ...base, suivi: trois }, '2026-12-01')).toMatchObject({ action: 'classer', relances: 3 })
    expect(relanceDevisDue({ ...base, resultat: 'Accepté' }, '2026-12-01')).toBeNull()
    expect(relanceDevisDue({ ...base, statutADCI: 'Validé' }, '2026-12-01')).toBeNull()
  })
})
