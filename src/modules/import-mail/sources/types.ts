/** Un mail à traiter, fourni par une source (dossier, boîte IMAP…). */
export interface MailBrut {
  /** Identifiant dans la source (nom de fichier, UID IMAP) */
  ref: string
  brut: Buffer
}

export interface SourceMails {
  nom: string
  /** Mails à traiter. `dejaTraite` permet à la source de ne pas télécharger les mails connus. */
  lire(dejaTraite: (messageId: string) => Promise<boolean>): Promise<MailBrut[]>
  /** Appelé après traitement (ex. déplacer le fichier). Ne supprime jamais un mail. */
  marquerTraite?(ref: string): Promise<void>
}
