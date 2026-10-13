import { defineConfig } from 'prisma/config'

// Prisma 7 ne charge plus .env tout seul
try {
  process.loadEnvFile('.env')
} catch {
  // pas de .env (CI, production) : les variables viennent de l'environnement
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'node --env-file=.env --import tsx prisma/seed.ts' },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    // Base temporaire de `prisma migrate dev` : l'utilisateur gd n'a pas le droit de créer des bases
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
})
