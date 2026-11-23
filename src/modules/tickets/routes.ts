// Tickets de support : chacun signale un souci (avec captures) ; Direction et Admin les traitent.
// Chaque nouveau ticket est envoyé par email à TICKETS_EMAIL (selon ENVOI_MAIL).
import { Router } from 'express'
import path from 'node:path'
import { z } from 'zod'
import type { Prisma, Ticket, TicketMessage, Utilisateur } from '../../generated/prisma/client.ts'
import { env } from '../../config/env.ts'
import { ForbiddenError, NotFoundError } from '../../lib/app-error.ts'
import { envoyerMail } from '../../lib/envoi-mail.ts'
import { Role, roleLabel } from '../../lib/labels.ts'
import { logger } from '../../lib/logger.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth, requireRole } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'
import { htmlTicket } from './mail-ticket.ts'
import { conserver, corpsPiece, deposer, dossierPiecesEnvoi, preparer, type PieceEnvoyee } from '../demandes-mail/pieces-envoi.ts'

export const ticketsRouter = Router()
ticketsRouter.use(requireAuth)

export const CATEGORIES_TICKET = ['Bug', 'Question', 'Amélioration', 'Accès', 'Autre'] as const
export const PRIORITES_TICKET = ['Basse', 'Normale', 'Haute', 'Urgente'] as const
export const STATUTS_TICKET = ['Ouvert', 'En cours', 'Résolu', 'Fermé'] as const
/** Statuts où le ticket attend encore quelque chose */
const ACTIFS = ['Ouvert', 'En cours']

/** Rôles qui voient et traitent tous les tickets */
const SUPPORT: Role[] = [Role.ADMIN, Role.DIRECTION]
const estSupport = (role: Role) => SUPPORT.includes(role)

type Personne = Pick<Utilisateur, 'id' | 'prenom' | 'nom' | 'email'> | null
const personne = (u: Personne) => (u ? { id: u.id, nom: `${u.prenom} ${u.nom}`.trim(), email: u.email } : null)
const champsPersonne = { select: { id: true, prenom: true, nom: true, email: true } } as const

type TicketComplet = Ticket & { auteur: Personne; _count?: { messages: number } }
const toTicketDto = (t: TicketComplet) => ({
  id: t.id,
  numero: t.numero,
  titre: t.titre,
  description: t.description,
  categorie: t.categorie,
  priorite: t.priorite,
  statut: t.statut,
  page: t.page,
  auteur: personne(t.auteur),
  // Le nom du fichier stocké reste côté serveur : le front télécharge par index
  pieces: ((t.pieces as PieceEnvoyee[] | null) ?? []).map((p) => ({ nom: p.nom, type: p.type, taille: p.taille })),
  notifie: t.notifie,
  messages: t._count?.messages ?? 0,
  resoluLe: t.resoluLe?.toISOString() ?? null,
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
})
const toMessageDto = (m: TicketMessage & { auteur: Personne }) => ({ id: m.id, texte: m.texte, auteur: personne(m.auteur), createdAt: m.createdAt.toISOString() })

/** Le ticket, si l'utilisateur a le droit de le voir (le sien, ou tous pour le support) */
async function trouver(id: string, user: { id: string; role: Role }) {
  const t = await prisma.ticket.findUnique({ where: { id }, include: { auteur: champsPersonne, _count: { select: { messages: true } } } })
  if (!t) throw new NotFoundError('Ticket introuvable')
  if (!estSupport(user.role) && t.auteurId !== user.id) throw new ForbiddenError('Ce ticket ne vous appartient pas')
  return t
}

// ─── Email au support ───

const LIGNE = '─'.repeat(48)
function texteEmail(t: TicketComplet, role: string) {
  const lien = `${env.APP_URL}/tickets?ticket=${t.id}`
  return [
    `Nouveau ticket #${t.numero} — ${t.titre}`,
    LIGNE,
    `Auteur     : ${t.auteur ? `${personne(t.auteur)!.nom} <${t.auteur.email}>` : '—'} (${role})`,
    `Catégorie  : ${t.categorie}`,
    `Priorité   : ${t.priorite}`,
    `Page       : ${t.page ?? '—'}`,
    `Navigateur : ${t.navigateur ?? '—'}`,
    `Date       : ${t.createdAt.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' })}`,
    LIGNE,
    '',
    t.description,
    '',
    LIGNE,
    `Ouvrir le ticket : ${lien}`,
  ].join('\n')
}

