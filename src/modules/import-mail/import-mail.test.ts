// Parcours complet sur la base gd_test : relève d'un dossier de faux mails, file « À vérifier », validation.
import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.ts'
import { Role, TypeClient } from '../../generated/prisma/client.ts'
import { hashPassword } from '../../lib/password.ts'
import { prisma } from '../../lib/prisma.ts'
import { exemplesMails } from './exemples.ts'
import { relever } from './service.ts'
import { sourceDossier } from './sources/dossier.ts'

if (!process.env.DATABASE_URL?.includes('/gd_test')) throw new Error('Les tests doivent tourner sur la base gd_test')

const app = createApp()
const PASSWORD = 'MotDePasse-Test-123'
let dossier: string
let adci: ReturnType<typeof request.agent>
let conducteur: ReturnType<typeof request.agent>

async function connecter(email: string) {
  const agent = request.agent(app)
  await agent.post('/api/auth/login').send({ email, password: PASSWORD }).expect(200)
  return agent
}

beforeAll(async () => {
  await prisma.importMail.deleteMany()
  await prisma.intervention.deleteMany()
  await prisma.devis.deleteMany()
  await prisma.client.deleteMany()
  await prisma.utilisateur.deleteMany()
  const passwordHash = await hashPassword(PASSWORD)
  await prisma.utilisateur.create({ data: { prenom: 'Kassa', nom: 'ADCI', email: 'adci@test.local', role: Role.ADCI, passwordHash } })
  await prisma.utilisateur.create({ data: { prenom: 'Coco', nom: 'Conduc', email: 'conducteur@test.local', role: Role.CONDUCTEUR, passwordHash } })
  await prisma.client.create({ data: { id: 'c-previmmo', nom: 'CAB. PREVIMMO', type: TypeClient.SYNDIC } })
  await prisma.client.create({ data: { id: 'c-sdc164', nom: 'SDC 164 FAUBOURG SAINT-ANTOINE', type: TypeClient.SYNDIC } })
  await prisma.utilisateur.create({ data: { id: 'u-christian', prenom: 'Christian', nom: 'FUANANA', email: 'christian@test.local', role: Role.CONDUCTEUR } })

  dossier = await mkdtemp(path.join(os.tmpdir(), 'gd-mails-'))
  for (const [nom, contenu] of Object.entries(exemplesMails())) await writeFile(path.join(dossier, nom), contenu)
  adci = await connecter('adci@test.local')
  conducteur = await connecter('conducteur@test.local')
})

afterAll(() => prisma.$disconnect())

describe('relève et file « À vérifier »', () => {
  it('traite les 4 mails du dossier puis les range dans traites/', async () => {
    const etat = await relever(sourceDossier(dossier))
    expect(etat.dernierResultat).toEqual({ 'à vérifier': 3, ignoré: 1 })
    expect(await readdir(dossier)).toEqual(['traites'])
    expect((await readdir(path.join(dossier, 'traites'))).length).toBe(4)
  })

  it('ne retraite jamais un mail déjà vu', async () => {
    for (const [nom, contenu] of Object.entries(exemplesMails())) await writeFile(path.join(dossier, nom), contenu)
    const etat = await relever(sourceDossier(dossier))
    expect(etat.dernierResultat).toEqual({ 'déjà traité': 4 })
    expect(await prisma.importMail.count()).toBe(4)
  })

  it('liste les imports avec champs extraits et anomalies', async () => {
    const res = await adci.get('/api/imports-devis').expect(200)
    const parNumero = Object.fromEntries(res.body.data.map((i: { champs: { numero: string } }) => [i.champs?.numero ?? 'aucun', i]))
    expect(parNumero['DGD26-0931']).toMatchObject({
      statut: 'À vérifier',
      anomalies: [],
      client: { clientId: 'c-previmmo', confiance: 'sûr' },
      devisPropose: { numero: 'DGD26-0931', clientId: 'c-previmmo', categorie: 'Couverture', montantHT: 4250, adresse: '12 rue de Rivoli 75004 PARIS' },
      aUnPdf: true,
    })
    expect(parNumero['DGD26-0932'].anomalies).toEqual(['Client inconnu : Mme DURAND Claire'])
    expect(parNumero['aucun']).toMatchObject({ statut: 'Ignoré', anomalies: ['Ce mail ne ressemble pas à un devis'], aUnPdf: false })
    // Format recommandé : tout vient de la fiche du mail, y compris le métier et le conducteur
    expect(parNumero['DGD26-0933']).toMatchObject({
      anomalies: [],
      champs: { ficheTrouvee: true, categorieIncertaine: false },
      devisPropose: {
        clientId: 'c-sdc164',
        conducteurId: 'u-christian',
        categorie: 'Étanchéité',
        montantHT: 7980,
        adresse: '164 rue du Faubourg Saint-Antoine, 75012 Paris',
        descriptif: 'Réfection de l’étanchéité de la terrasse du 6e étage',
      },
    })
    const etat = await adci.get('/api/imports-devis/etat').expect(200)
    expect(etat.body.data.aVerifier).toBe(3)
  })

  it('sert le PDF du devis', async () => {
    const imp = await prisma.importMail.findFirstOrThrow({ where: { pdfFichier: { not: null } } })
    const res = await adci.get(`/api/imports-devis/${imp.id}/pdf`).expect(200)
    expect(res.headers['content-type']).toMatch(/pdf/)
  })

  it('refuse un rôle non autorisé', async () => {
    await conducteur.get('/api/imports-devis').expect(403)
  })
})

