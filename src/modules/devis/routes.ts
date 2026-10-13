import { Router } from 'express'
import { z } from 'zod'
import { Prisma } from '../../generated/prisma/client.ts'
import { ConflictError, NotFoundError, ValidationError } from '../../lib/app-error.ts'
import { Role } from '../../lib/labels.ts'
import { isUniqueViolation } from '../../lib/prisma-errors.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth, requireRole } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'
import { toDevisDto } from './dto.ts'
import { devisSchema, toDevisCreate, toDevisData, type DevisInput } from './schema.ts'

export const devisRouter = Router()
devisRouter.use(requireAuth)

const canWrite = requireRole(Role.DIRECTION, Role.ADMIN, Role.CONDUCTEUR, Role.ADCI)
const canDelete = requireRole(Role.DIRECTION, Role.ADMIN)
const idParams = z.object({ id: z.string().min(1) })

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
  const devis = await prisma.devis.findMany({ orderBy: [{ dateReception: 'desc' }, { numero: 'desc' }] })
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
  const d = await prisma.devis.findUnique({ where: { id: res.locals.params.id } })
  if (!d) throw new NotFoundError('Devis introuvable')
  ok(res, toDevisDto(d))
})

devisRouter.post('/', canWrite, validate({ body: devisSchema }), async (_req, res) => {
  const data = toDevisCreate(res.locals.body as DevisInput)
  const d = await prisma.devis.create({ data }).catch(mapError)
  ok(res, toDevisDto(d), { status: 201 })
})

devisRouter.patch('/:id', canWrite, validate({ params: idParams, body: devisSchema.partial() }), async (_req, res) => {
  const id = res.locals.params.id as string
  if (!(await prisma.devis.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError('Devis introuvable')
  const d = await prisma.devis.update({ where: { id }, data: toDevisData(res.locals.body as Partial<DevisInput>) }).catch(mapError)
  ok(res, toDevisDto(d))
})

devisRouter.delete('/:id', canDelete, validate({ params: idParams }), async (_req, res) => {
  const id = res.locals.params.id as string
  if (!(await prisma.devis.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundError('Devis introuvable')
  await prisma.devis.delete({ where: { id } })
  ok(res, { id })
})
