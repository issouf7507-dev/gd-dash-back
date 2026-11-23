// Email d'invitation : identifiant et mot de passe provisoire, dans le style de l'appli (même gabarit que les tickets).
// Construit pour les messageries : tableaux, styles en ligne, pas d'image distante. Les textes passent par `echapper`.

export interface DonneesInvitation {
  prenom: string
  email: string
  motDePasse: string
  role: string
  invitant: string
  /** Adresse de la page de connexion */
  lienConnexion: string
  /** Renvoi des accès à une personne qui avait déjà un compte */
  renvoi: boolean
}

const echapper = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
const POLICE = "font-family:Inter,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
const MONO = "font-family:'SF Mono',Consolas,'Liberation Mono',Menlo,monospace"

export function objetInvitation(d: Pick<DonneesInvitation, 'renvoi'>) {
  return d.renvoi ? 'Vos nouveaux accès au tableau de bord G.D. Couverture' : 'Votre accès au tableau de bord G.D. Couverture'
}

/** Version texte (messageries sans HTML, aperçu) */
export function texteInvitation(d: DonneesInvitation) {
  return [
    `Bonjour ${d.prenom},`,
    '',
    d.renvoi ? `${d.invitant} vous a envoyé de nouveaux accès au tableau de bord G.D. Couverture.` : `${d.invitant} vous a ouvert un accès au tableau de bord G.D. Couverture.`,
    '',
    `Identifiant  : ${d.email}`,
    `Mot de passe : ${d.motDePasse}`,
    `Rôle         : ${d.role}`,
    '',
    `Se connecter : ${d.lienConnexion}`,
    '',
    'À votre première connexion, vous pourrez garder ce mot de passe ou en choisir un nouveau.',
    'Ne transférez pas cet email.',
    '',
    'G.D. Couverture',
  ].join('\n')
}

function ligneAcces(libelle: string, valeur: string, mono = false) {
  return `<tr>
    <td style="padding:12px 18px;width:120px;color:#64748b;font-size:13px;border-bottom:1px solid #eef1f4;${POLICE}">${libelle}</td>
    <td style="padding:12px 18px;color:#0f172a;font-size:${mono ? 16 : 14}px;font-weight:600;border-bottom:1px solid #eef1f4;${mono ? `${MONO};letter-spacing:1px` : POLICE}">${valeur}</td>
  </tr>`
}

export function htmlInvitation(d: DonneesInvitation) {
  const intro = d.renvoi
    ? `${echapper(d.invitant)} vous a envoyé de <strong>nouveaux accès</strong> au tableau de bord G.D. Couverture. L’ancien mot de passe ne fonctionne plus.`
    : `${echapper(d.invitant)} vous a ouvert un accès au <strong>tableau de bord G.D. Couverture</strong> : devis, interventions, chantiers et facturation au même endroit.`

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${objetInvitation(d)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f3f5;${POLICE}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Votre identifiant et votre mot de passe pour vous connecter.</div>

<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f1f3f5">
<tr><td align="center" style="padding:32px 16px">

  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px">

    <!-- En-tête noir à lueur bleue -->
    <tr><td style="background-color:#08172d;background-image:linear-gradient(135deg,#1c51a1 0%,#08172d 55%,#000000 100%);border-radius:20px 20px 0 0;padding:28px 32px 34px">
      <div style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:-0.2px;${POLICE}">G.D. Couverture</div>
      <div style="color:rgba(255,255,255,0.55);font-size:12px;margin-top:2px;${POLICE}">Pilotage des activités</div>
      <div style="margin-top:30px;color:#ffffff;font-size:28px;line-height:34px;font-weight:600;letter-spacing:-0.5px;${POLICE}">Bienvenue ${echapper(d.prenom)} 👋</div>
      <div style="margin-top:8px;color:rgba(255,255,255,0.65);font-size:14px;line-height:21px;${POLICE}">${d.renvoi ? 'Voici vos nouveaux accès.' : 'Votre espace est prêt.'}</div>
    </td></tr>

    <!-- Carte -->
    <tr><td style="background:#ffffff;padding:28px 32px 8px;${POLICE}">
      <p style="margin:0;color:#334155;font-size:14px;line-height:22px">${intro}</p>

      <div style="margin-top:24px;color:#64748b;font-size:12px;font-weight:600;letter-spacing:1px;text-transform:uppercase">Vos accès</div>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:10px;border:1px solid #e2e8f0;border-radius:14px;border-collapse:separate;overflow:hidden;background:#f8fafc">
        ${ligneAcces('Identifiant', `<a style="color:#0f172a;text-decoration:none">${echapper(d.email)}</a>`)}
        ${ligneAcces('Mot de passe', echapper(d.motDePasse), true)}
        <tr>
          <td style="padding:12px 18px;width:120px;color:#64748b;font-size:13px;${POLICE}">Rôle</td>
          <td style="padding:12px 18px;color:#0f172a;font-size:14px;${POLICE}">${echapper(d.role)}</td>
        </tr>
      </table>

      <!-- Bouton -->
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:26px 0 22px">
        <tr><td style="border-radius:12px;background:#000000">
          <a href="${echapper(d.lienConnexion)}" style="display:inline-block;padding:14px 26px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:12px;${POLICE}">Se connecter &nbsp;→</a>
        </td></tr>
      </table>

      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:24px">
        <tr><td style="padding:14px 16px;border-radius:12px;background:#edf4fc;color:#143c7a;font-size:13px;line-height:20px;${POLICE}">
          🔒 À votre première connexion, vous pourrez <strong>garder ce mot de passe ou en choisir un nouveau</strong>. Le choix vous appartient.
        </td></tr>
      </table>
    </td></tr>

    <!-- Pied -->
    <tr><td style="background:#ffffff;border-top:1px solid #eef1f4;border-radius:0 0 20px 20px;padding:18px 32px;color:#94a3b8;font-size:12px;line-height:18px;${POLICE}">
      Ne transférez pas cet email : il contient votre mot de passe.<br>
      Email automatique de G.D. Couverture · Pilotage des activités
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`
}
