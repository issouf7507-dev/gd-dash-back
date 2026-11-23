// Envoi des emails sortants (relances de facture, réponses aux mails reçus, nouveaux mails), selon ENVOI_MAIL :
// off → rien ici, l'email s'ouvre dans la messagerie de l'utilisateur ; dossier → fichier .eml ; graph → Microsoft Graph.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../config/env.ts'
import { erreurGraph, GRAPH, jetonGraph } from './graph.ts'

export interface PieceJointe {
  nom: string
  type: string
  /** Chemin du fichier sur le disque */
  chemin: string
  taille: number
}

export interface MailSortant {
  /** Destinataire(s) */
  a: string | string[]
  cc?: string[]
  objet: string
  /** Texte brut (toujours fourni : version de secours et aperçu des messageries) */
  corps: string
  /** Version mise en forme ; si présente, c'est elle qu'affichent les messageries */
  html?: string
  pieces?: PieceJointe[]
}

/** true : le serveur envoie lui-même l'email (dossier ou graph). false : l'utilisateur l'envoie depuis sa messagerie. */
export const envoiParServeur = () => env.ENVOI_MAIL !== 'off'

/** Adresse qui apparaît comme expéditeur. */
export const expediteur = () => env.GRAPH_BOITE

const token = jetonGraph({ tenantId: env.GRAPH_TENANT_ID, clientId: env.GRAPH_CLIENT_ID, clientSecret: env.GRAPH_CLIENT_SECRET })

// En-tête encodé (RFC 2047) pour les accents de l'objet et des noms de fichiers
const entete = (s: string) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`
const liste = (a: string | string[] | undefined) => (Array.isArray(a) ? a : a ? [a] : [])
const destinataires = (a: string | string[] | undefined) => liste(a).map((address) => ({ emailAddress: { address } }))
const boite = () => `${GRAPH}/users/${encodeURIComponent(env.GRAPH_BOITE)}`
const messageGraph = (m: MailSortant) => ({
  subject: m.objet,
  body: m.html ? { contentType: 'HTML', content: m.html } : { contentType: 'Text', content: m.corps },
  toRecipients: destinataires(m.a),
  ccRecipients: destinataires(m.cc),
})

async function graph(url: string, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', ...init.headers } })
  if (!r.ok) throw await erreurGraph(r)
  return r
}

/** Au-delà, Graph refuse la pièce dans une seule requête : elle passe par une session d'envoi en plusieurs morceaux. */
const PIECE_DIRECTE_MAX = 3 * 1024 * 1024
/** Taille des morceaux : multiple de 320 Kio, comme l'exige Graph */
const MORCEAU = 10 * 320 * 1024

/** Joint les pièces au brouillon Graph `id`. */
async function joindre(id: string, pieces: PieceJointe[]) {
  const url = `${boite()}/messages/${encodeURIComponent(id)}/attachments`
  for (const p of pieces) {
    const contenu = await readFile(p.chemin)
    if (contenu.length < PIECE_DIRECTE_MAX) {
      await graph(url, {
        method: 'POST',
        body: JSON.stringify({ '@odata.type': '#microsoft.graph.fileAttachment', name: p.nom, contentType: p.type, contentBytes: contenu.toString('base64') }),
      })
      continue
    }
    const session = (await (
      await graph(`${url}/createUploadSession`, {
        method: 'POST',
        body: JSON.stringify({ AttachmentItem: { attachmentType: 'file', name: p.nom, size: contenu.length, contentType: p.type } }),
      })
    ).json()) as { uploadUrl: string }
    // L'adresse de la session porte sa propre autorisation : pas de jeton ici
    for (let debut = 0; debut < contenu.length; debut += MORCEAU) {
      const morceau = contenu.subarray(debut, Math.min(debut + MORCEAU, contenu.length))
      const r = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${debut}-${debut + morceau.length - 1}/${contenu.length}` },
        body: morceau,
      })
      if (!r.ok) throw await erreurGraph(r)
    }
  }
}

/** Envoie un brouillon Graph après y avoir joint les pièces. */
async function completerEtEnvoyer(id: string, m: MailSortant) {
  if (m.pieces?.length) await joindre(id, m.pieces)
  await graph(`${boite()}/messages/${encodeURIComponent(id)}/send`, { method: 'POST' })
}