/** Prévient le support ; un échec d'envoi n'empêche pas le ticket d'être enregistré (il est noté sur le ticket). */
async function notifier(t: TicketComplet, role: string, pieces: Awaited<ReturnType<typeof preparer>>) {
  const a = env.TICKETS_EMAIL.split(/[,;\s]+/).filter(Boolean)
  if (!a.length) return
  try {
    const mode = env.TICKETS_ENVOI ?? env.ENVOI_MAIL
    if (mode === 'off') throw new Error('ENVOI_MAIL=off : le serveur n’envoie pas d’emails')
    const urgent = t.priorite === 'Urgente' || t.priorite === 'Haute'
    await envoyerMail(
      {
        a,
        objet: `${urgent ? `[${t.priorite.toUpperCase()}] ` : ''}Ticket #${t.numero} — ${t.titre}`,
        corps: texteEmail(t, role),
        html: htmlTicket({
          numero: t.numero,
          titre: t.titre,
          description: t.description,
          categorie: t.categorie,
          priorite: t.priorite,
          page: t.page,
          navigateur: t.navigateur,
          auteur: personne(t.auteur),
          role,
          date: t.createdAt,
          pieces: pieces.map((p) => p.nom),
          lien: `${env.APP_URL}/tickets?ticket=${t.id}`,
          appUrl: env.APP_URL,
        }),
        pieces,
      },
      mode,
    )
    await prisma.ticket.update({ where: { id: t.id }, data: { notifie: true, erreurNotif: null } })
    t.notifie = true
  } catch (err) {
    logger.warn({ err, ticket: t.numero }, 'Email du ticket non envoyé')
    await prisma.ticket.update({ where: { id: t.id }, data: { erreurNotif: err instanceof Error ? err.message : String(err) } })
  }
}

// ─── Routes ───

const idParams = z.object({ id: z.string().min(1) })

