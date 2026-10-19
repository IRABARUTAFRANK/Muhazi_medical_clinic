/**
 * Suggested Kinyarwanda and French names for a treatment typed in English. Works offline from a
 * small glossary of common clinic terms: whole phrases first, then "<thing> test",
 * "<thing> consultation" and similar patterns. The result is only a suggestion; the form
 * fills the other-language fields while the user has not edited them, and they can correct it.
 */
interface Entry {
  rw: string
  fr: string
}

/** Whole names, lower-case English. */
const PHRASES: Record<string, Entry> = {
  consultation: { rw: 'Kubonana na muganga', fr: 'Consultation' },
  'general consultation': { rw: 'Kubonana na muganga mukuru', fr: 'Consultation générale' },
  'doctor consultation': { rw: 'Kubonana na muganga', fr: 'Consultation médicale' },
  'follow-up consultation': { rw: 'Kugaruka kwa muganga', fr: 'Consultation de suivi' },
  'follow up consultation': { rw: 'Kugaruka kwa muganga', fr: 'Consultation de suivi' },
  'follow-up visit': { rw: 'Kugaruka kwa muganga', fr: 'Visite de suivi' },
  'dental consultation': { rw: "Kubonana n'umuganga w'amenyo", fr: 'Consultation dentaire' },
  'emergency consultation': { rw: 'Ubutabazi bwihuse', fr: "Consultation d'urgence" },
  'tooth extraction': { rw: 'Gukuramo iryinyo', fr: 'Extraction dentaire' },
  extraction: { rw: 'Gukuramo iryinyo', fr: 'Extraction dentaire' },
  'dental filling': { rw: 'Kuziba iryinyo', fr: 'Obturation dentaire' },
  filling: { rw: 'Kuziba iryinyo', fr: 'Obturation dentaire' },
  scaling: { rw: 'Gusukura amenyo', fr: 'Détartrage' },
  'scaling and polishing': { rw: 'Gusukura amenyo', fr: 'Détartrage et polissage' },
  'malaria test': { rw: 'Gupima malariya', fr: 'Test du paludisme' },
  'malaria rdt': { rw: 'Gupima malariya (RDT)', fr: 'TDR paludisme' },
  'blood smear': { rw: 'Gupima malariya mu maraso (GE)', fr: 'Goutte épaisse' },
  'full blood count': { rw: 'Gupima amaraso yose (NFS)', fr: 'Numération formule sanguine' },
  'complete blood count': { rw: 'Gupima amaraso yose (NFS)', fr: 'Numération formule sanguine' },
  'blood sugar': { rw: 'Gupima isukari mu maraso', fr: 'Glycémie' },
  'blood glucose': { rw: 'Gupima isukari mu maraso', fr: 'Glycémie' },
  'urine test': { rw: 'Gupima inkari', fr: "Analyse d'urine" },
  urinalysis: { rw: 'Gupima inkari', fr: "Analyse d'urine" },
  'stool test': { rw: 'Gupima umusarani', fr: 'Examen des selles' },
  'pregnancy test': { rw: 'Gupima inda', fr: 'Test de grossesse' },
  'hiv test': { rw: 'Gupima virusi itera SIDA', fr: 'Test VIH' },
  'typhoid test': { rw: 'Gupima tifoyide', fr: 'Test de la typhoïde' },
  'widal test': { rw: 'Gupima tifoyide (Widal)', fr: 'Test de Widal' },
  'blood group': { rw: "Gupima ubwoko bw'amaraso", fr: 'Groupe sanguin' },
  'blood pressure': { rw: "Gupima umuvuduko w'amaraso", fr: 'Prise de tension artérielle' },
  ultrasound: { rw: 'Ekografi', fr: 'Échographie' },
  'abdominal ultrasound': { rw: "Ekografi y'inda", fr: 'Échographie abdominale' },
  'pelvic ultrasound': { rw: "Ekografi y'agace k'inda yo hasi", fr: 'Échographie pelvienne' },
  'obstetric ultrasound': { rw: "Ekografi y'umugore utwite", fr: 'Échographie obstétricale' },
  'wound dressing': { rw: 'Gupfuka igikomere', fr: 'Pansement' },
  dressing: { rw: 'Gupfuka igikomere', fr: 'Pansement' },
  suturing: { rw: 'Kudoda igikomere', fr: 'Suture' },
  suture: { rw: 'Kudoda igikomere', fr: 'Suture' },
  injection: { rw: 'Urushinge', fr: 'Injection' },
  'iv infusion': { rw: 'Gushyirwamo serumu', fr: 'Perfusion' },
  infusion: { rw: 'Gushyirwamo serumu', fr: 'Perfusion' },
  vaccination: { rw: 'Gukingira', fr: 'Vaccination' },
  'family planning': { rw: 'Kuboneza urubyaro', fr: 'Planification familiale' },
  'antenatal care': { rw: 'Kwisuzumisha utwite', fr: 'Consultation prénatale' },
  'antenatal consultation': { rw: 'Kwisuzumisha utwite', fr: 'Consultation prénatale' },
  delivery: { rw: 'Kubyaza', fr: 'Accouchement' },
  circumcision: { rw: 'Gusiramura', fr: 'Circoncision' },
  'eye examination': { rw: 'Gusuzuma amaso', fr: 'Examen des yeux' },
  'minor surgery': { rw: 'Kubaga gutoya', fr: 'Petite chirurgie' },
  'incision and drainage': { rw: 'Gutobora no gukuramo amashyira', fr: 'Incision et drainage' },
  'bed day': { rw: 'Kurara mu bitaro (ijoro rimwe)', fr: "Journée d'hospitalisation" },
  admission: { rw: 'Kwinjira mu bitaro', fr: 'Hospitalisation' },
  observation: { rw: 'Gukurikiranwa', fr: 'Mise en observation' },
  'medical certificate': { rw: "Icyemezo cy'ubuzima", fr: 'Certificat médical' },
  nebulization: { rw: 'Guhumeka umuti', fr: 'Nébulisation' },
  ecg: { rw: 'Gupima umutima (ECG)', fr: 'Électrocardiogramme (ECG)' },
}

