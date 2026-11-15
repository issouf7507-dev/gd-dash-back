import { Router } from 'express'
import { z } from 'zod'
import { Prisma, StatutADCI, TypeSuiviDevis } from '../../generated/prisma/client.ts'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/app-error.ts'
import { envoiParServeur, envoyerMail } from '../../lib/envoi-mail.ts'
import { resultatDevis, Role, statutADCI } from '../../lib/labels.ts'
import { logger } from '../../lib/logger.ts'
import { isUniqueViolation } from '../../lib/prisma-errors.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth, requireRole } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'
import { AVEC_SUIVI, toDevisDto } from './dto.ts'
import { devisSchema, toDevisCreate, toDevisData, type DevisInput } from './schema.ts'

export const devisRouter = Router()
devisRouter.use(requireAuth)

const canWrite = requireRole(Role.DIRECTION, Role.ADMIN, Role.CONDUCTEUR, Role.ADCI)
const canDelete = requireRole(Role.DIRECTION, Role.ADMIN)
/** Validation interne d'un devis avant son envoi au client : Direction et Admin */
const VALIDATEURS: Role[] = [Role.DIRECTION, Role.ADMIN]
const estValidateur = (role: Role) => VALIDATEURS.includes(role)
const idParams = z.object({ id: z.string().min(1) })

const aujourdhui = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)
type Utilisateur = { id: string; role: Role }

const charger = async (id: string) => {
  const d = await prisma.devis.findUnique({ where: { id }, include: AVEC_SUIVI })
  if (!d) throw new NotFoundError('Devis introuvable')
  return d
}

/**
 * Changement du statut ADCI : le circuit de validation est respecté (seules la Direction et l'Admin valident ;
 * un devis n'est envoyé au client qu'une fois validé, sauf par elles) et chaque étape est notée dans l'historique.
 * Renvoie les champs à mettre à jour avec le statut.
 */
async function transition(
  actuel: { statutADCI: StatutADCI; envoyeLe: Date | null },
  nouveau: StatutADCI,
  user: Utilisateur,
  { commentaire = null, envoyeLe }: { commentaire?: string | null; envoyeLe?: Date } = {},
): Promise<Prisma.DevisUpdateInput> {
  if (nouveau === actuel.statutADCI) return {}
  const noter = (type: TypeSuiviDevis) => ({ suivi: { create: { type, commentaire, auteur: { connect: { id: user.id } } } } })
  if (nouveau === StatutADCI.VALIDE) {
    if (!estValidateur(user.role)) throw new ForbiddenError('Seules la Direction et l’Admin peuvent valider un devis')
    const u = await prisma.utilisateur.findUniqueOrThrow({ where: { id: user.id }, select: { prenom: true, nom: true } })
    return {
      statutADCI: nouveau,
      valideParUser: { connect: { id: user.id } },
      valideLe: new Date(),
      validePar: `${u.prenom} ${u.nom}`.trim(),
      ...noter(TypeSuiviDevis.VALIDE),
    }
  }
  if (nouveau === StatutADCI.ENVOYE) {
    if (actuel.statutADCI !== StatutADCI.VALIDE && !estValidateur(user.role))
      throw new ConflictError('Le devis doit être validé par la Direction avant d’être envoyé au client')
    return { statutADCI: nouveau, envoyeLe: envoyeLe ?? actuel.envoyeLe ?? aujourdhui(), ...noter(TypeSuiviDevis.ENVOYE) }
  }
  if (nouveau === StatutADCI.EN_ATTENTE_VALIDATION) return { statutADCI: nouveau, ...noter(TypeSuiviDevis.DEMANDE_VALIDATION) }
  return { statutADCI: nouveau }
}

/** Traduit les erreurs Prisma courantes en erreurs lisibles. */
function mapError(err: unknown): never {
  if (isUniqueViolation(err)) throw new ConflictError('Ce numéro de devis existe déjà')
  // Client ou conducteur inexistant (connect sur un id inconnu)
  if (err instanceof Prisma.PrismaClientKnownRequestError && (err.code === 'P2025' || err.code === 'P2003')) {
    throw new ValidationError({ body: { fieldErrors: { clientId: ['Client ou conducteur introuvable'] } } })
  }
  throw err
}

