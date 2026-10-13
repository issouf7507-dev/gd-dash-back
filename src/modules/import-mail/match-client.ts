// Rapprochement du client extrait avec la table Clients.

export interface ClientConnu {
  id: string
  nom: string
  email: string | null
}

export interface Rapprochement {
  clientId: string | null
  /** sûr = email identique ou nom identique après normalisation ; proche = proposition à confirmer */
  confiance: 'sûr' | 'proche' | 'aucun'
}

const FORMES: [RegExp, string][] = [
  [/\bcabinet\b/g, 'cab'],
  [/\bsyndic(at)?\b/g, 'syndic'],
  [/\bmonsieur\b|\bm\.(?=\s)/g, 'mr'],
  [/\bmadame\b/g, 'mme'],
  [/\bsociete\b|\bste\b/g, 'ste'],
]

/** « Cabinet  Prévimmo » → « cab previmmo » */
export function normaliserNom(nom: string) {
  let n = nom
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
  for (const [re, rep] of FORMES) n = n.replace(re, rep)
  return n.replace(/\s+/g, ' ').trim()
}

/** Ressemblance entre deux textes, de 0 à 1 (distance de Levenshtein rapportée à la longueur). */
export function ressemblance(a: string, b: string) {
  if (a === b) return 1
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length)
}

export function rapprocherClient(clients: ClientConnu[], nom: string | null, email: string | null): Rapprochement {
  if (email) {
    const parEmail = clients.find((c) => c.email && c.email.toLowerCase() === email.toLowerCase())
    if (parEmail) return { clientId: parEmail.id, confiance: 'sûr' }
  }
  if (!nom) return { clientId: null, confiance: 'aucun' }
  const cible = normaliserNom(nom)
  if (!cible) return { clientId: null, confiance: 'aucun' }
  const exact = clients.find((c) => normaliserNom(c.nom) === cible)
  if (exact) return { clientId: exact.id, confiance: 'sûr' }
  // Proche : l'un contient l'autre (ex. « PREVIMMO » / « CAB. PREVIMMO »), sur au moins 5 caractères
  const proche = clients.find((c) => {
    const n = normaliserNom(c.nom)
    return Math.min(n.length, cible.length) >= 5 && (n.includes(cible) || cible.includes(n))
  })
  if (proche) return { clientId: proche.id, confiance: 'proche' }
  // Faute de frappe (ex. « FAUBOURT » / « FAUBOURG ») : nom très ressemblant, à confirmer
  const meilleur = clients
    .map((c) => ({ c, r: ressemblance(normaliserNom(c.nom), cible) }))
    .sort((x, y) => y.r - x.r)[0]
  return meilleur && meilleur.r >= 0.85 && cible.length >= 8 ? { clientId: meilleur.c.id, confiance: 'proche' } : { clientId: null, confiance: 'aucun' }
}
