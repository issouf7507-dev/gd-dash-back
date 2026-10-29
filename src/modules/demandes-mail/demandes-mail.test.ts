// Demandes de devis clients : extraction sur des mails calqués sur de vrais mails reçus sur contact@
// (données anonymisées), puis parcours complet sur la base gd_test.
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { boiteDe, dossierAutoDe, extraireDemande, extraireReglement, rapprocherClientDemande, ressembleACv } from './extract.ts'
import { objetNormalise, regrouperAnciens } from './fils.ts'
import { classerAnciens, dossierStockage, rangerDossiersAuto, relever } from './service.ts'

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

  it('range dans la boîte Intervention ce qui ressemble à une intervention', () => {
    expect(extraireDemande(mailLu({ corps: ORDRE_DE_SERVICE })).boite).toBe('Intervention')
    expect(boiteDe('Bonjour, fuite importante dans la cage d’escalier, merci de passer au plus vite')).toBe('Intervention')
    expect(boiteDe('Dépannage gouttière bouchée au 3 rue des Lilas')).toBe('Intervention')
    expect(boiteDe('Merci de nous établir un devis pour la réfection de la toiture')).toBe('Devis')
    expect(boiteDe('Merci de prévoir un rendez-vous mardi')).toBe('Devis')
    // Une demande d'intervention sans métier reconnu n'est pas écartée
    expect(extraireDemande(mailLu({ objet: 'Sinistre dégât des eaux', corps: 'Bonjour, pouvez-vous intervenir chez Mme Durand ?' })).estUneDemande).toBe(true)
  })

  it('range dans la boîte Chantier ce qui concerne un gros chantier', () => {
    expect(boiteDe('Compte-rendu de chantier n°4 - résidence Les Tilleuls')).toBe('Chantier')
    expect(boiteDe('Réunion de chantier mardi 9h, merci de confirmer')).toBe('Chantier')
    expect(boiteDe('Appel d’offres : réfection complète de la toiture, DCE en pièce jointe')).toBe('Chantier')
    expect(boiteDe('Montage de l’échafaudage prévu lundi')).toBe('Chantier')
    expect(boiteDe('Demande de devis pour une gouttière')).toBe('Devis')
    expect(extraireDemande(mailLu({ objet: 'Planning de chantier', corps: 'Bonjour, voici le planning.' })).estUneDemande).toBe(true)
  })

  it('range dans la boîte Facture les paiements et factures, et lit le règlement', () => {
    expect(boiteDe('Avis de virement - FONCIA SEINE OUEST')).toBe('Facture')
    expect(boiteDe('Relance facture impayée FGD26-00012')).toBe('Facture')
    expect(boiteDe('Pouvez-vous nous envoyer un duplicata de la facture n° FGD26-00007 ?')).toBe('Facture')
    // Un ordre de service qui parle de « votre facture » reste une intervention
    expect(boiteDe('Ordre de service N° OS123 : fuite. Votre facture devra être adressée au syndic.')).toBe('Intervention')
    const r = extraireReglement('Avis de virement\nNous avons effectué le virement de 4 250,50 € pour la facture FGD26-00012.\nDate de valeur : 20/10/2026', new Date('2026-10-21'))
    expect(r).toEqual({ numeroFacture: 'FGD26-00012', montant: 4250.5, mode: 'Virement', date: '2026-10-20' })
    expect(extraireReglement('Bonjour', new Date('2026-10-21'))).toEqual({ numeroFacture: null, montant: null, mode: null, date: '2026-10-21' })
  })

  it('choisit le dossier automatique : publicité, fournisseurs, administratif, sous-traitants, assurances, marchés publics', () => {
    const dossier = (texte: string, expediteur = 'x@client.fr') => dossierAutoDe({ texte, expediteur, nomsPieces: [] })
    expect(dossier('Nos promotions du mois. Pour vous désabonner, cliquez ici')).toMatchObject({ nom: 'Publicité / newsletters', ecarter: true })
    expect(dossier('Votre bon de livraison n° 12345', 'agence@pointp.fr')).toMatchObject({ nom: 'Fournisseurs', ecarter: true })
    expect(dossier('Bonjour, voici le tarif', 'commercial@lariviere.fr')).toMatchObject({ nom: 'Fournisseurs' })
    expect(dossier('Votre attestation de vigilance URSSAF')).toMatchObject({ nom: 'Sous-traitants' })
    expect(dossier('Échéance URSSAF du 15/11')).toMatchObject({ nom: 'Administratif', ecarter: true })
    // Peuvent mener à des travaux : rangés mais pas écartés
    expect(dossier('Rendez-vous d’expertise le 12/11 - réf. sinistre 4587')).toMatchObject({ nom: 'Assurances / sinistres', ecarter: false })
    expect(dossier('Avis d’appel public à la concurrence - réfection de toiture')).toMatchObject({ nom: 'Marchés publics', ecarter: false })
    expect(dossier('Bonjour, pouvez-vous nous faire un devis pour une gouttière ?')).toBeNull()
  })

  it('reconnaît une candidature (CV)', () => {
    expect(ressembleACv('Bonjour', ['CV_Jean_Dupont.pdf'])).toBe(true)
    expect(ressembleACv('Candidature spontanée couvreur', [])).toBe(true)
    expect(ressembleACv('', ['Jean Dupont.pdf'], 'Expériences professionnelles\nFormation\nCompétences')).toBe(true)
    expect(ressembleACv('Merci d’intervenir pour une fuite', ['devis-cvc.pdf', 'photo.jpg'], 'Formation des prix')).toBe(false)
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

    type Ligne = { objet: string; statut: string; boite: string; anomalies: string[]; pieces: unknown[] }
    const devis = (await adci.get('/api/demandes-devis').expect(200)).body.data as Ligne[]
    const interventions = (await adci.get('/api/demandes-devis?boite=Intervention').expect(200)).body.data as Ligne[]
    // Les ordres de service commandent des travaux : boîte Intervention
    expect(interventions.map((d) => d.boite)).toEqual(['Intervention', 'Intervention'])
    expect(devis.every((d) => d.boite === 'Devis')).toBe(true)
    const liste = [...devis, ...interventions]
    const pdf = liste.find((d) => d.objet === 'Reprise maçonnerie sol cave')!
    expect(pdf).toMatchObject({ statut: 'À traiter', pieces: [{ nom: 'Reprise maçonnerie sol cave166484.pdf', type: 'application/pdf' }] })
    expect(pdf.anomalies).toEqual(['Client inconnu : CABINET MOREAU', 'Catégorie non détectée'])
    expect(liste.find((d) => d.objet === 'Nos promotions du mois')?.statut).toBe('Ignorée')
    const pub = await prisma.demandeMail.findFirstOrThrow({ where: { objet: 'Nos promotions du mois' }, include: { dossier: true } })
    expect(pub.dossier?.nom).toBe('Publicité / newsletters')
    expect(liste.filter((d) => d.anomalies.includes('Déjà reçue (réf. OSMIL100000001)'))).toHaveLength(1)
    expect((await adci.get('/api/demandes-devis/etat').expect(200)).body.data).toMatchObject({ aTraiter: 1, aTraiterInterventions: 2 })
  })

  it('sert la pièce jointe', async () => {
    const d = await prisma.demandeMail.findFirstOrThrow({ where: { objet: 'Reprise maçonnerie sol cave' } })
    const res = await adci.get(`/api/demandes-devis/${d.id}/pieces/0`).expect(200)
    expect(res.headers['content-type']).toMatch(/pdf/)
    await adci.get(`/api/demandes-devis/${d.id}/pieces/5`).expect(404)
  })

  it('télécharge sans l’afficher une pièce jointe qui pourrait exécuter du code (HTML, SVG…)', async () => {
    await mkdir(dossierStockage(), { recursive: true })
    const fichier = `${randomUUID()}.html`
    await writeFile(path.join(dossierStockage(), fichier), '<script>fetch("/api/utilisateurs")</script>')
    const d = await prisma.demandeMail.create({
      data: {
        messageId: '<piece-html@test>',
        recuLe: new Date(),
        expediteur: 'pirate@exemple.com',
        objet: 'Facture',
        corps: '',
        donnees: {},
        anomalies: [],
        pieces: [{ nom: 'facture.html', type: 'text/html', fichier }, { nom: 'logo.svg', type: 'image/svg+xml', fichier }],
      },
    })
    for (const index of [0, 1]) {
      const res = await adci.get(`/api/demandes-devis/${d.id}/pieces/${index}`).expect(200)
      expect(res.headers['content-type']).toBe('application/octet-stream')
      expect(res.headers['content-disposition']).toMatch(/^attachment;/)
      expect(res.headers['content-security-policy']).toContain('sandbox')
    }
    await prisma.demandeMail.delete({ where: { id: d.id } })
    await rm(path.join(dossierStockage(), fichier))
  })

  it('ne crée qu’un devis quand la demande est validée deux fois en même temps', async () => {
    const d = await prisma.demandeMail.create({
      data: { messageId: '<double-clic@test>', recuLe: new Date(), expediteur: 'a@b.fr', objet: 'Double clic', corps: '', donnees: {}, anomalies: [], pieces: [] },
    })
    const devis = { categorie: 'Couverture', clientId: 'c-foncia', adresse: '1 rue du Test' }
    const reponses = await Promise.all(
      ['DGD26-9001', 'DGD26-9002'].map((numero) => adci.post(`/api/demandes-devis/${d.id}/creer-devis`).send({ ...devis, numero })),
    )
    expect(reponses.map((r) => r.status).sort()).toEqual([201, 409])
    expect(await prisma.devis.count({ where: { numero: { in: ['DGD26-9001', 'DGD26-9002'] } } })).toBe(1)
    await prisma.demandeMail.delete({ where: { id: d.id } })
    await prisma.devis.deleteMany({ where: { numero: { in: ['DGD26-9001', 'DGD26-9002'] } } })
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

  it('crée l’intervention pré-remplie depuis une demande de la boîte Intervention', async () => {
    const { champs } = extraireDemande(mailLu({ corps: ORDRE_DE_SERVICE }))
    const d = await prisma.demandeMail.create({
      data: {
        messageId: '<os-intervention@test>',
        recuLe: new Date(),
        expediteur: 'no-reply@foncia.com',
        objet: 'Ordre de service N° OSMIL100000002',
        corps: ORDRE_DE_SERVICE,
        boite: 'INTERVENTION',
        donnees: JSON.parse(JSON.stringify({ champs, client: { clientId: 'c-foncia', confiance: 'sûr' } })),
        anomalies: [],
        pieces: [],
      },
    })
    const dto = (await adci.get(`/api/demandes-devis/${d.id}`).expect(200)).body.data
    expect(dto.interventionProposee).toMatchObject({ clientId: 'c-foncia', adresse: '1 ALLEE DES LILAS 92110 CLICHY', numero: '' })
    await adci.post(`/api/demandes-devis/${d.id}/creer-intervention`).send(dto.interventionProposee).expect(400)
    const res = await adci.post(`/api/demandes-devis/${d.id}/creer-intervention`).send({ ...dto.interventionProposee, numero: 'INT-T-001' }).expect(201)
    expect(res.body.data).toMatchObject({ numero: 'INT-T-001', clientId: 'c-foncia' })
    expect((await adci.get(`/api/demandes-devis/${d.id}`).expect(200)).body.data).toMatchObject({ statut: 'Intervention créée', interventionId: res.body.data.id })
    await adci.post(`/api/demandes-devis/${d.id}/creer-intervention`).send({ ...dto.interventionProposee, numero: 'INT-T-002' }).expect(409)
    await adci.post(`/api/demandes-devis/${d.id}/boite`).send({ boite: 'Devis' }).expect(409)
    // Même référence que l'ordre de service relevé : on ne fausse pas le test des fils
    await prisma.demandeMail.delete({ where: { id: d.id } })
  })

  it('crée le chantier pré-rempli depuis une demande de la boîte Chantier, avec la demande dans son journal', async () => {
    const corps = 'Bonjour,\nCompte-rendu de chantier : réfection complète de la couverture, 1 allée des Lilas 92110 Clichy.\nCordialement'
    const { champs } = extraireDemande(mailLu({ objet: 'CR de chantier Clichy', corps }))
    const d = await prisma.demandeMail.create({
      data: {
        messageId: '<chantier@test>',
        recuLe: new Date(),
        expediteur: 'moe@archi.fr',
        objet: 'CR de chantier Clichy',
        corps,
        boite: 'CHANTIER',
        donnees: JSON.parse(JSON.stringify({ champs, client: { clientId: 'c-foncia', confiance: 'sûr' } })),
        anomalies: [],
        pieces: [],
      },
    })
    expect((await adci.get('/api/demandes-devis?boite=Chantier').expect(200)).body.data.map((x: { id: string }) => x.id)).toContain(d.id)
    expect((await adci.get('/api/demandes-devis/etat').expect(200)).body.data.aTraiterChantiers).toBeGreaterThanOrEqual(1)
    const dto = (await adci.get(`/api/demandes-devis/${d.id}`).expect(200)).body.data
    expect(dto.chantierPropose).toMatchObject({ clientId: 'c-foncia', numero: '', statut: 'À venir' })
    expect(dto.chantierPropose.observation).toContain('réfection complète')
    const res = await adci.post(`/api/demandes-devis/${d.id}/creer-chantier`).send({ ...dto.chantierPropose, numero: 'CHT-T-001', adresse: '1 allée des Lilas 92110 Clichy' }).expect(201)
    expect(res.body.data).toMatchObject({ numero: 'CHT-T-001', clientId: 'c-foncia' })
    expect(await prisma.observation.findMany({ where: { chantierId: res.body.data.id } })).toMatchObject([{ texte: expect.stringContaining('réfection complète') }])
    expect((await adci.get(`/api/demandes-devis/${d.id}`).expect(200)).body.data).toMatchObject({ statut: 'Chantier créé', chantierId: res.body.data.id })
    await adci.post(`/api/demandes-devis/${d.id}/creer-chantier`).send({ ...dto.chantierPropose, numero: 'CHT-T-002', adresse: 'x' }).expect(409)
    await prisma.demandeMail.delete({ where: { id: d.id } })

    // Un autre mail du même chantier y est rattaché, son texte va au journal
    const cr = await prisma.demandeMail.create({
      data: { messageId: '<chantier-2@test>', recuLe: new Date(), expediteur: 'moe@archi.fr', objet: 'CR n°2', corps: '', boite: 'CHANTIER', donnees: {}, anomalies: [], pieces: [] },
    })
    await adci.post(`/api/demandes-devis/${cr.id}/lier-chantier`).send({ chantierId: 'inconnu' }).expect(404)
    const lie = (await adci.post(`/api/demandes-devis/${cr.id}/lier-chantier`).send({ chantierId: res.body.data.id, observation: 'CR n°2 : couverture posée' }).expect(200)).body.data
    expect(lie).toMatchObject({ statut: 'Chantier créé', chantierId: res.body.data.id })
    expect(await prisma.observation.count({ where: { chantierId: res.body.data.id } })).toBe(2)
    await prisma.demandeMail.delete({ where: { id: cr.id } })
    // Les autres fichiers de test suppriment les clients : le chantier ne doit pas rester
    await prisma.chantier.delete({ where: { id: res.body.data.id } })
  })

  it('rattache un avis de paiement à sa facture et enregistre le règlement', async () => {
    const ch = await prisma.chantier.create({ data: { numero: 'CHT-T-F', devisNumeros: [], adresse: 'x', clientId: 'c-foncia', categorie: 'COUVERTURE', equipes: '' } })
    const f = await prisma.facture.create({ data: { numero: 'FGD26-09001', chantierId: ch.id, situation: 'S1', dateFacture: new Date('2026-10-01'), montantTTC: 1200 } })
    const corps = 'Bonjour,\nNous avons effectué le virement de 1 200,00 € pour la facture FGD26-09001.\nCordialement'
    const d = await prisma.demandeMail.create({
      data: { messageId: '<paiement@test>', recuLe: new Date('2026-10-22'), expediteur: 'compta@foncia.com', objet: 'Avis de virement', corps, boite: 'FACTURE', donnees: {}, anomalies: [], pieces: [] },
    })
    expect((await adci.get('/api/demandes-devis?boite=Facture').expect(200)).body.data.map((x: { id: string }) => x.id)).toContain(d.id)
    expect((await adci.get('/api/demandes-devis/etat').expect(200)).body.data.aTraiterFactures).toBeGreaterThanOrEqual(1)
    const dto = (await adci.get(`/api/demandes-devis/${d.id}`).expect(200)).body.data
    expect(dto.reglementLu).toEqual({ numeroFacture: 'FGD26-09001', montant: 1200, mode: 'Virement', date: '2026-10-22' })

    await adci.post(`/api/demandes-devis/${d.id}/rattacher-facture`).send({ factureId: 'inconnue' }).expect(404)
    const { numeroFacture: _n, ...reglement } = dto.reglementLu
    const res = await adci.post(`/api/demandes-devis/${d.id}/rattacher-facture`).send({ factureId: f.id, reglement }).expect(200)
    expect(res.body.data).toMatchObject({ statut: 'Facture rattachée', factureId: f.id })
    expect(await prisma.reglement.findMany({ where: { factureId: f.id } })).toMatchObject([{ mode: 'Virement' }])
    await adci.post(`/api/demandes-devis/${d.id}/rattacher-facture`).send({ factureId: f.id }).expect(409)

    await prisma.demandeMail.delete({ where: { id: d.id } })
    await prisma.facture.delete({ where: { id: f.id } })
    await prisma.chantier.delete({ where: { id: ch.id } })
  })

  it('déplace une demande dans l’autre boîte', async () => {
    const d = await prisma.demandeMail.findFirstOrThrow({ where: { objet: 'Reprise maçonnerie sol cave' } })
    await adci.post(`/api/demandes-devis/${d.id}/boite`).send({ boite: 'Autre' }).expect(400)
    expect((await adci.post(`/api/demandes-devis/${d.id}/boite`).send({ boite: 'Intervention' }).expect(200)).body.data.boite).toBe('Intervention')
    expect((await adci.get('/api/demandes-devis?boite=Intervention').expect(200)).body.data.map((x: { id: string }) => x.id)).toContain(d.id)
    await adci.post(`/api/demandes-devis/${d.id}/boite`).send({ boite: 'Devis' }).expect(200)
  })

  it('range les mails reçus avant les boîtes, et reprend ceux écartés à tort', async () => {
    const ancien = await prisma.demandeMail.create({
      data: {
        messageId: '<ancien-fuite@test>',
        recuLe: new Date('2026-10-01'),
        expediteur: 'gardien@residence.fr',
        objet: 'Fuite au plafond',
        corps: 'Bonjour, il y a une fuite au plafond du 4e étage.',
        statut: 'IGNOREE',
        donnees: {},
        anomalies: ['Ce mail ne ressemble pas à une demande de devis'],
        pieces: [],
      },
    })
    await classerAnciens()
    expect(await prisma.demandeMail.findUniqueOrThrow({ where: { id: ancien.id } })).toMatchObject({ boite: 'INTERVENTION', statut: 'A_TRAITER', anomalies: [] })
    await prisma.demandeMail.delete({ where: { id: ancien.id } })
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

    const ids = (await prisma.demandeMail.findMany({ where: { boite: 'DEVIS' }, take: 2, orderBy: { recuLe: 'desc' }, select: { id: true } })).map((d) => d.id)
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
    // Hors dossiers automatiques (la newsletter relevée a créé « Publicité / newsletters »)
    const noms = (await adci.get(dossiers).expect(200)).body.data.dossiers.map((d: { nom: string }) => d.nom)
    expect(noms.filter((n: string) => n !== 'Publicité / newsletters').sort()).toEqual(['Archives', 'Urgent'])
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

  it('range les candidatures dans le dossier CV, à l’arrivée comme pour les mails déjà reçus', async () => {
    await prisma.dossierDemande.deleteMany({ where: { nom: 'CV', parentId: null } })
    const ancien = await prisma.demandeMail.create({
      data: {
        messageId: '<ancien-cv@test>',
        recuLe: new Date('2026-09-01'),
        expediteur: 'jean.dupont@gmail.com',
        objet: 'Candidature couvreur zingueur',
        corps: 'Bonjour, je souhaite intervenir sur vos chantiers en tant que couvreur.',
        boite: 'INTERVENTION',
        donnees: {},
        anomalies: [],
        pieces: [],
      },
    })
    const dossier = await mkdtemp(path.join(os.tmpdir(), 'gd-demandes-cv-'))
    await writeFile(
      path.join(dossier, 'cv.eml'),
      eml({ messageId: 'cv-1@gmail.com', date: new Date(), de: 'Marie Martin <marie.martin@gmail.com>', a: 'contact@gdcouverture.fr', objet: 'Poste de couvreur', texte: 'Bonjour, ci-joint mon dossier. Disponible pour intervenir en urgence.', pdf: { nom: 'CV Marie Martin.pdf', lignes: ['Marie Martin'] } }),
    )
    await relever(sourceDossier(dossier))
    const cv = await prisma.dossierDemande.findFirstOrThrow({ where: { nom: 'CV', parentId: null } })
    expect(await prisma.demandeMail.findUniqueOrThrow({ where: { messageId: '<cv-1@gmail.com>' } })).toMatchObject({ dossierId: cv.id, statut: 'IGNOREE', boite: 'DEVIS' })

    // Le mail reçu avant le dossier y est rangé au démarrage, une seule fois
    await prisma.dossierDemande.update({ where: { id: cv.id }, data: { createdAt: new Date() } })
    await rangerDossiersAuto()
    expect(await prisma.demandeMail.findUniqueOrThrow({ where: { id: ancien.id } })).toMatchObject({ dossierId: cv.id, statut: 'IGNOREE', boite: 'DEVIS' })
    await prisma.demandeMail.update({ where: { id: ancien.id }, data: { dossierId: null } })
    await rangerDossiersAuto()
    expect((await prisma.demandeMail.findUniqueOrThrow({ where: { id: ancien.id } })).dossierId).toBeNull()
    expect((await prisma.dossierDemande.findMany({ where: { nom: 'CV' } })).length).toBe(1)
  })
})

describe('objet normalisé', () => {
  it('retire les préfixes de réponse et de transfert, la casse et les accents', () => {
    expect(objetNormalise('TR: RE:Re : [EXT] Fwd: Dégât  des eaux')).toBe('degat des eaux')
    expect(objetNormalise('RE[2]: Devis')).toBe('devis')
  })
})
