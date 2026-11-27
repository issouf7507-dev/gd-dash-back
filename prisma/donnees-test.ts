// Données de test pour l'environnement LOCAL : techniciens, sous-traitants, devis et comptes de test.
// Relançable sans doublon. Tout est marqué « (test) » / DGD26-T… / *.test@gd.local pour être retiré d'un coup.
//   pnpm db:donnees-test             → crée ou met à jour les données de test
//   pnpm db:donnees-test --nettoyer  → les supprime
// Refuse de tourner sur une base qui n'est pas locale.
import { Categorie, Planification, Prisma, Role, StatutADCI, TypeIntervenant } from '../src/generated/prisma/client.ts'
import { hashPassword } from '../src/lib/password.ts'
import { prisma } from '../src/lib/prisma.ts'

/** Mot de passe des comptes de test (modifiable avec TEST_PASSWORD dans .env) */
const MOT_DE_PASSE = process.env.TEST_PASSWORD || 'Essai-Local-2026'

const TECHNICIENS: { nom: string; type: TypeIntervenant; specialites: string[]; telephone: string }[] = [
  { nom: 'Karim BENALI (test)', type: TypeIntervenant.INTERNE, specialites: ['Couverture'], telephone: '06 00 00 00 01' },
  { nom: 'Lucas MARTIN (test)', type: TypeIntervenant.INTERNE, specialites: ['Couverture', 'Étanchéité'], telephone: '06 00 00 00 02' },
  { nom: 'Moussa DIALLO (test)', type: TypeIntervenant.INTERNE, specialites: ['Plomberie'], telephone: '06 00 00 00 03' },
  { nom: 'Jean DUPUIS (test)', type: TypeIntervenant.INTERNE, specialites: ['Ravalement / Peinture'], telephone: '06 00 00 00 04' },
  { nom: 'Samir HADDAD (test)', type: TypeIntervenant.INTERNE, specialites: ['Couverture', 'Plomberie'], telephone: '06 00 00 00 05' },
  { nom: 'Toitures Express (test)', type: TypeIntervenant.SOUS_TRAITANT, specialites: ['Couverture'], telephone: '01 00 00 00 01' },
  { nom: 'Étanch’Pro (test)', type: TypeIntervenant.SOUS_TRAITANT, specialites: ['Étanchéité'], telephone: '01 00 00 00 02' },
  { nom: 'Plomberie Rapide (test)', type: TypeIntervenant.SOUS_TRAITANT, specialites: ['Plomberie'], telephone: '01 00 00 00 03' },
]

const COMPTES: { prenom: string; nom: string; email: string; role: Role }[] = [
  { prenom: 'Adci', nom: 'Test', email: 'adci.test@gd.local', role: Role.ADCI },
  { prenom: 'Conducteur', nom: 'Test', email: 'conducteur.test@gd.local', role: Role.CONDUCTEUR },
  { prenom: 'Direction', nom: 'Test', email: 'direction.test@gd.local', role: Role.DIRECTION },
]

const DEVIS: { numero: string; categorie: Categorie; adresse: string; descriptif: string }[] = [
  { numero: 'DGD26-T001', categorie: Categorie.COUVERTURE, adresse: '12 rue de Rennes, 75006 PARIS', descriptif: 'Recherche de fuite et remplacement de tuiles' },
  { numero: 'DGD26-T002', categorie: Categorie.PLOMBERIE, adresse: '5 avenue Foch, 75116 PARIS', descriptif: 'Remplacement d’une descente d’eaux pluviales' },
  { numero: 'DGD26-T003', categorie: Categorie.ETANCHEITE, adresse: '20 boulevard Haussmann, 75009 PARIS', descriptif: 'Réfection de l’étanchéité d’une terrasse' },
  { numero: 'DGD26-T004', categorie: Categorie.RAVALEMENT_PEINTURE, adresse: '8 rue Lepic, 75018 PARIS', descriptif: 'Ravalement de la courette' },
]

function verifierBaseLocale() {
  const url = process.env.DATABASE_URL ?? ''
  if (process.env.NODE_ENV === 'production' || !/@(127\.0\.0\.1|localhost)(:\d+)?\//.test(url))
    throw new Error('Données de test refusées : la base n’est pas locale (DATABASE_URL doit pointer sur localhost ou 127.0.0.1)')
}

async function nettoyer() {
  const devis = await prisma.devis.deleteMany({ where: { numero: { startsWith: 'DGD26-T' } } })
  const techniciens = await prisma.intervenant.deleteMany({ where: { nom: { endsWith: '(test)' } } })
  const comptes = await prisma.utilisateur.deleteMany({ where: { email: { endsWith: '.test@gd.local' } } })
  console.log(`Retirés : ${techniciens.count} techniciens, ${devis.count} devis, ${comptes.count} comptes de test`)
}

async function creer() {
  for (const t of TECHNICIENS) await prisma.intervenant.upsert({ where: { nom: t.nom }, create: t, update: t })

  const passwordHash = await hashPassword(MOT_DE_PASSE)
  for (const c of COMPTES)
    await prisma.utilisateur.upsert({
      where: { email: c.email },
      create: { ...c, passwordHash, actif: true, choixMotDePasse: false },
      // Pages remises sur celles du rôle à chaque lancement
      update: { passwordHash, actif: true, role: c.role, pages: Prisma.DbNull },
    })

  // Devis rattachés aux premiers clients de la base
  const clients = await prisma.client.findMany({ take: DEVIS.length, orderBy: { nom: 'asc' }, select: { id: true } })
  if (!clients.length) console.warn('Aucun client : devis de test non créés (importez d’abord la bibliothèque clients)')
  else
    for (const [k, d] of DEVIS.entries()) {
      const data = { ...d, clientId: clients[k % clients.length].id, commentaires: '', statutADCI: StatutADCI.VALIDE, planification: Planification.A_PLANIFIER }
      await prisma.devis.upsert({ where: { numero: d.numero }, create: data, update: data })
    }

  console.log(`Prêt : ${TECHNICIENS.length} techniciens et sous-traitants, ${clients.length ? DEVIS.length : 0} devis, ${COMPTES.length} comptes de test`)
  console.log(`Comptes : ${COMPTES.map((c) => `${c.email} (${c.role})`).join(', ')} — mot de passe : voir prisma/donnees-test.ts (ou TEST_PASSWORD)`)
}

verifierBaseLocale()
await (process.argv.includes('--nettoyer') ? nettoyer() : creer())
await prisma.$disconnect()