// Liste complète : les filtres, le tri et la pagination restent côté écran pour l'instant (volume faible)
devisRouter.get('/', async (_req, res) => {
  const devis = await prisma.devis.findMany({ orderBy: [{ dateReception: 'desc' }, { numero: 'desc' }], include: AVEC_SUIVI })
  ok(res, devis.map(toDevisDto))
})

// Suppression groupée (sélection dans la liste) : déclarée avant les routes /:id
const idsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) })
devisRouter.post('/supprimer', canDelete, validate({ body: idsSchema }), async (_req, res) => {
  const { ids } = res.locals.body as z.infer<typeof idsSchema>
  const { count } = await prisma.devis.deleteMany({ where: { id: { in: ids } } })
  ok(res, { count })
})

devisRouter.get('/:id', validate({ params: idParams }), async (_req, res) => {
  ok(res, toDevisDto(await charger(res.locals.params.id as string)))
})

devisRouter.post('/', canWrite, validate({ body: devisSchema }), async (_req, res) => {
  const input = res.locals.body as DevisInput
  // Un devis créé directement « Validé » ou « Envoyé » suit les mêmes règles qu'un changement de statut
  const statut = statutADCI.key(input.statutADCI)
  if (statut === StatutADCI.VALIDE && !estValidateur(res.locals.user!.role)) throw new ForbiddenError('Seules la Direction et l’Admin peuvent valider un devis')
  if (statut === StatutADCI.ENVOYE && !estValidateur(res.locals.user!.role))
    throw new ConflictError('Le devis doit être validé par la Direction avant d’être envoyé au client')
  const data = toDevisCreate(input)
  if (statut === StatutADCI.ENVOYE) data.envoyeLe = aujourdhui()
  const d = await prisma.devis.create({ data, include: AVEC_SUIVI }).catch(mapError)
  ok(res, toDevisDto(d), { status: 201 })
})

devisRouter.patch('/:id', canWrite, validate({ params: idParams, body: devisSchema.partial() }), async (_req, res) => {
  const id = res.locals.params.id as string
  const actuel = await prisma.devis.findUnique({ where: { id }, select: { resultat: true, statutADCI: true, envoyeLe: true } })
  if (!actuel) throw new NotFoundError('Devis introuvable')
  const body = { ...(res.locals.body as Partial<DevisInput>) }
  const statut = body.statutADCI === undefined ? {} : await transition(actuel, statutADCI.key(body.statutADCI), res.locals.user!)
  delete body.statutADCI
  // Le nom du valideur est fixé par la validation dans l'application
  if ('validePar' in statut) delete body.validePar
  // Le formulaire renvoie la réponse du client sans la changer : on garde alors celle lue dans le mail (date, motif, lien)
  if (body.resultat !== undefined && resultatDevis.key(body.resultat) === actuel.resultat) {
    delete body.resultat
    delete body.resultatLe
    delete body.motifRefus
  }
  const d = await prisma.devis.update({ where: { id }, data: { ...toDevisData(body), ...statut }, include: AVEC_SUIVI }).catch(mapError)
  ok(res, toDevisDto(d))
})

// ─── Circuit de validation interne, envoi au client, relances ───

const ETAPES = {
  /** Soumet le devis à la Direction */
  demander: StatutADCI.EN_ATTENTE_VALIDATION,
  valider: StatutADCI.VALIDE,
  /** Renvoie le devis à reprendre, avec le motif */
  refuser: StatutADCI.NON_TRAITE,
  envoyer: StatutADCI.ENVOYE,
} as const
const etapeSchema = z.object({
  action: z.enum(['demander', 'valider', 'refuser', 'envoyer']),
  commentaire: z.string().trim().max(2000).nullable().optional(),
  /** Envoi : date d'envoi au client (par défaut aujourd'hui) */
  date: z.iso.date().optional(),
})

