// Décodage d'un mail brut (.eml / source IMAP) et extraction du texte des PDF joints.
import { simpleParser, type AddressObject } from 'mailparser'
import { extractText, getDocumentProxy } from 'unpdf'
import type { MailLu } from './extract.ts'

export interface PieceJointe {
  nom: string
  contenu: Buffer
}

export interface MailDecode extends MailLu {
  messageId: string
  pdfs: PieceJointe[]
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
    .map((a) => ({ nom: a.filename ?? 'devis.pdf', contenu: a.content }))

  const textes: string[] = []
  for (const p of pdfs) {
    // Un PDF illisible (scanné, protégé) ne bloque pas : il sera signalé par les champs manquants
    textes.push(await texteDuPdf(p.contenu).catch(() => ''))
  }

  const [expediteur] = adresses(m.from)
  return {
    messageId: m.messageId ?? idSecours,
    objet: m.subject ?? '',
    corps: m.text ?? '',
    textePdf: textes.join('\n'),
    expediteur: expediteur ?? { nom: '', email: '' },
    destinataires: [...adresses(m.to), ...adresses(m.cc)],
    date: m.date ?? new Date(),
    pdfs,
  }
}
