// Import des bibliothèques Excel (clients, fournisseurs) sur la base gd_test.
import { crc32, deflateRawSync } from 'node:zlib'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../app.ts'
import { Role, TypeClient } from '../../generated/prisma/client.ts'
import { hashPassword } from '../../lib/password.ts'
import { prisma } from '../../lib/prisma.ts'
import { lireXlsx } from '../../lib/xlsx.ts'

if (!process.env.DATABASE_URL?.includes('/gd_test')) throw new Error('Les tests doivent tourner sur la base gd_test')

const app = createApp()
const PASSWORD = 'MotDePasse-Test-123'
let adci: ReturnType<typeof request.agent>
let conducteur: ReturnType<typeof request.agent>

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Petit classeur .xlsx : textes en chaînes partagées, sauf les nombres */
function classeur(lignes: (string | number)[][]): Buffer {
  const partages: string[] = []
  const cellules = lignes
    .map((l, i) => {
      const cs = l
        .map((v, j) => {
          const ref = `${String.fromCharCode(65 + j)}${i + 1}`
          if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`
          partages.push(v)
          return `<c r="${ref}" t="s"><v>${partages.length - 1}</v></c>`
        })
        .join('')
      return `<row r="${i + 1}">${cs}</row>`
    })
    .join('')
  const fichiers: Record<string, string> = {
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Export" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst>${partages.map((s) => `<si><t xml:space="preserve">${xml(s)}</t></si>`).join('')}</sst>`,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${cellules}</sheetData></worksheet>`,
  }
  // Archive zip minimale (méthode deflate)
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

const CLIENTS = classeur([
  ['Code', 'Raison Sociale', 'Famille', 'Email', 'Adresse', 'C.P', 'Commune'],
  ['CLT00109', 'IMPERIAL GESTION', 'Organismes et syndicats', 'ma.delausay@imperial-gestion.com', '137 Boulevard Pereire,', 75017, 'PARIS'],
  ['CLT00200', 'CABINET NEXITY', 'Organismes et syndicats', '', '10 rue A', 75008, 'PARIS'],
  ['CLT00201', 'CABINET NEXITY', 'Organismes et syndicats', '', '5 avenue B', 92200, 'NEUILLY'],
  ['CLT00300', 'Bureaux Tertio', 'Tertiaire', 'a@b.fr ; c@d.fr', 'AGENCE IDF_x000D_\n6 bd X', 1000, 'BOURG'],
  ['CLT00301', 'M. Dupont', 'Particuliers', 'pas un mail', '', '', ''],
  ['CLT00109', 'DOUBLON DE CODE', '', '', '', '', ''],
  ['CLT00400', '', 'Tertiaire', '', '', '', ''],
  ['NOCODE', 'atrium gestion', 'Organismes et syndicats', '', '1 place C', 75001, 'PARIS'],
])

beforeAll(async () => {
  await prisma.importMail.deleteMany()
  await prisma.intervention.deleteMany()
  await prisma.devis.deleteMany()
  await prisma.client.deleteMany()
  await prisma.fournisseur.deleteMany()
  await prisma.utilisateur.deleteMany()
  const passwordHash = await hashPassword(PASSWORD)
  await prisma.utilisateur.create({ data: { prenom: 'Kassa', nom: 'ADCI', email: 'adci@test.local', role: Role.ADCI, passwordHash } })
  await prisma.utilisateur.create({ data: { prenom: 'Nuno', nom: 'BRANCO', email: 'conducteur@test.local', role: Role.CONDUCTEUR, passwordHash } })
  // Client déjà saisi à la main, sans code : il sera complété, pas recréé
  await prisma.client.create({ data: { nom: 'ATRIUM GESTION', type: TypeClient.SYNDIC, email: 'contact@atrium.fr' } })
  adci = request.agent(app)
  await adci.post('/api/auth/login').send({ email: 'adci@test.local', password: PASSWORD }).expect(200)
  conducteur = request.agent(app)
  await conducteur.post('/api/auth/login').send({ email: 'conducteur@test.local', password: PASSWORD }).expect(200)
})

afterAll(() => prisma.$disconnect())

const envoyer = (agent: ReturnType<typeof request.agent>, chemin: string, fichier: Buffer) =>
  agent.post(chemin).set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(fichier)

describe('lecture xlsx', () => {
  it('lit la première feuille, chaînes partagées et nombres', () => {
    const l = lireXlsx(classeur([['A', 'B'], [12, 'x & y']]))
    expect(l).toEqual([
      { numero: 1, cellules: ['A', 'B'] },
      { numero: 2, cellules: ['12', 'x & y'] },
    ])
  })
})

describe('import des clients', () => {
  it('refuse les rôles sans droit d’écriture et les fichiers qui ne sont pas des .xlsx', async () => {
    expect((await envoyer(conducteur, '/api/clients/import?simulation=1', CLIENTS)).status).toBe(403)
    const r = await envoyer(adci, '/api/clients/import?simulation=1', Buffer.from('Code;Nom\n1;A'))
    expect(r.status).toBe(400)
    expect(r.body.error.message).toMatch(/xlsx/)
  })

  it('simulation : décrit l’import sans rien écrire', async () => {
    const r = await envoyer(adci, '/api/clients/import?simulation=1', CLIENTS).expect(200)
    expect(r.body.data).toMatchObject({ simulation: true, total: 8, crees: 5, misAJour: 1, inchanges: 0, ignores: 2 })
    expect(r.body.data.renommes).toEqual([{ ligne: 4, avant: 'CABINET NEXITY', apres: 'CABINET NEXITY – NEUILLY' }])
    expect(r.body.data.erreurs.map((e: { ligne: number }) => e.ligne)).toEqual([7, 8])
    expect(await prisma.client.count()).toBe(1)
  })

  it('import : crée, complète, déduit le type et nettoie les valeurs', async () => {
    const r = await envoyer(adci, '/api/clients/import', CLIENTS).expect(200)
    expect(r.body.data).toMatchObject({ simulation: false, crees: 5, misAJour: 1 })
    const parCode = async (code: string) => prisma.client.findUniqueOrThrow({ where: { code } })
    expect(await parCode('CLT00109')).toMatchObject({
      nom: 'IMPERIAL GESTION',
      type: TypeClient.SYNDIC,
      email: 'ma.delausay@imperial-gestion.com',
      adresse: '137 Boulevard Pereire',
      codePostal: '75017',
      ville: 'PARIS',
    })
    expect(await parCode('CLT00300')).toMatchObject({ type: TypeClient.ENTREPRISE, email: 'a@b.fr', adresse: 'AGENCE IDF, 6 bd X', codePostal: '01000' })
    expect(await parCode('CLT00301')).toMatchObject({ type: TypeClient.PARTICULIER, email: null })
    expect((await parCode('CLT00201')).nom).toBe('CABINET NEXITY – NEUILLY')
    // Le client saisi à la main garde son nom et son email, et reçoit code et adresse
    expect(await parCode('NOCODE')).toMatchObject({ nom: 'ATRIUM GESTION', email: 'contact@atrium.fr', adresse: '1 place C', ville: 'PARIS' })
    const liste = (await adci.get('/api/clients').expect(200)).body.data
    expect(liste.find((c: { code: string }) => c.code === 'CLT00109')).toMatchObject({ ville: 'PARIS', famille: 'Organismes et syndicats' })
  })

  it('réimport du même fichier : rien à créer, tout est à jour', async () => {
    const r = await envoyer(adci, '/api/clients/import', CLIENTS).expect(200)
    expect(r.body.data).toMatchObject({ crees: 0, misAJour: 0, inchanges: 6 })
    expect(await prisma.client.count()).toBe(6)
  })
})

describe('fournisseurs', () => {
  const FOURNISSEURS = classeur([
    ['Code', 'Raison Sociale', 'Famille', 'Adresse', 'C.P', 'Commune'],
    ['001DIAG', 'L3A DIAG', 'SERVICE', '23 rue des Garmants', 92240, 'MALAKOFF'],
    ['PUM1', 'PUM PLASTIQUES', 'DISTRIBUTEUR', '1 rue A', 93000, 'BOBIGNY'],
    ['PUM2', 'PUM PLASTIQUES', 'DISTRIBUTEUR', '2 rue B', 94000, 'CRETEIL'],
  ])

  it('importe la bibliothèque (noms en double permis) puis la liste', async () => {
    const r = await envoyer(adci, '/api/fournisseurs/import', FOURNISSEURS).expect(200)
    expect(r.body.data).toMatchObject({ crees: 3, renommes: [] })
    const liste = (await conducteur.get('/api/fournisseurs').expect(200)).body.data
    expect(liste).toHaveLength(3)
    expect(liste[0]).toMatchObject({ code: '001DIAG', nom: 'L3A DIAG', famille: 'SERVICE', codePostal: '92240', ville: 'MALAKOFF' })
  })

  it('création, modification, code unique, suppression', async () => {
    const f = (await adci.post('/api/fournisseurs').send({ nom: 'Négoce Test', code: 'NEG1', famille: 'NEGOCE MATERIAUX' }).expect(201)).body.data
    expect((await adci.post('/api/fournisseurs').send({ nom: 'Autre', code: 'NEG1' })).status).toBe(409)
    expect((await adci.patch(`/api/fournisseurs/${f.id}`).send({ ville: 'PARIS', email: 'NEG@test.fr' }).expect(200)).body.data).toMatchObject({
      ville: 'PARIS',
      email: 'neg@test.fr',
      famille: 'NEGOCE MATERIAUX',
    })
    expect((await conducteur.post('/api/fournisseurs').send({ nom: 'X' })).status).toBe(403)
    expect((await adci.delete(`/api/fournisseurs/${f.id}`)).status).toBe(403)
  })
})