devisRouter.post('/:id/etape', canWrite, validate({ params: idParams, body: etapeSchema }), async (_req, res) => {
  const id = res.locals.params.id as string
  const { action, commentaire = null, date } = res.locals.body as z.infer<typeof etapeSchema>
  const user = res.locals.user!
  const d = await charger(id)
  const dejaEnvoye = d.statutADCI === StatutADCI.ENVOYE || d.statutADCI === StatutADCI.ANNULE
  let data: Prisma.DevisUpdateInput
  if (action === 'refuser') {
    if (!estValidateur(user.role)) throw new ForbiddenError('Seules la Direction et l’Admin peuvent refuser un devis')
    if (d.statutADCI !== StatutADCI.EN_ATTENTE_VALIDATION) throw new ConflictError('Ce devis n’attend pas de validation')
    if (!commentaire) throw new ValidationError({ body: { fieldErrors: { commentaire: ['Indiquez ce qu’il faut reprendre'] } } })
    data = {
      statutADCI: StatutADCI.NON_TRAITE,
      suivi: { create: { type: TypeSuiviDevis.VALIDATION_REFUSEE, commentaire, auteur: { connect: { id: user.id } } } },
    }
  } else {
    if (action === 'demander' && (dejaEnvoye || d.statutADCI === StatutADCI.VALIDE)) throw new ConflictError('Ce devis est déjà validé ou envoyé')
    if (action === 'demander' && d.statutADCI === StatutADCI.EN_ATTENTE_VALIDATION) throw new ConflictError('La validation est déjà demandée')
    if (action === 'valider' && dejaEnvoye) throw new ConflictError('Ce devis est déjà envoyé')
    if (action === 'envoyer' && d.statutADCI === StatutADCI.ENVOYE) throw new ConflictError('Ce devis est déjà envoyé')
    data = await transition(d, ETAPES[action], user, { commentaire, envoyeLe: date ? new Date(`${date}T00:00:00Z`) : undefined })
  }
  const maj = await prisma.devis.update({ where: { id }, data, include: AVEC_SUIVI })
  ok(res, toDevisDto(maj))
})

const relanceSchema = z.object({
  email: z.email().trim().toLowerCase(),
  objet: z.string().trim().min(1).max(255),
  corps: z.string().trim().min(1).max(20_000),
})

/**
 * Relance du client sur un devis envoyé sans réponse : l'email part par le serveur (selon ENVOI_MAIL)
 * ou depuis la messagerie de l'utilisateur, et la relance est notée dans l'historique (un échec aussi, avec sa cause).
 */
devisRouter.post('/:id/relances', canWrite, validate({ params: idParams, body: relanceSchema }), async (_req, res) => {
  const id = res.locals.params.id as string
  const d = await charger(id)
  if (d.statutADCI !== StatutADCI.ENVOYE) throw new ConflictError('Seul un devis envoyé au client peut être relancé')
  const r = res.locals.body as z.infer<typeof relanceSchema>
  let erreur: string | null = null
  if (envoiParServeur()) {
    try {
      await envoyerMail({ a: r.email, objet: r.objet, corps: r.corps })
    } catch (err) {
      erreur = err instanceof Error ? err.message : String(err)
      logger.warn({ devisId: id, err: erreur }, 'relance de devis : envoi de l’email impossible')
    }
  }
  const maj = await prisma.devis.update({
    where: { id },
    data: {
      suivi: {
        create: { type: TypeSuiviDevis.RELANCE, email: r.email, objet: r.objet, statutEnvoi: erreur ? 'ECHEC' : 'ENVOYE', erreur, auteur: { connect: { id: res.locals.user!.id } } },
      },
    },
    include: AVEC_SUIVI,
  })
  ok(res, toDevisDto(maj), { status: 201 })
})

devisRouter.delete('/:id', canDelete, validate({ params: idParams }), async (_req, res) => {
  const id = res.locals.params.id as string
  if (!(await prisma.devis.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError('Devis introuvable')
  await prisma.devis.delete({ where: { id } })
  ok(res, { id })
})