/** Single words used to build "<word> test" / "<word> consultation" names. */
const WORDS: Record<string, Entry> = {
  malaria: { rw: 'malariya', fr: 'paludisme' },
  blood: { rw: 'amaraso', fr: 'sang' },
  urine: { rw: 'inkari', fr: 'urine' },
  sugar: { rw: 'isukari', fr: 'sucre' },
  glucose: { rw: 'isukari', fr: 'glucose' },
  pregnancy: { rw: 'inda', fr: 'grossesse' },
  typhoid: { rw: 'tifoyide', fr: 'typhoïde' },
  hepatitis: { rw: "indwara y'umwijima (hepatite)", fr: 'hépatite' },
  syphilis: { rw: 'mburugu', fr: 'syphilis' },
  tuberculosis: { rw: 'igituntu', fr: 'tuberculose' },
  cholesterol: { rw: 'ibinure mu maraso', fr: 'cholestérol' },
  liver: { rw: 'umwijima', fr: 'foie' },
  kidney: { rw: 'impyiko', fr: 'rein' },
  eye: { rw: 'amaso', fr: 'yeux' },
  dental: { rw: "w'amenyo", fr: 'dentaire' },
  tooth: { rw: 'iryinyo', fr: 'dent' },
  child: { rw: "w'abana", fr: 'pédiatrique' },
  pediatric: { rw: "w'abana", fr: 'pédiatrique' },
  paediatric: { rw: "w'abana", fr: 'pédiatrique' },
  gynecology: { rw: "w'abagore", fr: 'gynécologique' },
  gynaecology: { rw: "w'abagore", fr: 'gynécologique' },
  specialist: { rw: "w'inzobere", fr: 'spécialisée' },
  emergency: { rw: 'yihuse', fr: "d'urgence" },
  night: { rw: 'nijoro', fr: 'de nuit' },
}

export interface Suggestion {
  rw: string
  fr: string
}

const norm = (s: string) => s.toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()

/** Suggest Kinyarwanda and French names for an English treatment name, or null. */
export function suggestNames(english: string): Suggestion | null {
  const n = norm(english)
  if (n.length < 3) return null
  if (PHRASES[n]) return PHRASES[n]
  // "Blood sugar test" → "blood sugar": the glossary entry already names the test.
  const bare = n.replace(/ (test|exam|examination|check)$/, '')
  if (bare !== n && PHRASES[bare]) return PHRASES[bare]

  // "<thing> test" / "test for <thing>"
  const test =
    n.match(/^(?:test for |test )?([a-z]+) (?:test|rdt|screening)$/) ??
    n.match(/^test (?:for )?([a-z]+)$/)
  if (test && WORDS[test[1]!]) {
    const w = WORDS[test[1]!]!
    const fr = /^[aeiouyhé]/.test(w.fr) ? `d'${w.fr}` : `de ${w.fr}`
    return { rw: `Gupima ${w.rw}`, fr: `Test ${fr}` }
  }
  // "<qualifier> consultation"
  const consult = n.match(/^([a-z]+) consultation$/)
  if (consult && WORDS[consult[1]!]) {
    const w = WORDS[consult[1]!]!
    return { rw: `Kubonana na muganga ${w.rw}`, fr: `Consultation ${w.fr}` }
  }
  // A phrase that starts the name: "malaria rdt (adult)" → "malaria rdt"
  for (const [k, v] of Object.entries(PHRASES)) {
    if (k.length >= 5 && (n.startsWith(`${k} `) || n.endsWith(` ${k}`))) {
      const rest = n.startsWith(`${k} `) ? english.slice(k.length).trim() : ''
      return rest ? { rw: `${v.rw} ${rest}`, fr: `${v.fr} ${rest}` } : v
    }
  }
  return null
}
