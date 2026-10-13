import { Router } from 'express'
import { authRouter } from './modules/auth/routes.ts'
import { chantiersRouter, observationsRouter } from './modules/chantiers/routes.ts'
import { clientsRouter } from './modules/clients/routes.ts'
import { devisRouter } from './modules/devis/routes.ts'
import { facturesRouter, reglementsRouter } from './modules/factures/routes.ts'
import { importsDevisRouter } from './modules/import-mail/routes.ts'
import { healthRouter } from './modules/health/routes.ts'
import { intervenantsRouter } from './modules/intervenants/routes.ts'
import { interventionsRouter } from './modules/interventions/routes.ts'
import { utilisateursRouter } from './modules/utilisateurs/routes.ts'

/** Toutes les routes de l'API, montées sous /api */
export const apiRouter = Router()

apiRouter.use('/health', healthRouter)
apiRouter.use('/auth', authRouter)
apiRouter.use('/utilisateurs', utilisateursRouter)
apiRouter.use('/clients', clientsRouter)
apiRouter.use('/devis', devisRouter)
apiRouter.use('/imports-devis', importsDevisRouter)
apiRouter.use('/intervenants', intervenantsRouter)
apiRouter.use('/interventions', interventionsRouter)
apiRouter.use('/chantiers', chantiersRouter)
apiRouter.use('/observations', observationsRouter)
apiRouter.use('/factures', facturesRouter)
apiRouter.use('/reglements', reglementsRouter)
