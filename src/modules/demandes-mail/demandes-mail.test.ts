// Demandes de devis clients : extraction sur des mails calqués sur de vrais mails reçus sur contact@
// (données anonymisées), puis parcours complet sur la base gd_test.
import { mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.ts'
import { Role, TypeClient } from '../../generated/prisma/client.ts'
import { hashPassword } from '../../lib/password.ts'
import { prisma } from '../../lib/prisma.ts'
import { eml } from '../import-mail/exemples.ts'
import { sourceDossier } from '../import-mail/sources/dossier.ts'
import { extraireDemande, rapprocherClientDemande } from './extract.ts'
import { objetNormalise, regrouperAnciens } from './fils.ts'
import { relever } from './service.ts'

if (!process.env.DATABASE_URL?.includes('/gd_test')) throw new Error('Les tests doivent tourner sur la base gd_test')

/** Ordre de service d'un syndic, transféré par un collègue (texte dans le corps du mail, pas de PJ) */
const ORDRE_DE_SERVICE = `

Bien Cordialement,

Paul MARTIN


________________________________
De : no-reply@foncia.com <no-reply@foncia.com>
Envoyé : mercredi, octobre 14, 2026 3:29 PM
À : gestionnaire@foncia.com <gestionnaire@foncia.com>; GD Couverture <contact@gdcouverture.fr>
Objet : Ordre de service N° OSMIL100000001 – INFILTRATIONS TOITURE MR DUPONT - 1 ALLEE DES LILAS 92110 CLICHY


Bonjour,

En notre qualité de syndic, représenté(e) par Julie DURAND, du bien désigné en objet, nous vous remercions d'exécuter les travaux décrits dans l’ordre de service détaillé ci-dessous :

Immeuble N° 500000001 : SDC 1 ALLEE DES LILAS - 1 ALLEE DES LILAS 92110 CLICHY,

digicode(s):
- Bâtiment 1 - Digicode : 12A34 - ENTREE

Objet : INFILTRATIONS TOITURE MR DUPONT

Contacts sur place :
- MR DUPONT (copropriétaire) +33600000001

Merci de nous confirmer la bonne exécution des travaux par retour de mail.

Adresse de livraison : 1 ALLEE DES LILAS 92110 CLICHY
Cabinet de gestion tiers payeur : FONCIA SEINE OUEST, 9 rue du Port, 92700 Colombes

Bonjour,

Merci d’intervenir en urgence afin de rechercher l’origine des infiltrations d’eau constatées au niveau des sorties de ventilation en toiture.

Merci de vérifier l’état et l’étanchéité des chapeaux de toiture, et d'établir un rapport et un devis.

Sincères salutations.

[Foncia]
`

/** Demande de devis d'un syndic : le mail ne contient que le PDF */
const PDF_DEMANDE = [
  'GD COUVERTURE',
  '21 rue Sainte-Marie',
  '92230 GENNEVILLIERS',
  'Courbevoie, 12 octobre 2026',
  'Demande de devis n° 100900.26.0007',
  'Gestionnaire : MOREAU Camille',
  'Téléphone : 01.00.00.00.01',
  "Adresse de l'immeuble concerné :",
  '203 rue du Faubourg Saint-Denis 75010 PARIS',
  "Accès à l'immeuble :",
  'Digicode : 24A17',
  'Correspondants sur place :',
  'En notre qualité de représentant du Syndicat des copropriétaires, nous vous remercions de bien vouloir',
  'établir un devis pour les prestations suivantes :',
  'Reprise maçonnerie sol cave',
  'Merci de prendre RDV avec le CS:',
  'Madame LEROY Mobile 06.00.00.00.02',
  'Date de réception du devis : URGENT',
  'Observations :',
  '- Les dossiers AMIANTE et CREP de cet immeuble sont consultables sur simple demande.',
]

const mailsExemples = () => ({
  'os.eml': eml({
    messageId: 'os-0001@gdcouverture.fr',
    date: new Date('2026-10-14T19:16:15Z'),
    de: '"Paul MARTIN" <pmartin@gdcouverture.fr>',
    a: 'contact@gdcouverture.fr',
    objet: 'Fw: Ordre de service N° OSMIL100000001 – INFILTRATIONS TOITURE MR DUPONT - 1 ALLEE DES LILAS 92110 CLICHY',
    texte: ORDRE_DE_SERVICE,
  }),
  'os-doublon.eml': eml({
    messageId: 'os-0001-bis@foncia.com',
    date: new Date('2026-10-14T13:29:00Z'),
    de: 'no-reply@foncia.com',
    a: 'contact@gdcouverture.com',
    objet: 'Ordre de service N° OSMIL100000001 – INFILTRATIONS TOITURE MR DUPONT - 1 ALLEE DES LILAS 92110 CLICHY',
    texte: ORDRE_DE_SERVICE,
  }),
  'pdf.eml': eml({
    messageId: 'demande-0002@cabinet-moreau.fr',
    date: new Date('2026-10-12T09:00:00Z'),
    de: '"Camille MOREAU" <c.moreau@cabinet-moreau.fr>',
    a: 'contact@gdcouverture.fr',
    objet: 'Reprise maçonnerie sol cave',
    texte: '',
    pdf: { nom: 'Reprise maçonnerie sol cave166484.pdf', lignes: PDF_DEMANDE },
  }),
  'newsletter.eml': eml({
    messageId: 'news-0003@fournisseur.fr',
    date: new Date('2026-10-13T08:00:00Z'),
    de: 'news@fournisseur.fr',
    a: 'contact@gdcouverture.fr',
    objet: 'Nos promotions du mois',
    texte: 'Découvrez nos nouveautés et profitez de -20 % sur toute la gamme.',
  }),
})

const mailLu = (m: Partial<Parameters<typeof extraireDemande>[0]>) => ({
  objet: '',
  corps: '',
  textePdf: '',
  expediteur: { nom: '', email: 'x@exemple.fr' },
  destinataires: [],
  date: new Date('2026-10-15T10:00:00Z'),
  ...m,
})

describe('extraction', () => {
  it('lit un ordre de service transféré', () => {
    const { estUneDemande, champs } = extraireDemande(
      mailLu({ objet: 'Fw: Ordre de service N° OSMIL100000001 – INFILTRATIONS', corps: ORDRE_DE_SERVICE, expediteur: { nom: 'Paul MARTIN', email: 'pmartin@gdcouverture.fr' } }),
    )
    expect(estUneDemande).toBe(true)
    expect(champs).toMatchObject({
      type: 'Ordre de service',
      reference: 'OSMIL100000001',
      clientNom: 'FONCIA SEINE OUEST',
      clientEmail: 'no-reply@foncia.com',
      gestionnaire: 'Julie DURAND',
      adresse: '1 ALLEE DES LILAS 92110 CLICHY',
      acces: 'Bâtiment 1 - Digicode : 12A34 - ENTREE',
      contacts: ['MR DUPONT (copropriétaire) +33600000001'],
      categorie: 'Couverture',
      urgent: true,
    })
    expect(champs.descriptif).toMatch(/^INFILTRATIONS TOITURE MR DUPONT\nMerci d’intervenir en urgence/)
    expect(champs.descriptif).not.toMatch(/salutations/i)
  })

  it('lit une demande de devis en PDF', () => {
    const { estUneDemande, champs } = extraireDemande(
      mailLu({ objet: 'Reprise maçonnerie sol cave', textePdf: PDF_DEMANDE.join('\n'), expediteur: { nom: 'Camille MOREAU', email: 'c.moreau@cabinet-moreau.fr' } }),
    )
    expect(estUneDemande).toBe(true)
    expect(champs).toMatchObject({
      type: 'Demande de devis',
      reference: '100900.26.0007',
      dateDemande: '2026-10-12',
      gestionnaire: 'MOREAU Camille',
      adresse: '203 rue du Faubourg Saint-Denis 75010 PARIS',
      acces: 'Digicode : 24A17',
      contacts: ['Madame LEROY Mobile 06.00.00.00.02'],
      // « GD COUVERTURE » en en-tête ne fait pas une demande de couverture
      categorie: null,
      urgent: true,
    })
    expect(champs.descriptif).toMatch(/^Reprise maçonnerie sol cave\n/)
  })

  it('écarte un mail qui n’est pas une demande', () => {
    expect(extraireDemande(mailLu({ objet: 'Nos promotions du mois', corps: 'Profitez de -20 % sur toute la gamme.' })).estUneDemande).toBe(false)
  })

  it('reconnaît le client par le domaine de son adresse, ou par son nom cité dans le mail', () => {
    const clients = [
      { id: 'a', nom: 'FONCIA SEINE OUEST', email: null },
      { id: 'b', nom: 'Cabinet Moreau', email: 'compta@cabinet-moreau.fr' },
    ]
    const champs = (clientEmail: string | null) => ({ ...extraireDemande(mailLu({})).champs, clientEmail })
    expect(rapprocherClientDemande(clients, champs('c.moreau@cabinet-moreau.fr'), '')).toEqual({ clientId: 'b', confiance: 'sûr' })
    expect(rapprocherClientDemande(clients, champs('no-reply@foncia.com'), ORDRE_DE_SERVICE)).toEqual({ clientId: 'a', confiance: 'sûr' })
    expect(rapprocherClientDemande(clients, champs('inconnu@gmail.com'), 'rien')).toEqual({ clientId: null, confiance: 'aucun' })
  })
})

const app = createApp()
const PASSWORD = 'MotDePasse-Test-123'
let adci: ReturnType<typeof request.agent>

describe('relève et traitement', () => {
  beforeAll(async () => {
    await prisma.demandeMail.deleteMany()
    await prisma.categorieDemande.deleteMany()
    await prisma.dossierDemande.deleteMany()
    await prisma.importMail.deleteMany()
    await prisma.intervention.deleteMany()
    await prisma.devis.deleteMany()
    await prisma.client.deleteMany()
    await prisma.utilisateur.deleteMany()
    await prisma.utilisateur.create({ data: { prenom: 'Kassa', nom: 'ADCI', email: 'adci@test.local', role: Role.ADCI, passwordHash: await hashPassword(PASSWORD) } })
    await prisma.client.create({ data: { id: 'c-foncia', nom: 'FONCIA SEINE OUEST', type: TypeClient.SYNDIC } })
    adci = request.agent(app)
    await adci.post('/api/auth/login').send({ email: 'adci@test.local', password: PASSWORD }).expect(200)
  })
  afterAll(() => prisma.$disconnect())

  it('range les demandes « À traiter », ignore le reste et signale les doublons', async () => {
    const dossier = await mkdtemp(path.join(os.tmpdir(), 'gd-demandes-'))
    for (const [nom, contenu] of Object.entries(mailsExemples())) await writeFile(path.join(dossier, nom), contenu)
    const etat = await relever(sourceDossier(dossier))
    expect(etat.dernierResultat).toEqual({ 'à traiter': 3, ignorée: 1 })

    const liste = (await adci.get('/api/demandes-devis').expect(200)).body.data as { objet: string; statut: string; anomalies: string[]; pieces: unknown[] }[]
    const pdf = liste.find((d) => d.objet === 'Reprise maçonnerie sol cave')!
    expect(pdf).toMatchObject({ statut: 'À traiter', pieces: [{ nom: 'Reprise maçonnerie sol cave166484.pdf', type: 'application/pdf' }] })
    expect(pdf.anomalies).toEqual(['Client inconnu : CABINET MOREAU', 'Catégorie non détectée'])
    expect(liste.find((d) => d.objet === 'Nos promotions du mois')?.statut).toBe('Ignorée')
    expect(liste.filter((d) => d.anomalies.includes('Déjà reçue (réf. OSMIL100000001)'))).toHaveLength(1)
    expect((await adci.get('/api/demandes-devis/etat').expect(200)).body.data.aTraiter).toBe(3)
  })

  it('sert la pièce jointe', async () => {
    const d = await prisma.demandeMail.findFirstOrThrow({ where: { objet: 'Reprise maçonnerie sol cave' } })
    const res = await adci.get(`/api/demandes-devis/${d.id}/pieces/0`).expect(200)
    expect(res.headers['content-type']).toMatch(/pdf/)
    await adci.get(`/api/demandes-devis/${d.id}/pieces/5`).expect(404)
  })

  it('crée le devis pré-rempli une fois le n° saisi, puis refuse de le recréer', async () => {
    const d = await prisma.demandeMail.findFirstOrThrow({ where: { messageId: '<os-0001@gdcouverture.fr>' } })
    const dto = (await adci.get(`/api/demandes-devis/${d.id}`).expect(200)).body.data
    expect(dto.devisPropose).toMatchObject({ clientId: 'c-foncia', adresse: '1 ALLEE DES LILAS 92110 CLICHY', categorie: 'Couverture', numero: '' })
    expect(dto.devisPropose.commentaires).toContain('Ordre de service : OSMIL100000001')
    await adci.post(`/api/demandes-devis/${d.id}/creer-devis`).send(dto.devisPropose).expect(400)
    const res = await adci.post(`/api/demandes-devis/${d.id}/creer-devis`).send({ ...dto.devisPropose, numero: 'DGD26-1001' }).expect(201)
    expect(res.body.data).toMatchObject({ numero: 'DGD26-1001', source: 'Mail', clientId: 'c-foncia' })
    expect((await adci.get(`/api/demandes-devis/${d.id}`).expect(200)).body.data).toMatchObject({ statut: 'Devis créé', devisId: res.body.data.id })
    await adci.post(`/api/demandes-devis/${d.id}/creer-devis`).send({ ...dto.devisPropose, numero: 'DGD26-1002' }).expect(409)
  })

  it('rattache le doublon au devis existant par son numéro', async () => {
    const d = await prisma.demandeMail.findFirstOrThrow({ where: { messageId: '<os-0001-bis@foncia.com>' } })
    await adci.post(`/api/demandes-devis/${d.id}/lier`).send({ numero: 'INCONNU' }).expect(404)
    const res = await adci.post(`/api/demandes-devis/${d.id}/lier`).send({ numero: 'DGD26-1001' }).expect(200)
    expect(res.body.data.statut).toBe('Devis créé')
  })

  it('ignore puis reprend une demande', async () => {
    const d = await prisma.demandeMail.findFirstOrThrow({ where: { objet: 'Nos promotions du mois' } })
    expect((await adci.post(`/api/demandes-devis/${d.id}/reprendre`).expect(200)).body.data.statut).toBe('À traiter')
    expect((await adci.post(`/api/demandes-devis/${d.id}/ignorer`).expect(200)).body.data.statut).toBe('Ignorée')
  })

  it('range les demandes dans une catégorie, puis les libère quand la catégorie est supprimée', async () => {
    const cat = (await adci.post('/api/demandes-devis/categories').send({ nom: 'Foncia', couleur: 'blue' }).expect(201)).body.data
    await adci.post('/api/demandes-devis/categories').send({ nom: 'Foncia', couleur: 'red' }).expect(409)
    await adci.post('/api/demandes-devis/categories').send({ nom: 'Autre', couleur: 'rose' }).expect(400)
    await adci.patch(`/api/demandes-devis/categories/${cat.id}`).send({ nom: 'Foncia Seine Ouest' }).expect(200)

    const ids = (await prisma.demandeMail.findMany({ take: 2, select: { id: true } })).map((d) => d.id)
    await adci.post('/api/demandes-devis/ranger').send({ ids, categorieId: 'inconnue' }).expect(404)
    expect((await adci.post('/api/demandes-devis/ranger').send({ ids, categorieId: cat.id }).expect(200)).body.data.count).toBe(2)
    expect((await adci.get(`/api/demandes-devis/${ids[0]}`).expect(200)).body.data.categorieId).toBe(cat.id)

    await adci.delete(`/api/demandes-devis/categories/${cat.id}`).expect(200)
    expect((await adci.get('/api/demandes-devis/categories').expect(200)).body.data).toEqual([])
    expect((await adci.get(`/api/demandes-devis/${ids[0]}`).expect(200)).body.data.categorieId).toBeNull()
  })

  it('classe les demandes dans des dossiers et sous-dossiers', async () => {
    const dossiers = '/api/demandes-devis/dossiers'
    const foncia = (await adci.post(dossiers).send({ nom: 'Foncia' }).expect(201)).body.data
    const urgent = (await adci.post(dossiers).send({ nom: 'Urgent', parentId: foncia.id }).expect(201)).body.data
    const archives = (await adci.post(dossiers).send({ nom: 'Archives' }).expect(201)).body.data
    await adci.post(dossiers).send({ nom: 'Foncia' }).expect(409)
    await adci.post(dossiers).send({ nom: 'Urgent', parentId: archives.id }).expect(201)
    await adci.post(dossiers).send({ nom: 'X', parentId: 'inconnu' }).expect(404)

    // Pas de boucle : un dossier ne va pas dans son propre sous-dossier
    await adci.patch(`${dossiers}/${foncia.id}`).send({ parentId: urgent.id }).expect(409)
    await adci.patch(`${dossiers}/${foncia.id}`).send({ parentId: foncia.id }).expect(409)

    const ids = (await prisma.demandeMail.findMany({ take: 2, orderBy: { recuLe: 'desc' }, select: { id: true } })).map((d) => d.id)
    await adci.post('/api/demandes-devis/classer').send({ ids: [ids[0]], dossierId: foncia.id }).expect(200)
    await adci.post('/api/demandes-devis/classer').send({ ids: [ids[1]], dossierId: urgent.id }).expect(200)
    await adci.post('/api/demandes-devis/classer').send({ ids, dossierId: 'inconnu' }).expect(404)

    // Un dossier montre aussi les mails de ses sous-dossiers
    const liste = async (dossier: string) => (await adci.get(`/api/demandes-devis?dossier=${dossier}`).expect(200)).body.data.map((d: { id: string }) => d.id)
    expect(await liste(foncia.id)).toEqual(ids)
    expect(await liste(urgent.id)).toEqual([ids[1]])
    expect(await liste('aucun')).not.toContain(ids[0])

    const arbre = (await adci.get(dossiers).expect(200)).body.data
    expect(arbre.dossiers.find((d: { id: string }) => d.id === foncia.id)).toMatchObject({ mails: 1, parentId: null })
    expect(arbre.dossiers.find((d: { id: string }) => d.id === urgent.id)).toMatchObject({ mails: 1, parentId: foncia.id })
    expect(arbre.tous.mails).toBe(arbre.sansDossier.mails + 2)

    // Déplacer « Urgent » à la racine puis supprimer « Foncia » avec ses sous-dossiers
    await adci.patch(`${dossiers}/${urgent.id}`).send({ parentId: archives.id }).expect(409)
    await adci.patch(`${dossiers}/${urgent.id}`).send({ nom: 'Très urgent', parentId: archives.id }).expect(200)
    await adci.patch(`${dossiers}/${urgent.id}`).send({ parentId: foncia.id }).expect(200)
    await adci.delete(`${dossiers}/${foncia.id}`).expect(200)
    expect((await adci.get(dossiers).expect(200)).body.data.dossiers.map((d: { nom: string }) => d.nom).sort()).toEqual(['Archives', 'Urgent'])
    for (const id of ids) expect((await adci.get(`/api/demandes-devis/${id}`).expect(200)).body.data.dossierId).toBeNull()
  })

  it('regroupe en fils les réponses, les relances au même objet et les mails de même référence', async () => {
    const osMemeRef = await prisma.demandeMail.findMany({ where: { donnees: { path: '$.champs.reference', equals: 'OSMIL100000001' } }, select: { filId: true } })
    expect(osMemeRef).toHaveLength(2)
    expect(osMemeRef[0].filId).toBe(osMemeRef[1].filId)

    const de = 'Agence Atrium <agence@atrium-test.fr>'
    const a = 'contact@gd.fr'
    const texte = 'Bonjour, merci de nous faire parvenir un devis pour la fuite en toiture. Cordialement'
    const dossier = await mkdtemp(path.join(os.tmpdir(), 'gd-fils-'))
    // La réponse est relevée avant le mail d'origine : le rattachement marche dans les deux sens
    await writeFile(path.join(dossier, '1-reponse.eml'), eml({ messageId: 'fil-2@atrium-test.fr', enReponseA: 'fil-1@atrium-test.fr', date: new Date('2026-10-02T10:00:00Z'), de, a, objet: 'Photos complémentaires', texte }))
    await writeFile(path.join(dossier, '2-origine.eml'), eml({ messageId: 'fil-1@atrium-test.fr', date: new Date('2026-10-01T10:00:00Z'), de, a, objet: 'Demande de devis fuite toiture 12 rue des Lilas', texte }))
    await writeFile(path.join(dossier, '3-relance.eml'), eml({ messageId: 'fil-3@atrium-test.fr', date: new Date('2026-10-05T10:00:00Z'), de, a, objet: 'TR: RE: Demande de devis fuite  toiture 12 rue des Lilas', texte }))
    await writeFile(path.join(dossier, '4-autre.eml'), eml({ messageId: 'fil-4@atrium-test.fr', date: new Date('2026-10-06T10:00:00Z'), de, a, objet: 'Demande de devis ravalement 3 rue Haute', texte }))
    await relever(sourceDossier(dossier))

    const mail = (n: number) => prisma.demandeMail.findUniqueOrThrow({ where: { messageId: `<fil-${n}@atrium-test.fr>` } })
    const [m1, m2, m3, m4] = await Promise.all([1, 2, 3, 4].map(mail))
    expect([m2.filId, m3.filId]).toEqual([m1.id, m1.id])
    expect(m4.filId).toBe(m4.id)
    const detail = (await adci.get(`/api/demandes-devis/${m3.id}`).expect(200)).body.data
    expect(detail.filId).toBe(m1.id)
    expect(detail.fil.map((m: { id: string }) => m.id)).toEqual([m1.id, m2.id, m3.id])

    // Correction à la main : sortir le premier mail du fil, puis regrouper deux fils
    await adci.post(`/api/demandes-devis/${m1.id}/separer`).expect(200)
    expect((await mail(1)).filId).toBe(m1.id)
    expect([(await mail(2)).filId, (await mail(3)).filId]).toEqual([m2.id, m2.id])
    await adci.post('/api/demandes-devis/fils/regrouper').send({ ids: [m4.id] }).expect(400)
    expect((await adci.post('/api/demandes-devis/fils/regrouper').send({ ids: [m1.id, m4.id] }).expect(200)).body.data.filId).toBe(m1.id)
    expect((await mail(4)).filId).toBe(m1.id)

    // Mails reçus avant la mise en place des fils : regroupés au démarrage
    await prisma.demandeMail.updateMany({ data: { filId: null } })
    await regrouperAnciens()
    const apres = await Promise.all([1, 2, 3, 4].map(mail))
    expect(apres.map((m) => m.filId)).toEqual([m1.id, m1.id, m1.id, m4.id])
  })
})

describe('objet normalisé', () => {
  it('retire les préfixes de réponse et de transfert, la casse et les accents', () => {
    expect(objetNormalise('TR: RE:Re : [EXT] Fwd: Dégât  des eaux')).toBe('degat des eaux')
    expect(objetNormalise('RE[2]: Devis')).toBe('devis')
  })
})
