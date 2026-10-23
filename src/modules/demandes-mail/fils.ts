// Fils de discussion des demandes reçues : un mail est rattaché automatiquement aux mails déjà reçus qui lui sont liés
// (réponse ou transfert, même référence client, même objet envoyé par la même adresse).
import { logger } from '../../lib/logger.ts'
import { prisma } from '../../lib/prisma.ts'

/** Objet sans RE:/TR:/FW:… ni balises [EXT], en minuscules et sans accents, pour comparer deux mails d'un même échange. */
export function objetNormalise(objet: string) {
  let o = objet
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim()
  for (let avant = ''; avant !== o; ) {
    avant = o
    o = o.replace(/^(\[[^\]]*\]\s*|(re|tr|fw|fwd|aw|wg|rv|ref)\s*(\[\d+\])?\s*:\s*)/, '').trim()
  }
  return o.replace(/\s+/g, ' ')
}

/** « Nom <a@b.fr> » → a@b.fr */
export const emailDe = (expediteur: string) => (expediteur.match(/<([^>]+)>/)?.[1] ?? expediteur).trim().toLowerCase()

/** Écart maximal entre deux mails rattachés sur le seul critère « même objet, même adresse ». */
const FENETRE_OBJET_MS = 90 * 24 * 3600 * 1000

interface Lie {
  id: string
  filId: string | null
  recuLe: Date
}
const champsLie = { id: true, filId: true, recuLe: true } as const

/** Référence client exploitable pour relier deux mails (l'extraction ramène parfois un mot, ex. « pour ») */
const referenceDe = (donnees: unknown) => {
  const ref = (donnees as { champs?: { reference?: string | null } } | null)?.champs?.reference
  return ref && ref.length >= 4 && /\d/.test(ref) ? ref : null
}

/** Mails déjà enregistrés liés au mail `id`. */
async function mailsLies(id: string): Promise<Lie[]> {
  const m = await prisma.demandeMail.findUniqueOrThrow({ where: { id }, select: { messageId: true, refsFil: true, donnees: true, expediteur: true, objet: true, recuLe: true } })
  const autres = { NOT: { id } }
  const refs = (m.refsFil as string[] | null) ?? []
  const reference = referenceDe(m.donnees)
  const [repondus, reponses, memeReference] = await Promise.all([
    // 1. Le mail répond à (ou transfère) un mail reçu…
    refs.length ? prisma.demandeMail.findMany({ where: { messageId: { in: refs }, ...autres }, select: champsLie }) : [],
    // … ou un mail reçu plus tôt dans la relève répond à celui-ci
    prisma.demandeMail.findMany({ where: { refsFil: { array_contains: [m.messageId] }, ...autres }, select: champsLie }),
    // 2. Même référence client (n° d'ordre de service…)
    reference ? prisma.demandeMail.findMany({ where: { donnees: { path: '$.champs.reference', equals: reference }, ...autres }, select: champsLie }) : [],
  ])

  // 3. Même objet envoyé par la même adresse, sauf si les deux mails portent des références différentes
  const objet = objetNormalise(m.objet)
  const email = emailDe(m.expediteur)
  let memeObjet: Lie[] = []
  if (objet.length >= 4 && email) {
    const proches = await prisma.demandeMail.findMany({
      where: {
        expediteur: { contains: email },
        recuLe: { gte: new Date(m.recuLe.getTime() - FENETRE_OBJET_MS), lte: new Date(m.recuLe.getTime() + FENETRE_OBJET_MS) },
        ...autres,
      },
      select: { ...champsLie, objet: true, expediteur: true, donnees: true },
    })
    memeObjet = proches.filter((p) => {
      const ref = referenceDe(p.donnees)
      return emailDe(p.expediteur) === email && objetNormalise(p.objet) === objet && !(ref && reference && ref !== reference)
    })
  }
  return [...repondus, ...reponses, ...memeReference, ...memeObjet]
}

/**
 * Rattache le mail à son fil. S'il est lié à plusieurs fils, ils sont fusionnés.
 * Le fil prend l'identifiant de son mail le plus ancien.
 */
export async function rattacherAuFil(id: string): Promise<string> {
  const lies = await mailsLies(id)
  if (lies.length === 0) {
    await prisma.demandeMail.update({ where: { id }, data: { filId: id } })
    return id
  }
  const fils = [...new Set(lies.map((l) => l.filId ?? l.id))]
  const premier = (await prisma.demandeMail.findFirst({
    where: { OR: [{ filId: { in: fils } }, { id: { in: [...lies.map((l) => l.id), id] } }] },
    orderBy: { recuLe: 'asc' },
    select: { id: true },
  }))!
  await prisma.demandeMail.updateMany({
    where: { OR: [{ filId: { in: fils } }, { id: { in: [...lies.map((l) => l.id), id] } }] },
    data: { filId: premier.id },
  })
  return premier.id
}

/** Regroupe à la main plusieurs mails (et tout leur fil) dans un seul fil. */
export async function regrouper(ids: string[]) {
  const mails = await prisma.demandeMail.findMany({ where: { id: { in: ids } }, select: { id: true, filId: true } })
  const fils = [...new Set(mails.map((m) => m.filId ?? m.id))]
  const where = { OR: [{ filId: { in: fils } }, { id: { in: mails.map((m) => m.id) } }] }
  const premier = await prisma.demandeMail.findFirst({ where, orderBy: { recuLe: 'asc' }, select: { id: true } })
  if (!premier) return null
  await prisma.demandeMail.updateMany({ where, data: { filId: premier.id } })
  return premier.id
}

/** Sort un mail de son fil : il forme un fil à lui seul ; le reste du fil garde son identifiant (ou prend celui de son plus ancien mail). */
export async function separer(id: string) {
  const m = await prisma.demandeMail.findUniqueOrThrow({ where: { id }, select: { filId: true } })
  const filId = m.filId ?? id
  const reste = await prisma.demandeMail.findFirst({ where: { filId, NOT: { id } }, orderBy: { recuLe: 'asc' }, select: { id: true } })
  if (reste && filId === id) await prisma.demandeMail.updateMany({ where: { filId, NOT: { id } }, data: { filId: reste.id } })
  await prisma.demandeMail.update({ where: { id }, data: { filId: id } })
}

/** Mails du fil, du plus ancien au plus récent. */
export async function mailsDuFil(id: string, filId: string | null) {
  return prisma.demandeMail.findMany({
    where: filId ? { filId } : { id },
    orderBy: { recuLe: 'asc' },
    select: { id: true, recuLe: true, expediteur: true, objet: true, statut: true },
  })
}

/** Rattache les mails reçus avant la mise en place des fils (filId vide). Sans effet une fois fait. */
export async function regrouperAnciens() {
  let total = 0
  for (;;) {
    const lot = await prisma.demandeMail.findMany({ where: { filId: null }, orderBy: { recuLe: 'asc' }, take: 100, select: { id: true } })
    if (lot.length === 0) break
    for (const { id } of lot) {
      // Déjà rattaché par un mail du lot qui lui était lié
      const encore = await prisma.demandeMail.findUnique({ where: { id }, select: { filId: true } })
      if (encore && !encore.filId)
        await rattacherAuFil(id).catch(async (err) => {
          // Le mail reste seul dans son fil plutôt que de bloquer le regroupement des suivants
          logger.warn({ err, id }, 'demandes mail : rattachement au fil impossible')
          await prisma.demandeMail.update({ where: { id }, data: { filId: id } })
        })
    }
    total += lot.length
  }
  if (total) logger.info({ total }, 'demandes mail : anciens mails regroupés en fils')
}
