// Tableau de bord de gestion (API /gestion) et calculs, sur la base gd_test.
import { calculerTableauDeBord, exerciceVide, type ExerciceGestion } from '@gd/shared/gestion'
import { crc32, deflateRawSync } from 'node:zlib'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.ts'
import { Role } from '../../generated/prisma/client.ts'
import { hashPassword } from '../../lib/password.ts'
import { prisma } from '../../lib/prisma.ts'

if (!process.env.DATABASE_URL?.includes('/gd_test')) throw new Error('Les tests doivent tourner sur la base gd_test')

const app = createApp()
const PASSWORD = 'MotDePasse-Test-123'
let direction: ReturnType<typeof request.agent>
let adci: ReturnType<typeof request.agent>

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const lettre = (j: number) => (j < 26 ? String.fromCharCode(65 + j) : String.fromCharCode(64 + Math.floor(j / 26)) + String.fromCharCode(65 + (j % 26)))

/** Classeur .xlsx de plusieurs feuilles : { nom: lignes (null = cellule vide) } */
function classeur(feuilles: Record<string, (string | number | null)[][]>): Buffer {
  const partages: string[] = []
  const fichiers: Record<string, string> = {}
  const noms = Object.keys(feuilles)
  noms.forEach((nom, k) => {
    const lignes = feuilles[nom]
      .map((l, i) => {
        const cs = l
          .map((v, j) => {
            const ref = `${lettre(j)}${i + 1}`
            if (v === null) return ''
            if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`
            partages.push(v)
            return `<c r="${ref}" t="s"><v>${partages.length - 1}</v></c>`
          })
          .join('')
        return `<row r="${i + 1}">${cs}</row>`
      })
      .join('')
    fichiers[`xl/worksheets/sheet${k + 1}.xml`] = `<worksheet><sheetData>${lignes}</sheetData></worksheet>`
  })
  fichiers['xl/workbook.xml'] = `<workbook xmlns:r="r"><sheets>${noms.map((n, k) => `<sheet name="${xml(n)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join('')}</sheets></workbook>`
  fichiers['xl/_rels/workbook.xml.rels'] = `<Relationships>${noms.map((_, k) => `<Relationship Id="rId${k + 1}" Type="worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join('')}</Relationships>`
  fichiers['xl/sharedStrings.xml'] = `<sst>${partages.map((s) => `<si><t xml:space="preserve">${xml(s)}</t></si>`).join('')}</sst>`
  const locaux: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [nom, contenu] of Object.entries(fichiers)) {
    const brut = Buffer.from(contenu)
    const comp = deflateRawSync(brut)
    const n = Buffer.from(nom)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(brut), 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(brut.length, 22)
    local.writeUInt16LE(n.length, 26)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(8, 10)
    c.writeUInt32LE(crc32(brut), 16)
    c.writeUInt32LE(comp.length, 20)
    c.writeUInt32LE(brut.length, 24)
    c.writeUInt16LE(n.length, 28)
    c.writeUInt32LE(offset, 42)
    locaux.push(local, n, comp)
    central.push(c, n)
    offset += 30 + n.length + comp.length
  }
  const rep = Buffer.concat(central)
  const fin = Buffer.alloc(22)
  fin.writeUInt32LE(0x06054b50, 0)
  fin.writeUInt16LE(Object.keys(fichiers).length, 8)
  fin.writeUInt16LE(Object.keys(fichiers).length, 10)
  fin.writeUInt32LE(rep.length, 12)
  fin.writeUInt32LE(offset, 16)
  return Buffer.concat([...locaux, rep, fin])
}

const douzeFois = (v: number | null) => Array.from({ length: 12 }, () => v)
const ligne = (libelle: string, valeurs: (number | null)[]) => [libelle, null, ...valeurs]

/** Classeur minimal au format du tableau de bord : 2 mois suivis */
const CLASSEUR = classeur({
  'Prévisions ': [
    [null, null, null, null, null, null, null, null, null, null, null, 'Cellules à saisir ----->', null, 2027],
    ['Libellés', 'Total An', 'Janv.'],
    ligne('Nbre jours ouvrables', douzeFois(20)),
    ligne('Nbre de jours de fermeture', douzeFois(0)),
    ligne('Jours de congés payés', douzeFois(0)),
    ligne('Effectif Entreprise', douzeFois(10)),
    ligne('Apprentis', douzeFois(0)),
    ligne('Intérimaires', douzeFois(0)),
    ligne('Horaire Jour', douzeFois(7)),
    ligne('Absentéisme en %', douzeFois(0)),
    ligne('Intempéries en Jours', douzeFois(0)),
    ligne('% effectif en intempéries', douzeFois(0)),
    ligne('Formations en Heure', douzeFois(0)),
    ligne("Travaux pour l'ent. en H", douzeFois(0)),
    ligne('Autres H non vendables', douzeFois(0)),
    ligne('604000000 Achats d’études', douzeFois(1000)),
    ligne('606130000 Carburant', douzeFois(500)),
    [null, 'SHM chargé', 30, null, null, "% Main d'Oeuvre / CD", null, null, 0.5, 600000, null, 'C.A / an', 2000000],
    [null, null, null, null, null, '% Matériaux / CD', null, null, 0.2, 240000],
    [null, null, null, null, null, '% Autres Frais / CD', null, null, 0.1, 120000],
    [null, null, null, null, null, '% Sous Traitants / CD', null, null, 0.2, 240000],
  ],
  Suivi: [
    ligne('Heures Payées', [1400, 1400, ...douzeFois(null).slice(2)]),
    ligne('604000000 Achats d’études', [900, 1100, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]),
  ],
  'SAISIE DE DONNES': [
    ['Libellés', 'Total', 'Janvier'],
    ligne('Chiffre Affaire', [150000, 170000, ...douzeFois(null).slice(2)]),
    ligne('Coût Matériaux', [20000, 25000, ...douzeFois(null).slice(2)]),
  ],
  'Suivi salaire': [
    [null, null, null, null, 'JANVIER', null, null, 'FEVRIER', null, null, 'MARS', null, null, 'AVRIL', null, null, 'MAI', null, null, 'JUIN', null, null, 'JUILLET', null, null, 'AOÛT', null, null, 'SEPTEMBRE', null, null, 'OCTOBRE', null, null, 'NOVEMBRE', null, null, 'DÉCEMBRE'],
    ['PRODUCTION'],
    ['DUPONT JEAN', null, null, null, 2000, 1000, 140, 2000, 1000, 140],
    [],
  ],
})

beforeAll(async () => {
  await prisma.exerciceGestion.deleteMany()
  await prisma.utilisateur.deleteMany({ where: { email: { in: ['direction-gestion@test.local', 'adci-gestion@test.local'] } } })
  const passwordHash = await hashPassword(PASSWORD)
  await prisma.utilisateur.create({ data: { prenom: 'Dir', nom: 'Gestion', email: 'direction-gestion@test.local', role: Role.DIRECTION, passwordHash } })
  await prisma.utilisateur.create({ data: { prenom: 'Kassa', nom: 'Adci', email: 'adci-gestion@test.local', role: Role.ADCI, passwordHash } })
  direction = request.agent(app)
  await direction.post('/api/auth/login').send({ email: 'direction-gestion@test.local', password: PASSWORD }).expect(200)
  adci = request.agent(app)
  await adci.post('/api/auth/login').send({ email: 'adci-gestion@test.local', password: PASSWORD }).expect(200)
})

afterAll(() => prisma.$disconnect())

describe('calculs du tableau de bord', () => {
  it('prévu : heures vendables, CA horaire, coûts directs et seuil de rentabilité', () => {
    const ex: ExerciceGestion = exerciceVide(2030)
    ex.parametres = { caAnnuel: 1_200_000, shmPrevu: 30, coutsDirects: { mainOeuvre: 500, materiaux: 200, autresFrais: 100, sousTraitance: 200 }, moisSuivis: 0 }
    ex.previsions = ex.previsions.map((p) => ({ ...p, joursOuvrables: 20, effectif: 5, horaireJour: 8 }))
    ex.fraisGeneraux = [{ compte: '1', libelle: 'Loyer', prevu: douzeFois(10_000) as number[], realise: douzeFois(null) }]
    const t = calculerTableauDeBord(ex)
    // 20 j × 5 personnes × 8 h = 800 h par mois
    expect(t.prevu.heuresVendables).toBe(9600)
    expect(t.prevu.caHoraire).toBe(125)
    const a = t.prevu.annee
    expect(a.mainOeuvre).toBe(9600 * 30)
    // Coûts directs proportionnels à la main-d'œuvre : MO = 50 % → matériaux = 40 % de la MO
    expect(a.materiaux).toBeCloseTo(9600 * 30 * 0.4)
    expect(a.coutsDirects).toBeCloseTo(9600 * 30 * 2)
    expect(a.fraisGeneraux).toBe(120_000)
    expect(a.margeBrute).toBeCloseTo(1_200_000 - 576_000)
    expect(a.seuilRentabilite).toBeCloseTo(120_000 / (624_000 / 1_200_000))
  })

  it('actualisé : le réalisé saisi remplace la prévision ; frais généraux vides = 0 sur un mois suivi', () => {
    const ex: ExerciceGestion = exerciceVide(2030)
    ex.parametres.moisSuivis = 1
    ex.fraisGeneraux = [{ compte: '1', libelle: 'Loyer', prevu: douzeFois(100) as number[], realise: douzeFois(null) }]
    ex.realise[0].ca = 5000
    const t = calculerTableauDeBord(ex)
    expect(t.actualise.mois[0].ca).toBe(5000)
    expect(t.actualise.mois[0].fraisGeneraux).toBe(0)
    expect(t.actualise.mois[1].fraisGeneraux).toBe(100)
  })
})

describe('API /gestion', () => {
  it('réservée à la Direction et à l’Admin', async () => {
    expect((await adci.get('/api/gestion/exercices')).status).toBe(403)
    expect((await direction.get('/api/gestion/exercices')).status).toBe(200)
  })

  it('import du classeur : simulation, puis écriture avec l’année du classeur', async () => {
    const envoi = (q: string) => direction.post(`/api/gestion/import${q}`).set('Content-Type', 'application/octet-stream').send(CLASSEUR)
    const sim = await envoi('?simulation=1').expect(200)
    expect(sim.body.data).toMatchObject({ simulation: true, remplace: false, annee: 2027, caAnnuelPrevu: 2_000_000, moisSuivis: 2, caRealise: 320_000, comptes: 2, salaries: 1 })
    expect(await prisma.exerciceGestion.count()).toBe(0)

    await envoi('').expect(200)
    const ex = (await direction.get('/api/gestion/exercices/2027').expect(200)).body.data as ExerciceGestion
    expect(ex.parametres).toMatchObject({ caAnnuel: 2_000_000, shmPrevu: 30, moisSuivis: 2, coutsDirects: { mainOeuvre: 600_000 } })
    expect(ex.realise[1]).toMatchObject({ ca: 170_000, materiaux: 25_000 })
    expect(ex.fraisGeneraux.find((c) => c.compte === '604000000')?.realise.slice(0, 2)).toEqual([900, 1100])
    // Carburant absent du Suivi : 0 au réalisé
    expect(ex.fraisGeneraux.find((c) => c.compte === '606130000')?.realise[0]).toBe(0)
    expect(ex.salaires[0]).toMatchObject({ nom: 'DUPONT JEAN', type: 'Production' })
    expect(ex.salaires[0].brut.slice(0, 2)).toEqual([2000, 2000])
    expect(ex.salaires[0].heures[0]).toBe(140)
    // Heures payées du Suivi (1400) ≠ heures des salaires (140) : reprises telles quelles
    expect(ex.realise[0].heuresPayees).toBe(1400)

    const t = calculerTableauDeBord(ex)
    expect(t.actualise.mois[0]).toMatchObject({ ca: 150_000, materiaux: 20_000, mainOeuvre: 3000, fraisGeneraux: 900 })
  })

  it('nouvelle année reprise de la précédente, modification, suppression', async () => {
    const e = (await direction.post('/api/gestion/exercices').send({ annee: 2028, depuis: 2027 }).expect(201)).body.data as ExerciceGestion
    expect(e.parametres).toMatchObject({ caAnnuel: 2_000_000, moisSuivis: 0 })
    expect(e.fraisGeneraux[0].realise).toEqual(douzeFois(null))
    expect(e.salaires[0].brut).toEqual(douzeFois(null))
    expect((await direction.post('/api/gestion/exercices').send({ annee: 2028 })).status).toBe(409)

    const realise = e.realise.map((r, i) => (i === 0 ? { ...r, ca: 99_000 } : r))
    const maj = (await direction.patch('/api/gestion/exercices/2028').send({ realise, parametres: { ...e.parametres, moisSuivis: 1 } }).expect(200)).body.data
    expect(maj.realise[0].ca).toBe(99_000)
    expect(maj.parametres.moisSuivis).toBe(1)
    expect(maj.modifiePar).toBe('Dir Gestion')
    expect((await direction.patch('/api/gestion/exercices/2028').send({ realise: realise.slice(0, 3) })).status).toBe(400)

    await direction.delete('/api/gestion/exercices/2028').expect(200)
    expect((await direction.get('/api/gestion/exercices/2028')).status).toBe(404)
  })
})
