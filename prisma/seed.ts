// Données de départ : compte administrateur + collaborateurs GD.
// Relançable sans doublon (upsert sur l'email). Le mot de passe admin vient de server/.env (SEED_ADMIN_PASSWORD).
import { hashPassword, PASSWORD_RULE, PASSWORD_RULE_MESSAGE } from '../src/lib/password.ts'
import { prisma } from '../src/lib/prisma.ts'
import { Role } from '../src/generated/prisma/client.ts'

const COLLABORATEURS: { prenom: string; nom: string; email: string; role: Role }[] = [
  { prenom: 'Direction', nom: 'GD', email: 'direction@gdcouverture.fr', role: Role.DIRECTION },
  { prenom: 'Davis', nom: 'TOURE', email: 'd.toure@gdcouverture.fr', role: Role.CHARGE_AFFAIRES },
  { prenom: 'Mahamadou', nom: 'TRAORE', email: 'm.traore@gdcouverture.fr', role: Role.CHARGE_AFFAIRES },
  { prenom: 'Nuno', nom: 'BRANCO', email: 'n.branco@gdcouverture.fr', role: Role.CONDUCTEUR },
  { prenom: 'Christian', nom: 'FUANANA', email: 'c.fuanana@gdcouverture.fr', role: Role.CONDUCTEUR },
  { prenom: 'Hamady', nom: '', email: 'hamady@gdcouverture.fr', role: Role.CONDUCTEUR },
  { prenom: 'Raïssa', nom: '', email: 'raissa@gdcouverture.fr', role: Role.CONDUCTEUR },
  { prenom: 'Dimitri', nom: '', email: 'dimitri@gdcouverture.fr', role: Role.CONDUCTEUR },
  { prenom: 'Kassa', nom: '', email: 'kassa@gdcouverture.fr', role: Role.ADCI },
  { prenom: 'Gbessi', nom: '', email: 'gbessi@gdcouverture.fr', role: Role.ADCI },
]

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase()
  const password = process.env.SEED_ADMIN_PASSWORD
  if (!email || !password || password === 'CHANGER_MOI') {
    throw new Error('Renseignez SEED_ADMIN_EMAIL et SEED_ADMIN_PASSWORD dans server/.env')
  }
  if (!PASSWORD_RULE.test(password)) throw new Error(`SEED_ADMIN_PASSWORD : ${PASSWORD_RULE_MESSAGE}`)

  const passwordHash = await hashPassword(password)
  await prisma.utilisateur.upsert({
    where: { email },
    create: { prenom: 'Admin', nom: 'GD', email, role: Role.ADMIN, passwordHash },
    // Le mot de passe admin suit toujours server/.env (pratique en développement)
    update: { role: Role.ADMIN, actif: true, passwordHash },
  })
  console.log(`✔ Administrateur : ${email} (mot de passe : SEED_ADMIN_PASSWORD dans server/.env)`)

  for (const c of COLLABORATEURS) {
    // Sans mot de passe : ils ne peuvent pas se connecter tant qu'un admin ne leur en a pas défini un
    await prisma.utilisateur.upsert({ where: { email: c.email }, create: c, update: {} })
  }
  console.log(`✔ ${COLLABORATEURS.length} collaborateurs (sans mot de passe)`)
}

main()
  .catch((err) => {
    console.error('✘ Seed :', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
