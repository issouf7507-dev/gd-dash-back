import type { CookieOptions, Response } from 'express'
import jwt from 'jsonwebtoken'
import { env, isProd } from '../../config/env.ts'

export const SESSION_COOKIE = 'gd_session'

const cookieOptions = (): CookieOptions => ({
  httpOnly: true, // illisible depuis le JavaScript du navigateur
  secure: isProd, // HTTPS uniquement en production
  sameSite: 'lax',
  path: '/',
  maxAge: env.SESSION_HOURS * 3600 * 1000,
})

export function openSession(res: Response, userId: string) {
  const token = jwt.sign({}, env.JWT_SECRET, { subject: userId, expiresIn: `${env.SESSION_HOURS}h`, algorithm: 'HS256' })
  res.cookie(SESSION_COOKIE, token, cookieOptions())
}

export function closeSession(res: Response) {
  // Mêmes options que le cookie posé (sinon le navigateur ne le supprime pas), sans durée
  const options = cookieOptions()
  delete options.maxAge
  res.clearCookie(SESSION_COOKIE, options)
}

/** Renvoie l'id utilisateur du jeton, ou null si absent, expiré ou falsifié. */
export function readSession(token: string | undefined): string | null {
  if (!token) return null
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] })
    return typeof payload === 'object' && typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}
