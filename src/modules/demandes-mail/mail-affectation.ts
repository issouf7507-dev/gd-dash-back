// Email à la personne à qui l'on affecte des demandes reçues : de quoi il s'agit et un lien pour les traiter.
// Même style que les autres emails de l'appli (tableaux, styles en ligne). Les textes passent par `echapper`.

export interface DemandeAffectee {
  expediteur: string
  objet: string
  recuLe: Date
  boite: string
  extrait: string
  urgent: boolean
  lien: string
}

export interface DonneesAffectation {
  prenom: string
  par: string
  demandes: DemandeAffectee[]
  /** Page « Mes demandes » */
  lienListe: string
}

const echapper = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const POLICE = "font-family:Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
/** Au-delà, la liste renvoie vers « Mes demandes » */
const AFFICHEES = 8

/** « Nom <a@b.fr> » → Nom */
const nomExpediteur = (s: string) => (s.match(/^\s*"?([^"<]*?)"?\s*</)?.[1] || s).trim()
const date = (d: Date) => d.toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'medium', timeStyle: 'short' })

export function objetAffectation(d: DonneesAffectation) {
  return d.demandes.length === 1 ? `À traiter : ${d.demandes[0].objet || '(sans objet)'}` : `${d.demandes.length} demandes vous ont été affectées`
}

export function texteAffectation(d: DonneesAffectation) {
  const n = d.demandes.length
  return [
    `Bonjour ${d.prenom},`,
    '',
    `${d.par} vous a affecté ${n === 1 ? 'une demande' : `${n} demandes`} à traiter :`,
    '',
    ...d.demandes.slice(0, AFFICHEES).flatMap((x) => [`• ${x.urgent ? '[URGENT] ' : ''}${x.objet || '(sans objet)'} — ${nomExpediteur(x.expediteur)}, ${date(x.recuLe)}`, `  ${x.lien}`]),
    ...(n > AFFICHEES ? [`… et ${n - AFFICHEES} autre(s)`] : []),
    '',
    `Toutes vos demandes : ${d.lienListe}`,
    '',
    'G.D. Couverture',
  ].join('\n')
}

function carte(x: DemandeAffectee, seule: boolean) {
  return `<tr><td style="padding:0 0 12px">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border:1px solid #e2e8f0;border-radius:14px;border-collapse:separate;background:#ffffff">
      <tr><td style="padding:16px 18px;${POLICE}">
        <div style="font-size:12px;color:#64748b">
          ${x.urgent ? '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#fef2f2;color:#b91c1c;font-weight:700;font-size:11px;margin-right:6px">URGENT</span>' : ''}
          <span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#edf4fc;color:#1c51a1;font-weight:600;font-size:11px;margin-right:6px">${echapper(x.boite)}</span>
          ${echapper(nomExpediteur(x.expediteur))} · ${echapper(date(x.recuLe))}
        </div>
        <div style="margin-top:8px;color:#0f172a;font-size:15px;font-weight:600;line-height:21px">${echapper(x.objet || '(sans objet)')}</div>
        ${x.extrait ? `<div style="margin-top:6px;color:#475569;font-size:13px;line-height:20px">${echapper(x.extrait)}</div>` : ''}
        ${
          seule
            ? ''
            : `<div style="margin-top:10px"><a href="${echapper(x.lien)}" style="color:#1c51a1;font-size:13px;font-weight:600;text-decoration:none">Traiter →</a></div>`
        }
      </td></tr>
    </table>
  </td></tr>`
}

export function htmlAffectation(d: DonneesAffectation) {
  const n = d.demandes.length
  const seule = n === 1
  const bouton = seule ? { lien: d.demandes[0].lien, texte: 'Traiter la demande' } : { lien: d.lienListe, texte: 'Voir mes demandes' }

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${echapper(objetAffectation(d))}</title>
</head>
<body style="margin:0;padding:0;background:#f1f3f5;${POLICE}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${echapper(`${d.par} vous a affecté ${seule ? 'une demande' : `${n} demandes`} à traiter.`)}</div>

<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f1f3f5">
<tr><td align="center" style="padding:32px 16px">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px">

    <tr><td style="background-color:#08172d;background-image:linear-gradient(135deg,#1c51a1 0%,#08172d 55%,#000000 100%);border-radius:20px 20px 0 0;padding:28px 32px 32px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
        <td style="${POLICE}">
          <div style="color:#ffffff;font-size:16px;font-weight:700">G.D. Couverture</div>
          <div style="color:rgba(255,255,255,0.55);font-size:12px;margin-top:2px">Demandes reçues par mail</div>
        </td>
        <td align="right" style="${POLICE}">
          <span style="display:inline-block;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,0.12);color:#ffffff;font-size:12px;font-weight:600">${seule ? 'Nouvelle demande' : `${n} demandes`}</span>
        </td>
      </tr></table>
      <div style="margin-top:26px;color:#ffffff;font-size:26px;line-height:32px;font-weight:600;letter-spacing:-0.5px;${POLICE}">${seule ? 'Une demande vous attend' : `${n} demandes vous attendent`}</div>
      <div style="margin-top:8px;color:rgba(255,255,255,0.65);font-size:14px;line-height:21px;${POLICE}">Bonjour ${echapper(d.prenom)}, ${echapper(d.par)} vous ${seule ? 'l’a affectée' : 'les a affectées'} pour que vous ${seule ? 'la' : 'les'} traitiez.</div>
    </td></tr>

    <tr><td style="background:#f8fafc;padding:24px 32px 8px">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        ${d.demandes.slice(0, AFFICHEES).map((x) => carte(x, seule)).join('')}
      </table>
      ${n > AFFICHEES ? `<p style="margin:0 0 12px;color:#64748b;font-size:13px;${POLICE}">… et ${n - AFFICHEES} autre${n - AFFICHEES > 1 ? 's' : ''}.</p>` : ''}

      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:10px 0 26px">
        <tr><td style="border-radius:12px;background:#000000">
          <a href="${echapper(bouton.lien)}" style="display:inline-block;padding:14px 26px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:12px;${POLICE}">${bouton.texte} &nbsp;→</a>
        </td></tr>
      </table>
    </td></tr>

    <tr><td style="background:#ffffff;border-top:1px solid #eef1f4;border-radius:0 0 20px 20px;padding:18px 32px;color:#94a3b8;font-size:12px;line-height:18px;${POLICE}">
      Retrouvez toutes vos demandes dans <a href="${echapper(d.lienListe)}" style="color:#64748b">Mes demandes</a>.<br>
      Email automatique de G.D. Couverture · Pilotage des activités
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`
}
