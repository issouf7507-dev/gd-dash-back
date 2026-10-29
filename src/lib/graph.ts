// Accès à Microsoft Graph avec une application Entra (flux « client credentials »).
// Utilisé pour lire la boîte contact@ (Mail.Read) et pour envoyer les relances (Mail.Send).

export const GRAPH = 'https://graph.microsoft.com/v1.0'

export interface IdentifiantsGraph {
  tenantId: string
  clientId: string
  clientSecret: string
}

/** Renvoie une fonction qui fournit un jeton d'accès valide, renouvelé une minute avant son expiration. */
export function jetonGraph(cfg: IdentifiantsGraph) {
  let jeton: { valeur: string; expire: number } | null = null
  return async function token() {
    if (jeton && jeton.expire > Date.now() + 60_000) return jeton.valeur
    const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
    })
    const corps = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string }
    if (!r.ok || !corps.access_token) throw new Error(`Connexion Microsoft refusée : ${corps.error_description?.split('\n')[0] ?? r.status}`)
    jeton = { valeur: corps.access_token, expire: Date.now() + (corps.expires_in ?? 3600) * 1000 }
    return jeton.valeur
  }
}

/** Message d'erreur lisible à partir d'une réponse Graph en échec. */
export async function erreurGraph(r: Response) {
  const detail = ((await r.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message
  return new Error(`Microsoft Graph ${r.status} : ${detail ?? r.statusText}`)
}
