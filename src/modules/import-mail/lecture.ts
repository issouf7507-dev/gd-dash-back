// Décodage d'un mail brut (.eml / source IMAP) et extraction du texte des PDF joints.
import { simpleParser, type AddressObject } from 'mailparser'
import { extractText, getDocumentProxy } from 'unpdf'
import type { MailLu } from './extract.ts'

export interface PieceJointe {
  nom: string
  contenu: Buffer
  /** Type MIME (application/pdf, image/jpeg…) */
  type: string
}

export interface MailDecode extends MailLu {
  messageId: string
  /** Message-ID cités (In-Reply-To puis References) : le mail répond à / transfère ces mails */
  refsFil: string[]
  pdfs: PieceJointe[]
  /** PDF et photos joints (les images intégrées au corps, comme les logos de signature, sont écartées) */
  pieces: PieceJointe[]
}

const adresses = (a: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((o) => o.value).map((v) => ({ nom: v.name ?? '', email: (v.address ?? '').toLowerCase() }))

export async function texteDuPdf(contenu: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(contenu))
  const { text } = await extractText(pdf, { mergePages: true })
  return text
}

/** `idSecours` sert d'identifiant si le mail n'a pas d'en-tête Message-ID (rare). */
export async function decoderMail(brut: Buffer, idSecours: string): Promise<MailDecode> {
  const m = await simpleParser(brut)
  const pdfs = m.attachments
    .filter((a) => a.contentType === 'application/pdf' || /\.pdf$/i.test(a.filename ?? ''))
    .map((a) => ({ nom: a.filename ?? 'devis.pdf', contenu: a.content, type: 'application/pdf' }))
  const photos = m.attachments
    .filter((a) => a.contentType.startsWith('image/') && !a.related && a.contentDisposition === 'attachment')
    .map((a, i) => ({ nom: a.filename ?? `photo-${i + 1}.${a.contentType.split('/')[1]}`, contenu: a.content, type: a.contentType }))

  const textes: string[] = []
  for (const p of pdfs) {
    // Un PDF illisible (scanné, protégé) ne bloque pas : il sera signalé par les champs manquants
    textes.push(await texteDuPdf(p.contenu).catch(() => ''))
  }

  const [expediteur] = adresses(m.from)
  return {
    messageId: m.messageId ?? idSecours,
    // Les plus récents d'abord ; on en garde 20 (les longs fils citent tout l'historique)
    refsFil: [...new Set([m.inReplyTo, ...[m.references ?? []].flat().reverse()].filter((r): r is string => !!r))].slice(0, 20),
    objet: m.subject ?? '',
    corps: m.text ?? '',
    textePdf: textes.join('\n'),
    expediteur: expediteur ?? { nom: '', email: '' },
    destinataires: [...adresses(m.to), ...adresses(m.cc)],
    date: m.date ?? new Date(),
    pdfs,
    pieces: [...pdfs, ...photos],
  }
}
