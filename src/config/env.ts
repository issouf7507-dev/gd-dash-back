import { z } from 'zod'

// Variables d'environnement validées au démarrage : l'API refuse de démarrer si l'une est absente ou invalide.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().startsWith('mysql://', 'DATABASE_URL doit commencer par mysql://'),
  CORS_ORIGIN: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET doit faire au moins 32 caractères'),
  SESSION_HOURS: z.coerce.number().positive().default(8),

  // Import des devis depuis les mails SolutionsBTP (voir .claude/tasks/PLAN_IMPORT_DEVIS_MAIL.md)
  /** off : désactivé · dossier : lit des fichiers .eml (développement) · imap : lit une boîte mail (Gmail…) */
  IMPORT_MAIL_SOURCE: z.enum(['off', 'dossier', 'imap']).default('off'),
  IMPORT_MAIL_DOSSIER: z.string().default('data/mails-entrants'),
  /** Où sont conservés les PDF des devis importés */
  IMPORT_MAIL_STOCKAGE: z.string().default('data/imports'),
  IMPORT_MAIL_INTERVALLE_MIN: z.coerce.number().min(1).default(5),
  /** true : les mails sans anomalie créent directement le devis. false : tout passe par « À vérifier ». */
  IMPORT_MAIL_AUTO: z.stringbool().default(false),
  /** Ne garder que les mails de ces expéditeurs (adresses ou domaines, séparés par des virgules). Vide : tous. */
  IMPORT_MAIL_EXPEDITEURS: z.string().default(''),
  IMAP_HOST: z.string().default('imap.gmail.com'),
  IMAP_PORT: z.coerce.number().int().positive().default(993),
  IMAP_USER: z.string().default(''),
  IMAP_PASSWORD: z.string().default(''),
  /** Libellé Gmail (= dossier IMAP) à relever */
  IMAP_LIBELLE: z.string().default('GD-Devis'),
  /** Nombre de jours relus à chaque relève (les mails déjà traités sont reconnus et sautés) */
  IMAP_JOURS: z.coerce.number().int().min(1).default(30),
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  console.error('❌ Variables d’environnement invalides :', z.flattenError(parsed.error).fieldErrors)
  process.exit(1)
}

if (parsed.data.IMPORT_MAIL_SOURCE === 'imap' && (!parsed.data.IMAP_USER || !parsed.data.IMAP_PASSWORD)) {
  console.error('❌ IMPORT_MAIL_SOURCE=imap : renseignez IMAP_USER et IMAP_PASSWORD dans server/.env')
  process.exit(1)
}

export const env = parsed.data
export const isProd = env.NODE_ENV === 'production'
