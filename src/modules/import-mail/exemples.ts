// Faux mails SolutionsBTP pour développer et tester sans boîte mail.
// ⚠️ Format INVENTÉ (objet, texte, mise en page du PDF) : à remplacer par un vrai mail dès que possible.

/** PDF minimal d'une page (police Helvetica), une ligne de texte par élément. */
export function pdfSimple(lignesTexte: string[]): Buffer {
  const echapper = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const contenu = ['BT', '/F1 11 Tf', '14 TL', '50 790 Td', ...lignesTexte.map((l) => `(${echapper(l)}) '`), 'ET'].join('\n')
  // WinAnsi : l'apostrophe typographique est le caractère 0x92
  const flux = Buffer.from(contenu.replace(/’/g, '\x92'), 'latin1')
  const objets = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets: number[] = []
  let taille = parts[0].length
  const ajouter = (b: Buffer) => {
    parts.push(b)
    taille += b.length
  }
  objets.forEach((o, i) => {
    offsets.push(taille)
    ajouter(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1'))
  })
  offsets.push(taille)
  ajouter(Buffer.concat([Buffer.from(`5 0 obj\n<< /Length ${flux.length} >>\nstream\n`, 'latin1'), flux, Buffer.from('\nendstream\nendobj\n', 'latin1')]))
  const xref = taille
  ajouter(
    Buffer.from(
      `xref\n0 6\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
      'latin1',
    ),
  )
  return Buffer.concat(parts)
}

interface MailExemple {
  messageId: string
  date: Date
  de: string
  a: string
  objet: string
  texte: string
  pdf?: { nom: string; lignes: string[] }
}

/** Mail au format .eml (multipart, texte + PDF en base64). */
export function eml(m: MailExemple): Buffer {
  const b = 'frontiere-gd-0001'
  const enTete = (s: string) => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`
  const base64 = (buf: Buffer) => buf.toString('base64').replace(/.{76}/g, '$&\r\n')
  const parties = [
    [`--${b}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', base64(Buffer.from(m.texte))].join('\r\n'),
  ]
  if (m.pdf) {
    parties.push(
      [
        `--${b}`,
        `Content-Type: application/pdf; name="${m.pdf.nom}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${m.pdf.nom}"`,
        '',
        base64(pdfSimple(m.pdf.lignes)),
      ].join('\r\n'),
    )
  }
  return Buffer.from(
    [
      `Message-ID: <${m.messageId}>`,
      `Date: ${m.date.toUTCString()}`,
      `From: ${m.de}`,
      `To: ${m.a}`,
      `Subject: ${enTete(m.objet)}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${b}"`,
      '',
      ...parties,
      `--${b}--`,
      '',
    ].join('\r\n'),
  )
}

const DE = '"GD Couverture via SolutionsBTP" <noreply@solutionsbtp.fr>'
const signature = '\n\nCordialement,\nL’équipe GD Couverture\n01 23 45 67 89'

/**
 * Texte du FORMAT RECOMMANDÉ (modèle d'e-mail à paramétrer dans SolutionsBTP).
 * Les {…} sont les champs de fusion du logiciel ; la fiche du bas est lue par la plateforme.
 */
export function texteFormatRecommande(v: {
  numero: string
  date: string
  client: string
  adresse: string
  objet: string
  montantHT: string
  metier: string
  conducteur: string
}) {
  return [
    'Bonjour,',
    '',
    `Veuillez trouver ci-joint notre devis n° ${v.numero} pour les travaux suivants : ${v.objet.toLowerCase()}.`,
    'Nous restons à votre disposition pour toute question.',
    '',
    'Cordialement,',
    'L’équipe GD Couverture',
    '01 23 45 67 89',
    '',
    '──────── Récapitulatif du devis ────────',
    `Réf. devis : ${v.numero}`,
    `Date : ${v.date}`,
    `Client : ${v.client}`,
    `Adresse chantier : ${v.adresse}`,
    `Objet : ${v.objet}`,
    `Montant HT : ${v.montantHT}`,
    `Métier : ${v.metier}`,
    `Conducteur : ${v.conducteur}`,
    '─────────────────────────────────────────',
  ].join('\n')
}

/** Les cas de base : devis complet, client inconnu, mail qui n'est pas un devis, format recommandé. */
export function exemplesMails(base = new Date('2026-10-09T09:30:00Z')) {
  return {
    '01-devis-complet.eml': eml({
      messageId: 'exemple-0001@solutionsbtp.fr',
      date: base,
      de: DE,
      a: '"CAB. PREVIMMO" <gestion@previmmo.example>',
      objet: 'Devis DGD26-0931 - CAB. PREVIMMO',
      texte: `Bonjour,\n\nVeuillez trouver ci-joint notre devis n° DGD26-0931 concernant les travaux au 12 rue de Rivoli.${signature}`,
      pdf: {
        nom: 'Devis_DGD26-0931.pdf',
        lignes: [
          'GD COUVERTURE - 8 rue de l’Industrie 93200 Saint-Denis',
          'DEVIS N° DGD26-0931',
          'Date : 09/10/2026',
          'Client : CAB. PREVIMMO',
          '46 rue de Verneuil 75007 PARIS',
          'Adresse du chantier : 12 rue de Rivoli',
          '75004 PARIS',
          'Objet : Réfection partielle de la couverture zinc et remplacement des gouttières',
          'Désignation Qté PU HT Total HT',
          'Dépose et repose couverture zinc 25 m² 120,00 3 000,00',
          'Remplacement gouttière zinc 12 ml 85,00 1 020,00',
          'Installation de chantier 1 ens 230,00 230,00',
          'Total HT 4 250,00 €',
          'TVA 10 % 425,00 €',
          'Total TTC 4 675,00 €',
        ],
      },
    }),
    '02-client-inconnu.eml': eml({
      messageId: 'exemple-0002@solutionsbtp.fr',
      date: new Date(base.getTime() + 3_600_000),
      de: DE,
      a: '"Mme Durand" <durand.c@example.com>',
      objet: 'Devis DGD26-0932',
      texte: `Madame,\n\nVous trouverez ci-joint le devis DGD26-0932 pour la recherche de fuite.${signature}`,
      pdf: {
        nom: 'Devis_DGD26-0932.pdf',
        lignes: [
          'DEVIS N° DGD26-0932',
          'Date : 09/10/2026',
          'Client : Mme DURAND Claire',
          'Lieu d’intervention : 7 avenue Mozart',
          '75016 PARIS',
          'Objet : Recherche de fuite et remplacement canalisation PVC',
          'Recherche de fuite 1 forfait 180,00',
          'Remplacement canalisation PVC 4 ml 95,00 380,00',
          'Total HT 560,00 €',
          'Total TTC 616,00 €',
        ],
      },
    }),
    '03-pas-un-devis.eml': eml({
      messageId: 'exemple-0003@solutionsbtp.fr',
      date: new Date(base.getTime() + 7_200_000),
      de: DE,
      a: '"Admin GD" <admin@gdcouverture.fr>',
      objet: 'Votre mot de passe SolutionsBTP expire bientôt',
      texte: `Bonjour,\n\nVotre mot de passe expire dans 7 jours. Pensez à le modifier.${signature}`,
    }),
    '04-format-recommande.eml': eml({
      messageId: 'exemple-0004@solutionsbtp.fr',
      date: new Date(base.getTime() + 10_800_000),
      de: DE,
      a: '"SDC 164 FAUBOURG SAINT-ANTOINE" <sdc164@example.com>',
      objet: 'Devis n° DGD26-0933 - SDC 164 FAUBOURG SAINT-ANTOINE',
      texte: texteFormatRecommande({
        numero: 'DGD26-0933',
        date: '09/10/2026',
        client: 'SDC 164 FAUBOURG SAINT-ANTOINE',
        adresse: '164 rue du Faubourg Saint-Antoine, 75012 Paris',
        objet: 'Réfection de l’étanchéité de la terrasse du 6e étage',
        montantHT: '7 980,00 €',
        metier: 'Étanchéité',
        conducteur: 'Christian FUANANA',
      }),
      // PDF volontairement sans mise en page exploitable : la fiche du mail suffit
      pdf: { nom: 'Devis_DGD26-0933.pdf', lignes: ['GD COUVERTURE', 'Devis DGD26-0933', 'Voir détail en pages suivantes'] },
    }),
  }
}