/** Écrit l'email en .eml dans ENVOI_MAIL_DOSSIER (développement : rien ne part). */
async function ecrireEml(m: MailSortant, enReponseA?: string) {
  const dossier = path.resolve(env.ENVOI_MAIL_DOSSIER)
  await mkdir(dossier, { recursive: true })
  const a = liste(m.a)
  const texte = m.corps.replace(/\r?\n/g, '\r\n')
  const frontiere = `gd-${randomUUID()}`
  // Texte seul, ou texte + HTML (multipart/alternative : la messagerie affiche le HTML)
  const alternative = `gd-alt-${randomUUID()}`
  const message = m.html
    ? [
        `Content-Type: multipart/alternative; boundary="${alternative}"`,
        '',
        `--${alternative}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        texte,
        `--${alternative}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(m.html, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
        `--${alternative}--`,
      ]
    : ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', texte]
  const corps = m.pieces?.length
    ? [
        `Content-Type: multipart/mixed; boundary="${frontiere}"`,
        '',
        `--${frontiere}`,
        ...message,
        ...(await Promise.all(
          m.pieces.map(async (p) => [
            `--${frontiere}`,
            `Content-Type: ${p.type}; name="${entete(p.nom)}"`,
            'Content-Transfer-Encoding: base64',
            `Content-Disposition: attachment; filename="${entete(p.nom)}"`,
            '',
            (await readFile(p.chemin)).toString('base64').replace(/.{76}/g, '$&\r\n'),
          ]),
        )).flat(),
        `--${frontiere}--`,
      ]
    : message
  const eml = [
    `From: ${expediteur()}`,
    `To: ${a.join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.join(', ')}`] : []),
    `Subject: ${entete(m.objet)}`,
    `Date: ${new Date().toUTCString()}`,
    ...(enReponseA ? [`In-Reply-To: ${enReponseA}`, `References: ${enReponseA}`] : []),
    'MIME-Version: 1.0',
    ...corps,
  ].join('\r\n')
  await writeFile(path.join(dossier, `${new Date().toISOString().replace(/[:.]/g, '-')}-${(a[0] ?? 'mail').replace(/[^a-z0-9@.-]/gi, '_')}.eml`), eml)
}

const desactive = () => new Error("L'envoi des emails par le serveur n'est pas activé (ENVOI_MAIL=off dans server/.env)")

/** Mode d'envoi : celui de ENVOI_MAIL, sauf réglage propre (ex. TICKETS_ENVOI) */
export type ModeEnvoi = 'off' | 'dossier' | 'graph'

/** Envoie l'email ; lève une erreur au message lisible si l'envoi échoue. */
export async function envoyerMail(m: MailSortant, mode: ModeEnvoi = env.ENVOI_MAIL) {
  if (mode === 'graph') {
    if (m.pieces?.length) {
      // Avec pièces jointes : brouillon, pièces, puis envoi (rangé dans « Éléments envoyés »)
      const brouillon = (await (await graph(`${boite()}/messages`, { method: 'POST', body: JSON.stringify(messageGraph(m)) })).json()) as { id: string }
      return completerEtEnvoyer(brouillon.id, m)
    }
    // 202 Accepted : Exchange a pris l'email en charge
    await graph(`${boite()}/sendMail`, { method: 'POST', body: JSON.stringify({ message: messageGraph(m), saveToSentItems: true }) })
    return
  }
  if (mode === 'dossier') return ecrireEml(m)
  throw desactive()
}

/**
 * Répond à un mail reçu dans GRAPH_BOITE, dans le même fil de discussion (Outlook et le client le voient comme une réponse).
 * `messageId` : Message-ID du mail reçu. S'il n'est plus dans la boîte, l'email part comme un nouveau mail.
 */
export async function repondreMail(messageId: string, m: MailSortant) {
  if (env.ENVOI_MAIL === 'graph') {
    const filtre = encodeURIComponent(`internetMessageId eq '${messageId.replace(/'/g, "''")}'`)
    const trouve = (await (await graph(`${boite()}/messages?$filter=${filtre}&$select=id&$top=1`)).json()) as { value: { id: string }[] }
    const original = trouve.value[0]?.id
    if (!original) return envoyerMail(m)
    // Brouillon de réponse (garde le fil), avec nos destinataires et notre texte, puis pièces et envoi
    const brouillon = (await (
      await graph(`${boite()}/messages/${encodeURIComponent(original)}/createReply`, { method: 'POST', body: JSON.stringify({ message: messageGraph(m) }) })
    ).json()) as { id: string }
    return completerEtEnvoyer(brouillon.id, m)
  }
  if (env.ENVOI_MAIL === 'dossier') return ecrireEml(m, messageId)
  throw desactive()
}