describe('validation', () => {
  it('crée le devis (source Mail) et marque l’import « Importé »', async () => {
    const liste = (await adci.get('/api/imports-devis').expect(200)).body.data
    const imp = liste.find((i: { champs: { numero: string } | null }) => i.champs?.numero === 'DGD26-0931')
    const res = await adci.post(`/api/imports-devis/${imp.id}/valider`).send(imp.devisPropose).expect(201)
    expect(res.body.data).toMatchObject({ numero: 'DGD26-0931', source: 'Mail', montantHT: 4250, statutADCI: 'Non traité', clientId: 'c-previmmo' })
    const apres = (await adci.get(`/api/imports-devis/${imp.id}`).expect(200)).body.data
    expect(apres).toMatchObject({ statut: 'Importé', devisId: res.body.data.id })
    await adci.post(`/api/imports-devis/${imp.id}/valider`).send(imp.devisPropose).expect(409)
  })

  it('refuse sans client (le client inconnu doit être choisi ou créé)', async () => {
    const liste = (await adci.get('/api/imports-devis').expect(200)).body.data
    const imp = liste.find((i: { champs: { numero: string } | null }) => i.champs?.numero === 'DGD26-0932')
    await adci.post(`/api/imports-devis/${imp.id}/valider`).send(imp.devisPropose).expect(400)
  })

  it('ignore puis reprend un import', async () => {
    const imp = await prisma.importMail.findFirstOrThrow({ where: { objet: 'Devis DGD26-0932' } })
    expect((await adci.post(`/api/imports-devis/${imp.id}/ignorer`).expect(200)).body.data.statut).toBe('Ignoré')
    expect((await adci.post(`/api/imports-devis/${imp.id}/reprendre`).expect(200)).body.data.statut).toBe('À vérifier')
  })

  it('un nouveau mail pour un numéro déjà enregistré est ignoré comme doublon', async () => {
    const [, contenu] = Object.entries(exemplesMails())[0]
    const renvoi = Buffer.from(contenu.toString().replace('exemple-0001@', 'exemple-0001-renvoi@'))
    await writeFile(path.join(dossier, 'renvoi.eml'), renvoi)
    const etat = await relever(sourceDossier(dossier))
    expect(etat.dernierResultat).toEqual({ ignoré: 1 })
    const imp = await prisma.importMail.findUniqueOrThrow({ where: { messageId: '<exemple-0001-renvoi@solutionsbtp.fr>' } })
    expect(imp.anomalies).toEqual(['Devis DGD26-0931 déjà enregistré'])
  })
})
