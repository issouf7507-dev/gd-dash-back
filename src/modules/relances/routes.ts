// Relances de facture : envoi de l'email (selon ENVOI_MAIL) et historique. Routes sous /api/factures.
// Le calendrier des relances proposées (relanceDue) est dans @gd/shared/calculs, commun au front.
import { NIVEAUX_RELANCE } from '@gd/shared/types'
import { Router } from 'express'
import { z } from 'zod'
import { envoiParServeur, envoyerMail, expediteur } from '../../lib/envoi-mail.ts'
import { destinataireRelance, niveauRelance } from '../../lib/labels.ts'
import { logger } from '../../lib/logger.ts'
import { prisma } from '../../lib/prisma.ts'
import { ok } from '../../lib/response.ts'
import { requireAuth } from '../../middleware/auth.ts'
import { validate } from '../../middleware/validate.ts'
import { canWrite, charger, toFactureDto } from '../factures/routes.ts'

export const relancesRouter = Router()
relancesRouter.use(requireAuth)

const idParams = z.object({ id: z.string().min(1) })

const relanceSchema = z.object({
  niveau: z.enum(NIVEAUX_RELANCE),
  destinataire: z.enum(['client', "chargé d'affaires"]),
  email: z.email().trim().toLowerCase(),
  objet: z.string().trim().min(1).max(255),
  corps: z.string().trim().min(1).max(20_000),
})

// Comment partent les relances : par le serveur (ENVOI_MAIL=dossier|graph) ou depuis la messagerie de l'utilisateur
relancesRouter.get('/relances/envoi', (_req, res) => {
  ok(res, envoiParServeur() ? { mode: 'serveur' as const, expediteur: expediteur() } : { mode: 'messagerie' as const, expediteur: null })
})

// Envoie la relance (si le serveur s'en charge) et la note dans l'historique de la facture.
// Un échec d'envoi est aussi noté, avec sa cause : la réponse reste 201 et le front lit `statutEnvoi`.
relancesRouter.post('/:id/relances', canWrite, validate({ params: idParams, body: relanceSchema }), async (_req, res) => {
  const factureId = res.locals.params.id as string
  await charger(factureId)
  const { niveau, destinataire, ...r } = res.locals.body as z.infer<typeof relanceSchema>
  let erreur: string | null = null
  if (envoiParServeur()) {
    try {
      await envoyerMail({ a: r.email, objet: r.objet, corps: r.corps })
    } catch (err) {
      erreur = err instanceof Error ? err.message : String(err)
      logger.warn({ factureId, err: erreur }, 'relance : envoi de l’email impossible')
    }
  }
  await prisma.relance.create({
    data: {
      ...r,
      factureId,
      niveau: niveauRelance.key(niveau),
      destinataire: destinataireRelance.key(destinataire),
      envoyeParId: res.locals.user!.id,
      statutEnvoi: erreur ? 'ECHEC' : 'ENVOYE',
      erreur,
    },
  })
  ok(res, toFactureDto(await charger(factureId)), { status: 201 })
})
