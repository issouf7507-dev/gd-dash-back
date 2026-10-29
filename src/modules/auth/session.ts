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

/** `v` = version de session de l'utilisateur : un changement de mot de passe l'incrémente et invalide ce jeton. */
export function openSession(res: Response, user: { id: string; sessionVersion: number }) {
  const token = jwt.sign({ v: user.sessionVersion }, env.JWT_SECRET, { subject: user.id, expiresIn: `${env.SESSION_HOURS}h`, algorithm: 'HS256' })
  res.cookie(SESSION_COOKIE, token, cookieOptions())
}

export function closeSession(res: Response) {
  // Mêmes options que le cookie posé (sinon le navigateur ne le supprime pas), sans durée
  const options = cookieOptions()
  delete options.maxAge
  res.clearCookie(SESSION_COOKIE, options)
}

/** Renvoie l'id utilisateur et la version de session du jeton, ou null si absent, expiré ou falsifié. */
export function readSession(token: string | undefined): { userId: string; version: number } | null {
  if (!token) return null
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] })
    if (typeof payload !== 'object' || typeof payload.sub !== 'string') return null
    // Jetons émis avant l'ajout des versions : version 0
    return { userId: payload.sub, version: typeof payload.v === 'number' ? payload.v : 0 }
  } catch {
    return null
  }
}
