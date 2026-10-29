// Calendrier des relances proposées (R1 à J+7, R2 à J+15, R3 à J+30), sans base de données.
import { relanceDue } from '@gd/shared/calculs'
import type { Facture, Relance } from '@gd/shared/types'
import { describe, expect, it } from 'vitest'

// Échéance au 2026-10-01 (facture du 16/09, 15 jours)
const facture = (relances: Partial<Relance>[] = [], f: Partial<Facture> = {}): Facture => ({
  id: 'f1',
  numero: 'F1',
  chantierId: 'c1',
  situation: 'Acompte',
  dateFacture: '2026-09-16',
  montantTTC: 1000,
  delaiPaiementJours: 15,
  statut: 'Validée',
  reglements: [],
  relances: relances.map((r, i) => ({
    id: `r${i}`,
    date: '2026-10-01',
    niveau: 'R1',
    destinataire: 'client',
    auteur: 'A',
    email: 'a@b.fr',
    statutEnvoi: 'envoyé',
    erreur: null,
    ...r,
  })),
  ...f,
})

describe('relanceDue', () => {
  it('rien avant J+7, puis R1, R2, R3 selon le retard', () => {
    expect(relanceDue(facture(), '2026-10-07')).toBeNull()
    expect(relanceDue(facture(), '2026-10-08')).toBe('R1')
    expect(relanceDue(facture(), '2026-10-16')).toBe('R2')
    expect(relanceDue(facture(), '2026-10-31')).toBe('R3')
  })

  it('ne repropose pas un niveau déjà envoyé, ni une relance moins d’une semaine après la précédente', () => {
    expect(relanceDue(facture([{ niveau: 'R1', date: '2026-10-08' }]), '2026-10-12')).toBeNull()
    expect(relanceDue(facture([{ niveau: 'R1', date: '2026-10-10' }]), '2026-10-16')).toBeNull()
    expect(relanceDue(facture([{ niveau: 'R1', date: '2026-10-08' }]), '2026-10-16')).toBe('R2')
    expect(relanceDue(facture([{ niveau: 'MD', date: '2026-10-08' }]), '2026-11-30')).toBeNull()
  })

  it('un envoi en échec ne compte pas', () => {
    expect(relanceDue(facture([{ niveau: 'R1', date: '2026-10-08', statutEnvoi: 'échec' }]), '2026-10-09')).toBe('R1')
  })

  it('rien pour une facture réglée ou à valider', () => {
    expect(relanceDue(facture([], { reglements: [{ id: 'g', date: '2026-10-02', montant: 1000, mode: 'Virement' }] }), '2026-10-20')).toBeNull()
    expect(relanceDue(facture([], { statut: 'À valider' }), '2026-10-20')).toBeNull()
  })
})
