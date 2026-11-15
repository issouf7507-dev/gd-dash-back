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
import { boiteDe, dossierAutoDe, estDemandeDeDevis, estMailDeDemandeDevis, resultatDevisDans, extraireDemande, extraireReglement, rapprocherClientDemande, ressembleACv, sansHistorique } from './extract.ts'
import { joursOuvres, limiteRetard } from './delais.ts'
import { objetNormalise, regrouperAnciens } from './fils.ts'
import { appliquerResultatDevis, classerAnciens, dossierStockage, rangerDossiersAuto, relever } from './service.ts'

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

  it('range dans la boîte Devis les demandes de devis, même quand le mail parle de chantier ou de facture', () => {
    // Objet de demande de chiffrage : l'emporte sur le vocabulaire de chantier du corps
    expect(boiteDe('Demande de Devis N: DEV2689 / SDC 30 RUE DU BAC\nMerci de nous faire parvenir un devis. Échafaudage à prévoir.')).toBe('Devis')
    expect(boiteDe('SDC / 46, rue de Naples - Mise à jour devis\nRéfection complète des versants de couverture')).toBe('Devis')
    expect(boiteDe('8 rue Gabriel Péri / Demande proposition\nCi-joint une demande de proposition.')).toBe('Devis')
    // Demande écrite dans le dernier message d'une réponse
    expect(boiteDe('Re: Ordre de Service N: BDCE26410\nBonjour, pouvez-vous m’indiquer le tarif pour la recherche par caméra ?')).toBe('Devis')
    expect(boiteDe('RE: Recherche de fuite Bâtiment F\nPouvez-vous nous transmettre un chiffrage avec l’option fonte ?\n\nDe : GD\nVotre facture n° FGD26-0001')).toBe('Devis')
    expect(boiteDe('RE: 50 rue Saint-Sébastien\nNous restons en attente de votre devis pour remédier à ce désordre.')).toBe('Devis')
    expect(boiteDe('Re: 47 rue d’Alsace\nLe sarking doit être intégré au devis en base. Pouvez-vous modifier le devis ?')).toBe('Devis')
    // L'historique cité ne fait pas une demande de devis
    expect(boiteDe('RE: 29 VANNEAU - Problème de velux\nC’est bien noté, merci.\n\nDe : GD Couverture\nUne fuite au dernier étage, merci d’intervenir.')).toBe('Intervention')
    // Un devis accepté n'est plus une demande de chiffrage
    expect(boiteDe('Accord sur devis - remplacement de plaque\nVeuillez trouver l’ordre de service, merci de nous établir la facture d’acompte.')).toBe('Intervention')
    expect(estDemandeDeDevis('Devis validé - DGD26-0547', 'Votre devis a été validé.')).toBe(false)
    // Une demande de visite seule (constat d'humidité…) n'est pas une demande de devis ; avec audit ou devis, oui
    expect(estDemandeDeDevis('DDE DE VISITE SUR SITE BAT B - GROSSE HUMIDITE', '')).toBe(false)
    expect(estDemandeDeDevis('Demande de visite technique/audit – couverture', '')).toBe(true)
    expect(estDemandeDeDevis('IENA - Demande de visite et devis – état des toitures', '')).toBe(true)
    expect(sansHistorique('Merci.\n\nLe jeu. 5 nov. 2026 à 09:16, GD a écrit :\nancien message').trim()).toBe('Merci.')
  })

  it('ne montre dans « Demandes de devis » que les demandes écrites par des clients', () => {
    expect(estMailDeDemandeDevis('Demande de devis - toiture', 'Bonjour, merci de nous faire un devis.', 'gestion@syndic.fr')).toBe(true)
    // Réponse de GD dans le fil : pas une demande ; transfert par un collègue : oui
    expect(estMailDeDemandeDevis('RE: Demande de devis - toiture', 'Veuillez trouver ci-joint notre devis.', 'contact@gdcouverture.fr')).toBe(false)
    expect(estMailDeDemandeDevis('TR: Demande de devis - toiture', 'Raïssa, voici une demande de devis.', 'cd@gdcouverture.fr')).toBe(true)
    expect(estMailDeDemandeDevis('Relance globale - 9 devis non traités', 'Merci de faire le devis.', 'gd.couv@gmail.com')).toBe(false)
    expect(estMailDeDemandeDevis('Demande de devis – Isolation', 'Veuillez trouver ci-joint notre devis.', 'no-reply@solutionsbtp.fr')).toBe(false)
  })

  it('range les bons de commande de GD et leurs réponses dans le dossier BC', () => {
    const dossier = (texte: string, expediteur: string) => dossierAutoDe({ texte, expediteur, nomsPieces: [] })
    const bc = { nom: 'Bons de commande (BC)', ecarter: true }
    expect(dossier('Confirmation prise en charge commande n° BC-2611089\nVeuillez trouver ci-joint notre commande.', 'no-reply@solutionsbtp.fr')).toMatchObject(bc)
    expect(dossier('RE: Confirmation prise en charge commande n° BC-2610157\nBien reçu, délai à confirmer.', 'agence@raboni.fr')).toMatchObject(bc)
    expect(dossier('8 rue Baudelique\nBonjour, je te transmets ci-joint ton bon de commande.', 'contact@gdcouverture.fr')).toMatchObject(bc)
    // Un client qui parle de bon de commande n'est pas un bon de commande de GD
    expect(dossier('Travaux toiture\nVeuillez trouver notre bon de commande pour les travaux.', 'gestion@syndic.fr')).toBeNull()
  })

  it('lit l’accord ou le refus du client sur un devis', () => {
    const client = 'gestion@syndic.fr'
    expect(resultatDevisDans('accord 58 rue du Faubourg St Denis', 'Nous avons l’accord sur votre devis n° DGD26-0850 du 09/09/26.', client)).toEqual({
      resultat: 'Accepté',
      numeros: ['DGD26-0850'],
      motif: null,
    })
    expect(resultatDevisDans('DEVIS SIGNE - TOUR ORIX', 'Veuillez trouver votre devis dûment signé.', client)?.resultat).toBe('Accepté')
    expect(resultatDevisDans('SDC 1 RUE JEAN BOLOGNE - OS DEVIS TOITURE', 'ORDRE DE SERVICE – BON POUR ACCORD', client)?.resultat).toBe('Accepté')
    // N° du devis lu dans l'historique cité (mail d'envoi du devis)
    expect(resultatDevisDans('Re: Devis toiture', 'Devis accepté, merci.\n\nDe : GD\nVeuillez trouver notre devis DGD26-0923/2.', client)?.numeros).toEqual(['DGD26-0923/2'])
    const refus = resultatDevisDans('Refus du Devis - DEV261808 / 4/6 BARRAGE', 'Bonjour,\nNous reconnaissons la qualité de vos prestations mais une autre entreprise a été retenue.', client)
    expect(refus).toMatchObject({ resultat: 'Refusé' })
    // Pas une réponse : notification interne, réponse de GD, simple formule de politesse
    expect(resultatDevisDans('Devis validé - DGD26-0547', 'Votre devis a été validé par Kassa.', 'gd.couv@gmail.com')).toBeNull()
    expect(resultatDevisDans('RE: Devis accepté', 'Merci pour votre accord sur le devis.', 'contact@gdcouverture.fr')).toBeNull()
    expect(resultatDevisDans('Re: Ordre de service', 'Si vous ne souhaitez pas donner suite, dites-le-moi.', client)).toBeNull()
  })

  it('garde une demande de devis que le pied de mail ferait passer pour une publicité ou un sous-traitant', () => {
    const dossier = (texte: string, expediteur = 'x@syndic.fr') => dossierAutoDe({ texte, expediteur, nomsPieces: [] })
    expect(dossier('Fw: [Urgent] 82 rue de Paris\nPouvez-vous m’adresser le devis pour la reprise de l’étanchéité ?\nSe désabonner')).toBeNull()
    expect(dossier('136 rue du Chemin Vert\nAfin de vous adresser une demande de devis, merci de nous envoyer votre attestation de vigilance.')).toBeNull()
    // Une newsletter qui parle de devis reste une publicité ; un négoce reste un fournisseur
    expect(dossier('Devis gratuit sous 24 h !\nFaites établir votre devis. Se désabonner')).toMatchObject({ nom: 'Publicité / newsletters' })
    expect(dossier('RE: Demande de prix\nVeuillez trouver notre proposition, merci de nous transmettre votre devis signé.', 'agence@pointp.fr')).toMatchObject({ nom: 'Fournisseurs' })
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

  it('affecte une demande à une personne, qui ne voit et ne traite que ses demandes ; le CRM montre la charge de chacun', async () => {
    await prisma.equipe.deleteMany()
    const conducteur = await prisma.utilisateur.create({
      data: { prenom: 'Davis', nom: 'CONDUCTEUR', email: 'conducteur@test.local', role: Role.CONDUCTEUR, passwordHash: await hashPassword(PASSWORD) },
    })
    const agent = request.agent(app)
    await agent.post('/api/auth/login').send({ email: 'conducteur@test.local', password: PASSWORD }).expect(200)
    const [a, b] = await prisma.demandeMail.findMany({ orderBy: { recuLe: 'asc' }, take: 2 })

    // Avant affectation : rien à voir, pas d'accès à la demande, pas d'affectation possible
    expect((await agent.get('/api/demandes-devis').expect(200)).body.data).toEqual([])
    await agent.get(`/api/demandes-devis/${a.id}`).expect(403)
    await agent.post('/api/demandes-devis/affecter').send({ ids: [a.id], utilisateurId: conducteur.id }).expect(403)

    await adci.post('/api/demandes-devis/affecter').send({ ids: [a.id], utilisateurId: conducteur.id }).expect(200)
    // Liste filtrée sur ses demandes, quelle que soit la boîte ou le dossier demandés
    const siennes = (await agent.get('/api/demandes-devis?boite=Facture').expect(200)).body.data as { id: string; affecteAId: string }[]
    expect(siennes.map((d) => d.id)).toEqual([a.id])
    expect(siennes[0].affecteAId).toBe(conducteur.id)
    await agent.get(`/api/demandes-devis/${a.id}`).expect(200)
    await agent.get(`/api/demandes-devis/${b.id}`).expect(403)
    await agent.post(`/api/demandes-devis/${b.id}/ignorer`).expect(403)
    await agent.post(`/api/demandes-devis/${a.id}/boite`).send({ boite: 'Chantier' }).expect(403)
    expect((await agent.get('/api/demandes-devis/etat').expect(200)).body.data.mesDemandes).toBe(1)
    // Côté gestion : la rubrique de la personne
    expect((await adci.get(`/api/demandes-devis?dossier=pour:${conducteur.id}`).expect(200)).body.data.map((d: { id: string }) => d.id)).toEqual([a.id])

    // CRM : équipe, membres, charge
    await agent.get('/api/equipes').expect(403)
    const equipe = (await adci.post('/api/equipes').send({ nom: 'Couverture', couleur: 'green', membres: [conducteur.id] }).expect(201)).body.data
    expect(equipe).toMatchObject({ nom: 'Couverture', couleur: 'green', membres: [conducteur.id] })
    await adci.post('/api/equipes').send({ nom: 'Couverture' }).expect(409)
    const crm = (await adci.get('/api/equipes').expect(200)).body.data
    expect(crm.charge[conducteur.id]).toMatchObject({ aTraiter: 1, total: 1 })
    await adci.patch(`/api/equipes/${equipe.id}`).send({ membres: [] }).expect(200)
    await adci.delete(`/api/equipes/${equipe.id}`).expect(200)

    // Désaffectation
    await adci.post('/api/demandes-devis/affecter').send({ ids: [a.id], utilisateurId: null }).expect(200)
    expect(await prisma.demandeMail.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ affecteAId: null, affecteLe: null })
    await prisma.utilisateur.delete({ where: { id: conducteur.id } })
  })

  it('signale les demandes en retard et mesure le délai de traitement de chacun', async () => {
    const adciId = (await prisma.utilisateur.findFirstOrThrow({ where: { email: 'adci@test.local' } })).id
    const ilYa = (jours: number) => new Date(Date.now() - jours * 86_400_000)
    const creer = (objet: string, recuLe: Date, extra: Record<string, unknown> = {}) =>
      prisma.demandeMail.create({
        data: { messageId: `<${randomUUID()}@test>`, recuLe, expediteur: 'client@test.local', objet, corps: '', donnees: { demandeDevis: true }, anomalies: [], pieces: [], ...extra },
      })
    const ancienne = await creer('Demande de devis ancienne', ilYa(10))
    const recente = await creer('Demande de devis récente', new Date())
    // Pas une demande de devis, pas affectée : pas suivie
    const autre = await creer('Info chantier', ilYa(10), { donnees: {} })
    // Reçue un lundi à 9 h, traitée le mardi de la semaine suivante à 9 h : 6 jours ouvrés
    const lundi = ilYa(14)
    lundi.setUTCDate(lundi.getUTCDate() - ((lundi.getUTCDay() + 6) % 7))
    lundi.setUTCHours(9, 0, 0, 0)
    const mardi = new Date(lundi.getTime() + 8 * 86_400_000)
    await creer('Demande de devis traitée', lundi, { statut: 'DEVIS_CREE', traiteLe: mardi, traiteParId: adciId })

    const retard = (await adci.get('/api/demandes-devis?dossier=retard').expect(200)).body.data as { id: string; enRetard: boolean; delaiJours: number }[]
    const ids = retard.map((d) => d.id)
    expect(ids).toContain(ancienne.id)
    expect(ids).not.toContain(recente.id)
    expect(ids).not.toContain(autre.id)
    expect(retard.every((d) => d.enRetard)).toBe(true)
    expect(retard.find((d) => d.id === ancienne.id)!.delaiJours).toBeGreaterThanOrEqual(6)
    const detail = (await adci.get(`/api/demandes-devis/${recente.id}`).expect(200)).body.data
    expect(detail).toMatchObject({ enRetard: false })
    expect((await adci.get('/api/demandes-devis/etat').expect(200)).body.data).toMatchObject({ enRetard: ids.length, delaiJours: 2 })
    expect((await adci.get('/api/demandes-devis/dossiers').expect(200)).body.data.enRetard).toEqual({ mails: ids.length, aTraiter: ids.length })

    const crm = (await adci.get('/api/equipes').expect(200)).body.data
    expect(crm).toMatchObject({ enRetard: ids.length, traitees: 1, delaiJours: 2, periodeJours: 90 })
    expect(crm.charge[adciId]).toMatchObject({ traitees: 1 })
    expect(crm.charge[adciId].delaiMoyen).toBe(6)
    await prisma.demandeMail.deleteMany({ where: { objet: { in: ['Demande de devis ancienne', 'Demande de devis récente', 'Info chantier', 'Demande de devis traitée'] } } })
  })

  it('reporte sur le devis l’accord ou le refus du client lu dans son mail, sans remplacer une saisie à la main', async () => {
    const devis = await prisma.devis.create({
      data: { numero: 'DGD26-0850', categorie: 'COUVERTURE', clientId: 'c-foncia', adresse: '58 rue du Faubourg Saint-Denis 75010 Paris', descriptif: '', commentaires: '' },
    })
    const mail = (objet: string, corps: string, recuLe: string) =>
      prisma.demandeMail.create({
        data: { messageId: `<${randomUUID()}@test>`, recuLe: new Date(recuLe), expediteur: 'Jérôme <j.d@syndic.fr>', objet, corps, donnees: {}, anomalies: [], pieces: [] },
      })
    const accord = await mail('accord 58 rue du Faubourg St Denis', 'Nous avons l’accord sur votre devis n° DGD26-0850.', '2026-10-20')
    expect(await appliquerResultatDevis(accord.id)).toBe('DGD26-0850')
    let d = (await adci.get(`/api/devis/${devis.id}`).expect(200)).body.data
    expect(d).toMatchObject({ resultat: 'Accepté', resultatLe: '2026-10-20', resultatMailId: accord.id })
    // Le formulaire renvoie la même réponse : le lien au mail est gardé
    d = (await adci.patch(`/api/devis/${devis.id}`).send({ resultat: 'Accepté', commentaires: 'RAS' }).expect(200)).body.data
    expect(d).toMatchObject({ resultat: 'Accepté', resultatMailId: accord.id })
    // Un refus plus récent remplace une réponse lue dans un mail
    const refus = await mail('Re: DGD26-0850', 'Finalement, nous ne donnerons pas suite à ce devis.', '2026-10-25')
    await appliquerResultatDevis(refus.id)
    d = (await adci.get(`/api/devis/${devis.id}`).expect(200)).body.data
    expect(d).toMatchObject({ resultat: 'Refusé', resultatLe: '2026-10-25', motifRefus: 'Finalement, nous ne donnerons pas suite à ce devis.' })
    // Saisie à la main : prioritaire sur les mails
    d = (await adci.patch(`/api/devis/${devis.id}`).send({ resultat: 'Accepté', resultatLe: '2026-11-02' }).expect(200)).body.data
    expect(d).toMatchObject({ resultat: 'Accepté', resultatLe: '2026-11-02', motifRefus: null, resultatMailId: null })
    expect(await appliquerResultatDevis(refus.id)).toBeNull()
    await prisma.demandeMail.deleteMany({ where: { id: { in: [accord.id, refus.id] } } })
    await prisma.devis.delete({ where: { id: devis.id } })
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

describe('délais en jours ouvrés', () => {
  it('ne compte pas le week-end', () => {
    // Vendredi 12 h → lundi 12 h : 1 jour ouvré
    expect(joursOuvres(new Date('2026-11-13T12:00:00Z'), new Date('2026-11-16T12:00:00Z'))).toBe(1)
    expect(joursOuvres(new Date('2026-11-16T08:00:00Z'), new Date('2026-11-16T20:00:00Z'))).toBe(0.5)
  })
  it('place la limite du retard avant le week-end', () => {
    // Lundi 10 h, 2 jours ouvrés : jeudi 10 h
    expect(limiteRetard(new Date('2026-11-16T10:00:00Z'), 2).toISOString()).toBe('2026-11-12T10:00:00.000Z')
    // Samedi : le compte part de la fin du vendredi
    expect(limiteRetard(new Date('2026-11-14T10:00:00Z'), 2).toISOString()).toBe('2026-11-12T00:00:00.000Z')
  })
})

describe('objet normalisé', () => {
  it('retire les préfixes de réponse et de transfert, la casse et les accents', () => {
    expect(objetNormalise('TR: RE:Re : [EXT] Fwd: Dégât  des eaux')).toBe('degat des eaux')
    expect(objetNormalise('RE[2]: Devis')).toBe('devis')
  })
})
