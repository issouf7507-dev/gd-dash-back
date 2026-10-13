import { describe, expect, it } from 'vitest'
import { texteFormatRecommande } from './exemples.ts'
import { detecterCategorie, extraire, lireFiche, parseDate, parseMontant, type MailLu } from './extract.ts'
import { normaliserNom, rapprocherClient } from './match-client.ts'

const mail = (p: Partial<MailLu>): MailLu => ({
  objet: '',
  corps: '',
  textePdf: '',
  expediteur: { nom: 'SolutionsBTP', email: 'noreply@solutionsbtp.fr' },
  destinataires: [],
  date: new Date('2026-10-09T10:00:00Z'),
  ...p,
})

describe('parseMontant', () => {
  it.each([
    ['4 250,00 €', 4250],
    ['4.250,50', 4250.5],
    ['4250.5', 4250.5],
    ['12 345,6 €', 12345.6],
    ['1 000', 1000],
    ['€', null],
  ])('%s → %s', (s, attendu) => expect(parseMontant(s)).toBe(attendu))
})

describe('parseDate', () => {
  it.each([
    ['Date : 09/10/2026', '2026-10-09'],
    ['9-10-26', '2026-10-09'],
    ['le 1er octobre 2026', '2026-10-01'],
    ['le 3 fevrier 2026', '2026-02-03'],
    ['32/13/2026', null],
  ])('%s → %s', (s, attendu) => expect(parseDate(s)).toBe(attendu))
})

describe('detecterCategorie', () => {
  it('reconnaît le métier dominant', () => {
    expect(detecterCategorie('Réfection couverture zinc, gouttières')).toEqual({ categorie: 'Couverture', incertaine: false })
    expect(detecterCategorie('Recherche de fuite, canalisation')).toEqual({ categorie: 'Plomberie', incertaine: false })
  })
  it('signale un seul indice ou une égalité', () => {
    expect(detecterCategorie('Reprise de la terrasse').incertaine).toBe(true)
    expect(detecterCategorie('fuite toiture').incertaine).toBe(true)
    expect(detecterCategorie('Travaux divers')).toEqual({ categorie: null, incertaine: true })
  })
})

describe('extraire', () => {
  it('lit numéro, client, adresse sur deux lignes, objet et total HT', () => {
    const r = extraire(
      mail({
        objet: 'Devis DGD26-0931 - CAB. PREVIMMO',
        textePdf: [
          'DEVIS N° DGD26-0931',
          'Date : 08/10/2026',
          'Client : CAB. PREVIMMO',
          'Adresse du chantier : 12 rue de Rivoli',
          '75004 PARIS',
          'Objet : Réfection couverture zinc',
          'Total HT 4 250,00 €',
          'Total TTC 4 675,00 €',
        ].join('\n'),
      }),
    )
    expect(r.estUnDevis).toBe(true)
    expect(r.champs).toMatchObject({
      numero: 'DGD26-0931',
      dateReception: '2026-10-08',
      clientNom: 'CAB. PREVIMMO',
      adresse: '12 rue de Rivoli 75004 PARIS',
      descriptif: 'Réfection couverture zinc',
      categorie: 'Couverture',
      montantHT: 4250,
    })
  })

  it('prend la date du mail et le destinataire quand le PDF ne les donne pas', () => {
    const r = extraire(mail({ objet: 'Votre devis DGD26-0001', destinataires: [{ nom: 'SDC Rivoli', email: 'sdc@rivoli.example' }] }))
    expect(r.champs).toMatchObject({ numero: 'DGD26-0001', dateReception: '2026-10-09', clientNom: 'SDC Rivoli', clientEmail: 'sdc@rivoli.example' })
  })

  it("ne prend pas un mail qui n'est pas un devis", () => {
    expect(extraire(mail({ objet: 'Votre mot de passe expire', corps: 'Bonjour' })).estUnDevis).toBe(false)
  })
})

describe('format recommandé (fiche en bas du mail)', () => {
  it('lit la fiche en priorité sur le PDF', () => {
    const r = extraire(
      mail({
        objet: 'Devis n° DGD26-0933 - SDC 164',
        corps: texteFormatRecommande({
          numero: 'DGD26-0933',
          date: '08/10/2026',
          client: 'SDC 164',
          adresse: '164 rue du Faubourg Saint-Antoine, 75012 Paris',
          objet: 'Peinture cage d’escalier',
          montantHT: '1 200,50 €',
          metier: 'Ravalement / Peinture',
          conducteur: 'Christian FUANANA',
        }),
        textePdf: 'Client : AUTRE NOM\nTotal HT 9 999,00 €',
      }),
    )
    expect(r.champs).toMatchObject({
      numero: 'DGD26-0933',
      dateReception: '2026-10-08',
      clientNom: 'SDC 164',
      adresse: '164 rue du Faubourg Saint-Antoine, 75012 Paris',
      descriptif: 'Peinture cage d’escalier',
      montantHT: 1200.5,
      categorie: 'Ravalement / Peinture',
      categorieIncertaine: false,
      conducteurNom: 'Christian FUANANA',
      ficheTrouvee: true,
    })
  })
  it('accepte les variantes d’étiquettes', () => {
    expect(lireFiche('N° devis : X1\nAdresse du chantier : 1 rue A 75001 Paris\nMontant total HT : 10\nSuivi par : Nuno')).toEqual({
      numero: 'X1',
      adresse: '1 rue A 75001 Paris',
      montant: '10',
      conducteur: 'Nuno',
    })
  })
})

describe('rapprocherClient', () => {
  const clients = [
    { id: 'c1', nom: 'CAB. PREVIMMO', email: null },
    { id: 'c2', nom: 'Cabinet Lefèvre', email: 'contact@lefevre.example' },
  ]
  it('normalise les noms', () => expect(normaliserNom('  Cabinet  Lefèvre ')).toBe('cab lefevre'))
  it('email identique → sûr', () => expect(rapprocherClient(clients, 'Autre nom', 'CONTACT@lefevre.example')).toEqual({ clientId: 'c2', confiance: 'sûr' }))
  it('nom identique après normalisation → sûr', () => expect(rapprocherClient(clients, 'Cab Previmmo', null)).toEqual({ clientId: 'c1', confiance: 'sûr' }))
  it('nom contenu → proche', () => expect(rapprocherClient(clients, 'PREVIMMO', null)).toEqual({ clientId: 'c1', confiance: 'proche' }))
  it('faute de frappe → proche', () =>
    expect(rapprocherClient([{ id: 'c100', nom: 'SDC 164 FAUBOURT SAINT-ANTOINE', email: null }], 'SDC 164 FAUBOURG SAINT-ANTOINE', null)).toEqual({
      clientId: 'c100',
      confiance: 'proche',
    }))
  it('nom seulement voisin → aucun', () => expect(rapprocherClient([{ id: 'x', nom: 'SDC 12 RUE DE PARIS', email: null }], 'SDC 14 RUE DE LYON', null).confiance).toBe('aucun'))
  it('inconnu → aucun', () => expect(rapprocherClient(clients, 'Mme Durand', null)).toEqual({ clientId: null, confiance: 'aucun' }))
})
