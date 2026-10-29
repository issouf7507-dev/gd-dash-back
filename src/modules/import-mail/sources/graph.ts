import { erreurGraph, GRAPH, jetonGraph, type IdentifiantsGraph } from '../../../lib/graph.ts'
import type { MailBrut, SourceMails } from './types.ts'

interface GraphConfig extends IdentifiantsGraph {
  /** Adresse de la boîte relevée (ex. contact@gdcouverture.fr) */
  boite: string
  /** Dossier Outlook (inbox = Boîte de réception) */
  dossier: string
  jours: number
}

/**
 * Lit une boîte Outlook / Microsoft 365 via Microsoft Graph, avec une application Entra
 * (permission « Mail.Read » de type Application). LECTURE SEULE : la plateforme ne modifie,
 * ne déplace et ne supprime aucun mail, et ne les marque pas comme lus.
 * Les mails déjà traités sont reconnus par leur Message-ID et ne sont pas retéléchargés.
 */
export function sourceGraph(cfg: GraphConfig): SourceMails {
  const token = jetonGraph(cfg)

  async function get(url: string) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${await token()}` } })
    if (!r.ok) throw await erreurGraph(r)
    return r
  }

  const boite = `${GRAPH}/users/${encodeURIComponent(cfg.boite)}`
  return {
    nom: `outlook ${cfg.boite}`,
    async *lire(dejaTraite, progression) {
      const depuis = new Date(Date.now() - cfg.jours * 86_400_000).toISOString()
      const params = new URLSearchParams({
        $filter: `receivedDateTime ge ${depuis}`,
        $orderby: 'receivedDateTime asc',
        $select: 'id,internetMessageId',
        $top: '50',
      })
      // 1. Liste des nouveaux mails (identifiants seulement : rapide), pour connaître le total à télécharger
      const aTelecharger: string[] = []
      let url: string | undefined = `${boite}/mailFolders/${encodeURIComponent(cfg.dossier)}/messages?${params}`
      while (url) {
        const page = (await (await get(url)).json()) as { value: { id: string; internetMessageId?: string }[]; '@odata.nextLink'?: string }
        for (const m of page.value) {
          if (m.internetMessageId && (await dejaTraite(m.internetMessageId))) continue
          aTelecharger.push(m.id)
        }
        progression?.({ etape: 'recherche', faits: aTelecharger.length, total: null })
        url = page['@odata.nextLink']
      }
      // 2. Source MIME complète (.eml), fournie mail par mail : chacun est traité et enregistré avant le
      // téléchargement du suivant (tout garder en mémoire dépassait la limite PM2, qui redémarrait l'API en boucle)
      for (const [i, id] of aTelecharger.entries()) {
        progression?.({ etape: 'téléchargement', faits: i, total: aTelecharger.length })
        const brut = Buffer.from(await (await get(`${boite}/messages/${encodeURIComponent(id)}/$value`)).arrayBuffer())
        yield { ref: id, brut } satisfies MailBrut
      }
    },
  }
}
