/** Un mail à traiter, fourni par une source (dossier, boîte IMAP…). */
export interface MailBrut {
  /** Identifiant dans la source (nom de fichier, UID IMAP) */
  ref: string
  brut: Buffer
}

/** Avancement d'une relève, affiché à l'utilisateur pendant les longs téléchargements. */
export interface Progression {
  etape: 'recherche' | 'téléchargement' | 'traitement'
  faits: number
  /** Inconnu tant que la liste des mails à télécharger n'est pas établie */
  total: number | null
}

export interface SourceMails {
  nom: string
  /** Mails à traiter. `dejaTraite` permet à la source de ne pas télécharger les mails connus. */
  lire(dejaTraite: (messageId: string) => Promise<boolean>, progression?: (p: Progression) => void): Promise<MailBrut[]>
  /** Appelé après traitement (ex. déplacer le fichier). Ne supprime jamais un mail. */
  marquerTraite?(ref: string): Promise<void>
}