/** Liste : tous les tickets pour le support, les siens pour les autres */
ticketsRouter.get('/', async (_req, res) => {
  const user = res.locals.user!
  const tickets = await prisma.ticket.findMany({
    where: estSupport(user.role) ? {} : { auteurId: user.id },
    include: { auteur: champsPersonne, _count: { select: { messages: true } } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  })
  ok(res, tickets.map(toTicketDto))
})

/** Pastille du menu : tickets en attente (tous pour le support, les siens sinon) */
ticketsRouter.get('/compteur', async (_req, res) => {
  const user = res.locals.user!
  const where: Prisma.TicketWhereInput = { statut: { in: ACTIFS }, ...(estSupport(user.role) ? {} : { auteurId: user.id }) }
  ok(res, { actifs: await prisma.ticket.count({ where }), support: estSupport(user.role) })
})

/** Capture déposée avant la création du ticket : le fichier brut dans le corps */
ticketsRouter.post('/pieces', corpsPiece, async (req, res) => {
  ok(res, await deposer(req.body as Buffer))
})

const ticketSchema = z.object({
  titre: z.string().trim().min(3, 'Donnez un titre (3 caractères minimum)').max(200),
  description: z.string().trim().min(5, 'Décrivez le problème').max(20_000),
  categorie: z.enum(CATEGORIES_TICKET),
  priorite: z.enum(PRIORITES_TICKET),
  page: z.string().trim().max(500).optional(),
  navigateur: z.string().trim().max(500).optional(),
  pieces: z
    .array(z.object({ id: z.string().min(1).max(64), nom: z.string().trim().min(1).max(255), type: z.string().trim().max(255).default('application/octet-stream') }))
    .max(10, '10 captures au maximum')
    .default([]),
})

ticketsRouter.post('/', validate({ body: ticketSchema }), async (_req, res) => {
  const user = res.locals.user!
  const d = res.locals.body as z.infer<typeof ticketSchema>
  const jointes = await preparer(d.pieces)
  const pieces = await conserver(jointes)
  const t = await prisma.ticket.create({
    data: {
      titre: d.titre,
      description: d.description,
      categorie: d.categorie,
      priorite: d.priorite,
      page: d.page || null,
      navigateur: d.navigateur || null,
      pieces: pieces as unknown as Prisma.InputJsonValue,
      auteurId: user.id,
    },
    include: { auteur: champsPersonne, _count: { select: { messages: true } } },
  })
  // Les pièces ont été rangées : l'email les joint depuis leur nouvel emplacement
  await notifier(t, roleLabel(user.role), pieces.map((p) => ({ nom: p.nom, type: p.type, taille: p.taille, chemin: path.join(dossierPiecesEnvoi(), p.fichier) })))
  ok(res, toTicketDto(t), { status: 201 })
})

ticketsRouter.get('/:id', validate({ params: idParams }), async (_req, res) => {
  const t = await trouver(res.locals.params.id, res.locals.user!)
  const messages = await prisma.ticketMessage.findMany({ where: { ticketId: t.id }, include: { auteur: champsPersonne }, orderBy: { createdAt: 'asc' } })
  ok(res, { ...toTicketDto(t), navigateur: t.navigateur, erreurNotif: estSupport(res.locals.user!.role) ? t.erreurNotif : null, fil: messages.map(toMessageDto) })
})

/** Message sur le ticket : l'auteur ou le support. Une réponse du support fait passer un ticket ouvert « En cours ». */
ticketsRouter.post('/:id/messages', validate({ params: idParams, body: z.object({ texte: z.string().trim().min(1, 'Message vide').max(20_000) }) }), async (_req, res) => {
  const user = res.locals.user!
  const t = await trouver(res.locals.params.id, user)
  const m = await prisma.ticketMessage.create({ data: { ticketId: t.id, auteurId: user.id, texte: res.locals.body.texte }, include: { auteur: champsPersonne } })
  if (estSupport(user.role) && t.statut === 'Ouvert') await prisma.ticket.update({ where: { id: t.id }, data: { statut: 'En cours' } })
  // L'auteur relance un ticket résolu : il est rouvert
  else if (!estSupport(user.role) && (t.statut === 'Résolu' || t.statut === 'Fermé')) await prisma.ticket.update({ where: { id: t.id }, data: { statut: 'Ouvert', resoluLe: null } })
  else await prisma.ticket.update({ where: { id: t.id }, data: { updatedAt: new Date() } })
  ok(res, toMessageDto(m), { status: 201 })
})

/** Statut et priorité : support seulement */
ticketsRouter.patch(
  '/:id',
  requireRole(...SUPPORT),
  validate({ params: idParams, body: z.object({ statut: z.enum(STATUTS_TICKET).optional(), priorite: z.enum(PRIORITES_TICKET).optional() }) }),
  async (_req, res) => {
    const t = await trouver(res.locals.params.id, res.locals.user!)
    const { statut, priorite } = res.locals.body as { statut?: string; priorite?: string }
    const resolu = statut === 'Résolu' || statut === 'Fermé'
    const maj = await prisma.ticket.update({
      where: { id: t.id },
      data: { statut, priorite, ...(statut ? { resoluLe: resolu ? (t.resoluLe ?? new Date()) : null } : {}) },
      include: { auteur: champsPersonne, _count: { select: { messages: true } } },
    })
    ok(res, toTicketDto(maj))
  },
)

const TYPES_AFFICHABLES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'])

ticketsRouter.get('/:id/pieces/:index', validate({ params: idParams.extend({ index: z.coerce.number().int().min(0) }) }), async (_req, res) => {
  const t = await trouver(res.locals.params.id, res.locals.user!)
  const p = ((t.pieces as PieceEnvoyee[] | null) ?? [])[res.locals.params.index as number]
  if (!p) throw new NotFoundError('Capture introuvable')
  const type = p.type.toLowerCase().split(';')[0].trim()
  const affichable = TYPES_AFFICHABLES.has(type)
  // Fichier envoyé par un utilisateur : seuls les PDF et les images s'ouvrent dans le navigateur, le reste est téléchargé
  if (type === 'application/pdf') res.removeHeader('Content-Security-Policy')
  else res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
  res.setHeader('Content-Type', affichable ? type : 'application/octet-stream')
  res.setHeader('Content-Disposition', `${affichable ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(p.nom)}`)
  res.sendFile(path.join(dossierPiecesEnvoi(), path.basename(p.fichier)))
})
