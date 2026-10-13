import { PrismaMariaDb } from '@prisma/adapter-mariadb'
import { env } from '../config/env.ts'
import { PrismaClient } from '../generated/prisma/client.ts'

// Prisma 7 se connecte à MySQL via le driver `mariadb`.
// allowPublicKeyRetrieval : nécessaire avec l'authentification par défaut de MySQL 8 (caching_sha2_password) sans TLS.
function poolConfig(url: string) {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
    connectionLimit: 10,
    allowPublicKeyRetrieval: true,
  }
}

export const prisma = new PrismaClient({ adapter: new PrismaMariaDb(poolConfig(env.DATABASE_URL)) })
