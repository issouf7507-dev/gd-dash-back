// Envoi des emails sortants (relances de facture), selon ENVOI_MAIL :
// off → rien ici, l'email s'ouvre dans la messagerie de l'utilisateur ; dossier → fichier .eml ; graph → Microsoft Graph.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../config/env.ts'
import { erreurGraph, GRAPH, jetonGraph } from './graph.ts'

export interface MailSortant {
  a: string
  objet: string
  /** Texte brut */
  corps: string
}

/** true : le serveur envoie lui-même l'email (dossier ou graph). false : l'utilisateur l'envoie depuis sa messagerie. */
export const envoiParServeur = () => env.ENVOI_MAIL !== 'off'

/** Adresse qui apparaît comme expéditeur. */
export const expediteur = () => env.GRAPH_BOITE

const token = jetonGraph({ tenantId: env.GRAPH_TENANT_ID, clientId: env.GRAPH_CLIENT_ID, clientSecret: env.GRAPH_CLIENT_SECRET })

// En-tête encodé (RFC 2047) pour les accents de l'objet
const entete = (s: string) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`

/** Envoie l'email ; lève une erreur au message lisible si l'envoi échoue. */
export async function envoyerMail(m: MailSortant) {
  if (env.ENVOI_MAIL === 'graph') {
    const r = await fetch(`${GRAPH}/users/${encodeURIComponent(env.GRAPH_BOITE)}/sendMail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: { subject: m.objet, body: { contentType: 'Text', content: m.corps }, toRecipients: [{ emailAddress: { address: m.a } }] },
        saveToSentItems: true,
      }),
    })
    // 202 Accepted : Exchange a pris l'email en charge
    if (!r.ok) throw await erreurGraph(r)
    return
  }
  if (env.ENVOI_MAIL === 'dossier') {
    const dossier = path.resolve(env.ENVOI_MAIL_DOSSIER)
    await mkdir(dossier, { recursive: true })
    const eml = [
      `From: ${expediteur()}`,
      `To: ${m.a}`,
      `Subject: ${entete(m.objet)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      m.corps.replace(/\r?\n/g, '\r\n'),
    ].join('\r\n')
    await writeFile(path.join(dossier, `${new Date().toISOString().replace(/[:.]/g, '-')}-${m.a.replace(/[^a-z0-9@.-]/gi, '_')}.eml`), eml)
    return
  }
  throw new Error("L'envoi des emails par le serveur n'est pas activé (ENVOI_MAIL=off)")
}
