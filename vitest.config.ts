import os from 'node:os'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

// Les tests utilisent la base gd_test, avec les mêmes identifiants que server/.env
try {
  process.loadEnvFile('.env')
} catch {
  // CI : variables fournies par l'environnement
}
const testDbUrl = (process.env.DATABASE_URL ?? 'mysql://gd:gd@127.0.0.1:3306/gd').replace(/\/[^/?]+(\?|$)/, '/gd_test$1')

export default defineConfig({
  test: {
    environment: 'node',
    // Les tests d'intégration partagent la base gd_test : un fichier à la fois
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: testDbUrl,
      CORS_ORIGIN: 'http://localhost:5180',
      JWT_SECRET: 'secret-de-test-uniquement-pour-vitest-0123456789',
      IMPORT_MAIL_SOURCE: 'off',
      IMPORT_MAIL_AUTO: 'false',
      IMPORT_MAIL_STOCKAGE: path.join(os.tmpdir(), 'gd-test-imports'),
    },
  },
})
