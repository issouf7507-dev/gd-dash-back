// Notifications dans l'application (cloche de la barre du haut) : chacun ne voit que les siennes.
import { Router } from 'express'
import { z } from 'zod'
import type { Notification } from '../../generated/prisma/client.ts'
import { logger } from '../../lib/logger.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'

export const notificationsRouter = Router()
notificationsRouter.use(requireAuth)

/** Au-delà, les plus anciennes notifications lues sont effacées */
const CONSERVEES = 100

const toDto = (n: Notification) => ({
  id: n.id,
  type: n.type,
  titre: n.titre,
  texte: n.texte,
  lien: n.lien,
  par: n.par,
  lu: n.luLe !== null,
  createdAt: n.createdAt.toISOString(),
})

export interface NouvelleNotification {
  utilisateurId: string
  type: string
  titre: string
  texte: string
  lien?: string | null
  par?: string | null
}

/** Crée une notification ; un échec est seulement noté (il ne doit pas faire échouer l'action qui la déclenche). */
export async function notifier(n: NouvelleNotification) {
  try {
    await prisma.notification.create({ data: { ...n, titre: n.titre.slice(0, 200), lien: n.lien?.slice(0, 500) ?? null, par: n.par?.slice(0, 200) ?? null } })
    // Ménage : on garde les CONSERVEES plus récentes (les non lues ne sont jamais effacées)
    const anciennes = await prisma.notification.findMany({
      where: { utilisateurId: n.utilisateurId, luLe: { not: null } },
      orderBy: { createdAt: 'desc' },
      skip: CONSERVEES,
      select: { id: true },
    })
    if (anciennes.length) await prisma.notification.deleteMany({ where: { id: { in: anciennes.map((a) => a.id) } } })
  } catch (err) {
    logger.warn({ err }, 'Notification non créée')
  }
}

/** Les 30 dernières notifications, et le nombre de non lues */
notificationsRouter.get('/', async (_req, res) => {
  const utilisateurId = res.locals.user!.id
  const [liste, nonLues] = await Promise.all([
    prisma.notification.findMany({ where: { utilisateurId }, orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.notification.count({ where: { utilisateurId, luLe: null } }),
  ])
  ok(res, { notifications: liste.map(toDto), nonLues })
})

/** Marquer comme lues : certaines (ids) ou toutes */
notificationsRouter.post('/lire', validate({ body: z.object({ ids: z.array(z.string().min(1)).max(200).optional() }) }), async (_req, res) => {
  const { ids } = res.locals.body as { ids?: string[] }
  const { count } = await prisma.notification.updateMany({
    // Toujours limité aux notifications de la personne connectée
    where: { utilisateurId: res.locals.user!.id, luLe: null, ...(ids ? { id: { in: ids } } : {}) },
    data: { luLe: new Date() },
  })
  ok(res, { count })
})
