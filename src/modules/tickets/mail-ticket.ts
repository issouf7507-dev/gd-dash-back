// Email HTML d'un nouveau ticket, dans le style de l'appli (en-tête noir et bleu, carte blanche).
// Construit pour les messageries : tableaux, styles en ligne, pas de CSS externe ni d'image distante.
// Tout texte saisi par l'utilisateur passe par `echapper`.

export interface DonneesMailTicket {
  numero: number
  titre: string
  description: string
  categorie: string
  priorite: string
  page: string | null
  navigateur: string | null
  auteur: { nom: string; email: string } | null
  role: string
  date: Date
  pieces: string[]
  lien: string
  /** Adresse de l'appli, pour rendre la page cliquable */
  appUrl: string
}

const echapper = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const POLICE = "font-family:Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

const PRIORITES: Record<string, { fond: string; texte: string; point: string }> = {
  Basse: { fond: '#f1f5f9', texte: '#475569', point: '#94a3b8' },
  Normale: { fond: '#edf4fc', texte: '#1c51a1', point: '#2b6cc4' },
  Haute: { fond: '#fffbeb', texte: '#b45309', point: '#f59e0b' },
  Urgente: { fond: '#fef2f2', texte: '#b91c1c', point: '#ef4444' },
}

const ICONES: Record<string, string> = { Bug: '🐞', Question: '❓', Amélioration: '✨', Accès: '🔑', Autre: '💬' }

/** « Chrome 157 sur Windows » plutôt que la chaîne complète du navigateur */
function navigateurLisible(ua: string | null) {
  if (!ua) return null
  const nav = /Edg\/(\d+)/.exec(ua) ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}` : /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}` : /Chrome\/(\d+)/.exec(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}` : /Safari\//.test(ua) ? 'Safari' : 'Navigateur'
  const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return os ? `${nav} sur ${os}` : nav
}

function pastille(texte: string, fond: string, couleur: string, point?: string) {
  return `<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${fond};color:${couleur};font-size:12px;font-weight:600;line-height:16px;white-space:nowrap">${
    point ? `<span style="display:inline-block;width:7px;height:7px;border-radius:7px;background:${point};margin-right:6px;vertical-align:1px"></span>` : ''
  }${texte}</span>`
}

function ligneInfo(libelle: string, valeur: string) {
  return `<tr>
    <td style="padding:7px 0;width:110px;color:#64748b;font-size:13px;vertical-align:top">${libelle}</td>
    <td style="padding:7px 0;color:#0f172a;font-size:13px;vertical-align:top">${valeur}</td>
  </tr>`
}

export function htmlTicket(d: DonneesMailTicket) {
  const p = PRIORITES[d.priorite] ?? PRIORITES.Normale
  const date = d.date.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'full', timeStyle: 'short' })
  const nav = navigateurLisible(d.navigateur)
  const urgent = d.priorite === 'Urgente' || d.priorite === 'Haute'
  const description = echapper(d.description).replace(/\r?\n/g, '<br>')

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>Ticket #${d.numero}</title>
</head>
<body style="margin:0;padding:0;background:#f1f3f5;${POLICE}">
<!-- Aperçu affiché par la messagerie à côté de l'objet -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${echapper(`${d.categorie} · ${d.priorite} — ${d.auteur?.nom ?? 'Utilisateur'} : ${d.description.slice(0, 120)}`)}</div>

<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f1f3f5">
<tr><td align="center" style="padding:32px 16px">

  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px">

    <!-- En-tête noir à lueur bleue -->
    <tr><td style="background-color:#08172d;background-image:linear-gradient(135deg,#1c51a1 0%,#08172d 55%,#000000 100%);border-radius:20px 20px 0 0;padding:28px 32px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
        <td style="${POLICE}">
          <div style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:-0.2px">G.D. Couverture</div>
          <div style="color:rgba(255,255,255,0.55);font-size:12px;margin-top:2px">Support · Pilotage des activités</div>
        </td>
        <td align="right" style="${POLICE}">
          <span style="display:inline-block;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,0.12);color:#ffffff;font-size:12px;font-weight:600">${urgent ? '⚠️ ' : ''}Nouveau ticket</span>
        </td>
      </tr></table>
      <div style="margin-top:28px;color:rgba(255,255,255,0.55);font-size:13px;font-weight:600;letter-spacing:1px;text-transform:uppercase">Ticket #${d.numero}</div>
      <div style="margin-top:6px;color:#ffffff;font-size:26px;line-height:32px;font-weight:600;letter-spacing:-0.5px">${echapper(d.titre)}</div>
    </td></tr>

    <!-- Carte -->
    <tr><td style="background:#ffffff;padding:28px 32px 8px;${POLICE}">
      <div>
        ${pastille(`${ICONES[d.categorie] ?? '💬'}&nbsp; ${echapper(d.categorie)}`, '#f1f5f9', '#334155')}
        &nbsp;${pastille(`Priorité ${echapper(d.priorite)}`, p.fond, p.texte, p.point)}
      </div>

      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:20px;border-top:1px solid #eef1f4;border-bottom:1px solid #eef1f4">
        <tr><td style="padding:10px 0">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            ${ligneInfo('Signalé par', d.auteur ? `<strong>${echapper(d.auteur.nom)}</strong> · <a href="mailto:${echapper(d.auteur.email)}" style="color:#1c51a1;text-decoration:none">${echapper(d.auteur.email)}</a><br><span style="color:#64748b">${echapper(d.role)}</span>` : '—')}
            ${ligneInfo('Le', date.charAt(0).toUpperCase() + date.slice(1))}
            ${d.page ? ligneInfo('Page', `<a href="${echapper(d.appUrl + d.page)}" style="color:#1c51a1;text-decoration:none">${echapper(d.page)}</a>`) : ''}
            ${nav ? ligneInfo('Navigateur', echapper(nav)) : ''}
          </table>
        </td></tr>
      </table>

      <div style="margin-top:22px;color:#64748b;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase">Description</div>
      <div style="margin-top:10px;padding:16px 18px;border-radius:14px;background:#f8fafc;border-left:3px solid #2b6cc4;color:#1e293b;font-size:14px;line-height:22px">${description}</div>

      ${
        d.pieces.length
          ? `<div style="margin-top:18px;color:#64748b;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase">${d.pieces.length} capture${d.pieces.length > 1 ? 's' : ''} jointe${d.pieces.length > 1 ? 's' : ''}</div>
      <div style="margin-top:8px">${d.pieces
        .map(
          (n) =>
            `<span style="display:inline-block;margin:0 6px 6px 0;padding:6px 10px;border-radius:10px;border:1px solid #e2e8f0;color:#334155;font-size:12px">📎 ${echapper(n)}</span>`,
        )
        .join('')}</div>`
          : ''
      }

      <!-- Bouton -->
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:26px 0 24px">
        <tr><td style="border-radius:12px;background:#000000">
          <a href="${echapper(d.lien)}" style="display:inline-block;padding:14px 24px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:12px;${POLICE}">Ouvrir le ticket &nbsp;→</a>
        </td></tr>
      </table>
    </td></tr>

    <!-- Pied -->
    <tr><td style="background:#ffffff;border-top:1px solid #eef1f4;border-radius:0 0 20px 20px;padding:18px 32px;color:#94a3b8;font-size:12px;line-height:18px;${POLICE}">
      Répondez directement dans l’application pour que ${d.auteur ? echapper(d.auteur.nom.split(' ')[0]) : 'l’auteur'} voie votre réponse.<br>
      Email automatique de G.D. Couverture · Pilotage des activités
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`
}
