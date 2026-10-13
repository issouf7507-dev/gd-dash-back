import { ImapFlow } from 'imapflow'
import type { MailBrut, SourceMails } from './types.ts'

interface ImapConfig {
  host: string
  port: number
  user: string
  password: string
  libelle: string
  jours: number
}

/**
 * Lit une boîte mail en IMAP (Gmail : libellé = dossier). Ouverture en LECTURE SEULE :
 * la plateforme ne modifie, ne déplace et ne supprime aucun mail. Les mails déjà traités
 * sont reconnus par leur Message-ID (table imports_mail) et ne sont pas retéléchargés.
 */
export function sourceImap(cfg: ImapConfig): SourceMails {
  return {
    nom: `imap ${cfg.user} / ${cfg.libelle}`,
    async lire(dejaTraite) {
      const client = new ImapFlow({
        host: cfg.host,
        port: cfg.port,
        secure: true,
        auth: { user: cfg.user, pass: cfg.password },
        logger: false,
      })
      await client.connect()
      const mails: MailBrut[] = []
      try {
        const lock = await client.getMailboxLock(cfg.libelle, { readOnly: true })
        try {
          const depuis = new Date(Date.now() - cfg.jours * 86_400_000)
          const uids = (await client.search({ since: depuis }, { uid: true })) || []
          if (uids.length === 0) return []
          // 1er passage : seulement les en-têtes, pour sauter les mails connus
          const nouveaux: number[] = []
          for await (const msg of client.fetch(uids, { envelope: true }, { uid: true })) {
            const id = msg.envelope?.messageId
            if (!id || !(await dejaTraite(id))) nouveaux.push(msg.uid)
          }
          // 2e passage : le mail complet (pièces jointes comprises) des nouveaux uniquement
          for (const uid of nouveaux) {
            const msg = await client.fetchOne(String(uid), { source: true }, { uid: true })
            if (msg && msg.source) mails.push({ ref: `uid ${uid}`, brut: msg.source })
          }
        } finally {
          lock.release()
        }
      } finally {
        await client.logout().catch(() => client.close())
      }
      return mails
    },
  }
}
