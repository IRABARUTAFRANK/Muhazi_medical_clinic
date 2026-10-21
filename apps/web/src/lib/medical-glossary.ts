/**
 * Suggested Kinyarwanda and French names for a treatment (or category) typed in English. Works
 * offline from a glossary of common clinic terms: whole phrases first, then a single disease or
 * word ("Malaria"), "<disease> treatment", "<thing> test", "<qualifier> consultation", with
 * qualifiers such as "severe", "adult" or "child" anywhere in the name. The result is only a
 * suggestion: the form fills the other-language fields while the user has not edited them, and
 * they correct it when it is not what they mean. Kinyarwanda wording should be checked by a
 * native speaker of the clinic.
 */
interface Entry {
  rw: string
  fr: string
}

/** Whole names, lower-case English. */
const PHRASES: Record<string, Entry> = {
  // consultations and fees
  consultation: { rw: 'Kubonana na muganga', fr: 'Consultation' },
  'general consultation': { rw: 'Kubonana na muganga mukuru', fr: 'Consultation générale' },
  'doctor consultation': { rw: 'Kubonana na muganga', fr: 'Consultation médicale' },
  'medical consultation': { rw: 'Kubonana na muganga', fr: 'Consultation médicale' },
  'follow-up consultation': { rw: 'Kugaruka kwa muganga', fr: 'Consultation de suivi' },
  'follow up consultation': { rw: 'Kugaruka kwa muganga', fr: 'Consultation de suivi' },
  'follow-up visit': { rw: 'Kugaruka kwa muganga', fr: 'Visite de suivi' },
  'follow up': { rw: 'Kugaruka kwa muganga', fr: 'Suivi' },
  'dental consultation': { rw: "Kubonana n'umuganga w'amenyo", fr: 'Consultation dentaire' },
  'emergency consultation': { rw: 'Ubutabazi bwihuse', fr: "Consultation d'urgence" },
  'consultation fee': { rw: 'Amafaranga yo kubonana na muganga', fr: 'Frais de consultation' },
  registration: { rw: 'Kwiyandikisha', fr: 'Enregistrement' },
  'registration fee': { rw: 'Amafaranga yo kwiyandikisha', fr: "Frais d'enregistrement" },
  'file fee': { rw: 'Amafaranga ya dosiye', fr: 'Frais de dossier' },
  'patient card': { rw: "Ikarita y'umurwayi", fr: 'Carte de patient' },
  'medical certificate': { rw: "Icyemezo cy'ubuzima", fr: 'Certificat médical' },
  'medical report': { rw: 'Raporo ya muganga', fr: 'Rapport médical' },
  'home visit': { rw: 'Gusura umurwayi mu rugo', fr: 'Visite à domicile' },
  ambulance: { rw: 'Imbangukiragutabara', fr: 'Ambulance' },
  counselling: { rw: 'Ubujyanama', fr: 'Conseil' },
  counseling: { rw: 'Ubujyanama', fr: 'Conseil' },
  'nutrition counselling': { rw: 'Inama ku mirire', fr: 'Conseil nutritionnel' },
  'hiv counselling and testing': {
    rw: 'Ubujyanama no gupima virusi itera SIDA',
    fr: 'Conseil et dépistage du VIH',
  },
  // dental
  'tooth extraction': { rw: 'Gukuramo iryinyo', fr: 'Extraction dentaire' },
  extraction: { rw: 'Gukuramo iryinyo', fr: 'Extraction dentaire' },
  'dental filling': { rw: 'Kuziba iryinyo', fr: 'Obturation dentaire' },
  filling: { rw: 'Kuziba iryinyo', fr: 'Obturation dentaire' },
  scaling: { rw: 'Gusukura amenyo', fr: 'Détartrage' },
  'scaling and polishing': { rw: 'Gusukura amenyo', fr: 'Détartrage et polissage' },
  'teeth cleaning': { rw: 'Gusukura amenyo', fr: 'Détartrage' },
  'root canal': { rw: "Kuvura umuzi w'iryinyo", fr: 'Traitement de canal' },
  'root canal treatment': { rw: "Kuvura umuzi w'iryinyo", fr: 'Traitement de canal' },
  'dental x-ray': { rw: "Radiyo y'amenyo", fr: 'Radiographie dentaire' },
  denture: { rw: "Amenyo y'amakorano", fr: 'Prothèse dentaire' },
  dentures: { rw: "Amenyo y'amakorano", fr: 'Prothèse dentaire' },
  // laboratory
  'malaria test': { rw: 'Gupima malariya', fr: 'Test du paludisme' },
  'malaria rdt': { rw: 'Gupima malariya (RDT)', fr: 'TDR paludisme' },
  'blood smear': { rw: 'Gupima malariya mu maraso (GE)', fr: 'Goutte épaisse' },
  'thick blood smear': { rw: 'Gupima malariya mu maraso (GE)', fr: 'Goutte épaisse' },
  'full blood count': { rw: 'Gupima amaraso yose (NFS)', fr: 'Numération formule sanguine' },
  'complete blood count': { rw: 'Gupima amaraso yose (NFS)', fr: 'Numération formule sanguine' },
  fbc: { rw: 'Gupima amaraso yose (NFS)', fr: 'Numération formule sanguine' },
  cbc: { rw: 'Gupima amaraso yose (NFS)', fr: 'Numération formule sanguine' },
  'blood test': { rw: 'Gupima amaraso', fr: 'Analyse de sang' },
  'blood sugar': { rw: 'Gupima isukari mu maraso', fr: 'Glycémie' },
  'blood glucose': { rw: 'Gupima isukari mu maraso', fr: 'Glycémie' },
  'fasting blood sugar': { rw: 'Gupima isukari mu maraso utariye', fr: 'Glycémie à jeun' },
  'fasting glucose': { rw: 'Gupima isukari mu maraso utariye', fr: 'Glycémie à jeun' },
  'glucose fasting': { rw: 'Gupima isukari mu maraso utariye', fr: 'Glycémie à jeun' },
  haemoglobin: { rw: "Gupima ingano y'amaraso (Hb)", fr: "Dosage de l'hémoglobine" },
  hemoglobin: { rw: "Gupima ingano y'amaraso (Hb)", fr: "Dosage de l'hémoglobine" },
  'hb test': { rw: "Gupima ingano y'amaraso (Hb)", fr: "Dosage de l'hémoglobine" },
  'urine test': { rw: 'Gupima inkari', fr: "Analyse d'urine" },
  urinalysis: { rw: 'Gupima inkari', fr: "Analyse d'urine" },
  'stool test': { rw: 'Gupima umusarani', fr: 'Examen des selles' },
  'stool examination': { rw: 'Gupima umusarani', fr: 'Examen des selles' },
  'sputum test': { rw: 'Gupima igikororwa', fr: 'Examen des crachats' },
  'pregnancy test': { rw: 'Gupima inda', fr: 'Test de grossesse' },
  'hiv test': { rw: 'Gupima virusi itera SIDA', fr: 'Test VIH' },
  'typhoid test': { rw: 'Gupima tifoyide', fr: 'Test de la typhoïde' },
  'widal test': { rw: 'Gupima tifoyide (Widal)', fr: 'Test de Widal' },
  'blood group': { rw: "Gupima ubwoko bw'amaraso", fr: 'Groupe sanguin' },
  'blood grouping': { rw: "Gupima ubwoko bw'amaraso", fr: 'Groupe sanguin' },
  'liver function test': { rw: "Gupima imikorere y'umwijima", fr: 'Bilan hépatique' },
  'kidney function test': { rw: "Gupima imikorere y'impyiko", fr: 'Bilan rénal' },
  'renal function test': { rw: "Gupima imikorere y'impyiko", fr: 'Bilan rénal' },
  'lipid profile': { rw: 'Gupima ibinure mu maraso', fr: 'Bilan lipidique' },
  'thyroid test': { rw: 'Gupima imikorere ya tiroyide', fr: 'Bilan thyroïdien' },
  'h. pylori test': { rw: 'Gupima mikorobe yo mu gifu (H. pylori)', fr: 'Test H. pylori' },
  'h pylori test': { rw: 'Gupima mikorobe yo mu gifu (H. pylori)', fr: 'Test H. pylori' },
  culture: { rw: 'Gutubura mikorobe (culture)', fr: 'Culture' },
  'covid test': { rw: 'Gupima COVID-19', fr: 'Test COVID-19' },
  'covid-19 test': { rw: 'Gupima COVID-19', fr: 'Test COVID-19' },
  // vital signs and checks
  'blood pressure': { rw: "Gupima umuvuduko w'amaraso", fr: 'Prise de tension artérielle' },
  'blood pressure check': { rw: "Gupima umuvuduko w'amaraso", fr: 'Prise de tension artérielle' },
  'vision test': { rw: 'Gupima amaso', fr: 'Test de vision' },
  'eye examination': { rw: 'Gusuzuma amaso', fr: 'Examen des yeux' },
  'eye test': { rw: 'Gupima amaso', fr: 'Test de vision' },
  glasses: { rw: 'Amadarubindi', fr: 'Lunettes' },
  'ear cleaning': { rw: 'Gusukura amatwi', fr: "Lavage d'oreille" },
  'ear syringing': { rw: 'Gusukura amatwi', fr: "Lavage d'oreille" },
  // imaging
  ultrasound: { rw: 'Ekografi', fr: 'Échographie' },
  'abdominal ultrasound': { rw: "Ekografi y'inda", fr: 'Échographie abdominale' },
  'pelvic ultrasound': { rw: "Ekografi y'agace k'inda yo hasi", fr: 'Échographie pelvienne' },
  'obstetric ultrasound': { rw: "Ekografi y'umugore utwite", fr: 'Échographie obstétricale' },
  'pregnancy ultrasound': { rw: "Ekografi y'umugore utwite", fr: 'Échographie obstétricale' },
  'breast ultrasound': { rw: "Ekografi y'amabere", fr: 'Échographie mammaire' },
  'x-ray': { rw: 'Radiyo', fr: 'Radiographie' },
  xray: { rw: 'Radiyo', fr: 'Radiographie' },
  'chest x-ray': { rw: "Radiyo y'igituza", fr: 'Radiographie thoracique' },
  ecg: { rw: 'Gupima umutima (ECG)', fr: 'Électrocardiogramme (ECG)' },
  // nursing and procedures
  'wound dressing': { rw: 'Gupfuka igikomere', fr: 'Pansement' },
  dressing: { rw: 'Gupfuka igikomere', fr: 'Pansement' },
  suturing: { rw: 'Kudoda igikomere', fr: 'Suture' },
  suture: { rw: 'Kudoda igikomere', fr: 'Suture' },
  'stitch removal': { rw: 'Gukuramo indodo', fr: 'Ablation des fils' },
  'removal of stitches': { rw: 'Gukuramo indodo', fr: 'Ablation des fils' },
  injection: { rw: 'Urushinge', fr: 'Injection' },
  'im injection': { rw: 'Urushinge mu nyama (IM)', fr: 'Injection intramusculaire' },
  'iv injection': { rw: 'Urushinge mu mutsi (IV)', fr: 'Injection intraveineuse' },
  'iv infusion': { rw: 'Gushyirwamo serumu', fr: 'Perfusion' },
  infusion: { rw: 'Gushyirwamo serumu', fr: 'Perfusion' },
  drip: { rw: 'Serumu', fr: 'Perfusion' },
  'blood transfusion': { rw: 'Guterwa amaraso', fr: 'Transfusion sanguine' },
  'oxygen therapy': { rw: 'Guhabwa umwuka wa oxygène', fr: 'Oxygénothérapie' },
  catheterization: { rw: 'Gushyirwamo sonde', fr: 'Sondage urinaire' },
  'urinary catheter': { rw: "Sonde y'inkari", fr: 'Sonde urinaire' },
  nebulization: { rw: 'Guhumeka umuti', fr: 'Nébulisation' },
  nebulisation: { rw: 'Guhumeka umuti', fr: 'Nébulisation' },
  'minor surgery': { rw: 'Kubaga gutoya', fr: 'Petite chirurgie' },
  'incision and drainage': { rw: 'Gutobora no gukuramo amashyira', fr: 'Incision et drainage' },
  'abscess drainage': { rw: 'Gutobora ikibyimba', fr: "Drainage d'abcès" },
  'foreign body removal': {
    rw: 'Gukuramo ikintu cyinjiye mu mubiri',
    fr: 'Extraction de corps étranger',
  },
  'plaster cast': { rw: 'Gushyira isima ku gufa', fr: 'Plâtre' },
  circumcision: { rw: 'Gusiramura', fr: 'Circoncision' },
  physiotherapy: { rw: 'Ubugororangingo', fr: 'Kinésithérapie' },
  vaccination: { rw: 'Gukingira', fr: 'Vaccination' },
  immunization: { rw: 'Gukingira', fr: 'Vaccination' },
  immunisation: { rw: 'Gukingira', fr: 'Vaccination' },
  'growth monitoring': { rw: "Gukurikirana imikurire y'umwana", fr: 'Suivi de croissance' },
  // maternity and family planning
  'family planning': { rw: 'Kuboneza urubyaro', fr: 'Planification familiale' },
  'antenatal care': { rw: 'Kwisuzumisha utwite', fr: 'Consultation prénatale' },
  'antenatal consultation': { rw: 'Kwisuzumisha utwite', fr: 'Consultation prénatale' },
  anc: { rw: 'Kwisuzumisha utwite', fr: 'Consultation prénatale' },
  'postnatal care': { rw: 'Kwisuzumisha nyuma yo kubyara', fr: 'Consultation postnatale' },
  delivery: { rw: 'Kubyaza', fr: 'Accouchement' },
  'normal delivery': { rw: 'Kubyara bisanzwe', fr: 'Accouchement normal' },
  'caesarean section': { rw: 'Kubagwa ubyara', fr: 'Césarienne' },
  'cesarean section': { rw: 'Kubagwa ubyara', fr: 'Césarienne' },
  implant: { rw: 'Agapira ko mu kuboko', fr: 'Implant contraceptif' },
  iud: { rw: 'Agapira ko mu mura (IUD)', fr: 'Stérilet' },
  'depo-provera': { rw: 'Urushinge rwo kuboneza urubyaro', fr: 'Injection contraceptive' },
  // beds
  'bed day': { rw: 'Kurara mu bitaro (ijoro rimwe)', fr: "Journée d'hospitalisation" },
  admission: { rw: 'Kwinjira mu bitaro', fr: 'Hospitalisation' },
  hospitalisation: { rw: 'Kurara mu bitaro', fr: 'Hospitalisation' },
  hospitalization: { rw: 'Kurara mu bitaro', fr: 'Hospitalisation' },
  observation: { rw: 'Gukurikiranwa', fr: 'Mise en observation' },
  // categories and departments
  laboratory: { rw: 'Laboratwari', fr: 'Laboratoire' },
  pharmacy: { rw: 'Farumasi', fr: 'Pharmacie' },
  maternity: { rw: 'Kubyaza', fr: 'Maternité' },
  dental: { rw: 'Amenyo', fr: 'Dentaire' },
  'eye care': { rw: 'Kwita ku maso', fr: 'Soins des yeux' },
  'blood tests': { rw: "Ibizamini by'amaraso", fr: 'Analyses de sang' },
  'urine tests': { rw: "Ibizamini by'inkari", fr: "Analyses d'urine" },
  'nursing care': { rw: 'Kwita ku barwayi', fr: 'Soins infirmiers' },
  paediatrics: { rw: 'Kuvura abana', fr: 'Pédiatrie' },
  pediatrics: { rw: 'Kuvura abana', fr: 'Pédiatrie' },
  gynaecology: { rw: "Indwara z'abagore", fr: 'Gynécologie' },
  gynecology: { rw: "Indwara z'abagore", fr: 'Gynécologie' },
  'mental health': { rw: 'Ubuzima bwo mu mutwe', fr: 'Santé mentale' },
}

/**
 * Diseases and problems: alone ("Malaria"), in "<disease> treatment" and in "<disease> test".
 * `of` is the French "du / de la / des …" form used after "Traitement" and "Test".
 */
const DISEASES: Record<string, Entry & { of: string }> = {
  malaria: { rw: 'malariya', fr: 'paludisme', of: 'du paludisme' },
  typhoid: { rw: 'tifoyide', fr: 'typhoïde', of: 'de la typhoïde' },
  pneumonia: { rw: 'umusonga', fr: 'pneumonie', of: 'de la pneumonie' },
  diarrhoea: { rw: 'impiswi', fr: 'diarrhée', of: 'de la diarrhée' },
  diarrhea: { rw: 'impiswi', fr: 'diarrhée', of: 'de la diarrhée' },
  dysentery: { rw: 'macinya', fr: 'dysenterie', of: 'de la dysenterie' },
  tuberculosis: { rw: 'igituntu', fr: 'tuberculose', of: 'de la tuberculose' },
  tb: { rw: 'igituntu', fr: 'tuberculose', of: 'de la tuberculose' },
  hypertension: { rw: "umuvuduko w'amaraso ukabije", fr: 'hypertension', of: "de l'hypertension" },
  diabetes: { rw: 'diyabete', fr: 'diabète', of: 'du diabète' },
  asthma: { rw: 'asima', fr: 'asthme', of: "de l'asthme" },
  anaemia: { rw: 'kubura amaraso', fr: 'anémie', of: "de l'anémie" },
  anemia: { rw: 'kubura amaraso', fr: 'anémie', of: "de l'anémie" },
  gastritis: { rw: 'indwara y’igifu', fr: 'gastrite', of: 'de la gastrite' },
  worms: { rw: 'inzoka zo mu nda', fr: 'vers intestinaux', of: 'des vers intestinaux' },
  flu: { rw: 'ibicurane', fr: 'grippe', of: 'de la grippe' },
  influenza: { rw: 'ibicurane', fr: 'grippe', of: 'de la grippe' },
  cough: { rw: 'inkorora', fr: 'toux', of: 'de la toux' },
  fever: { rw: 'umuriro', fr: 'fièvre', of: 'de la fièvre' },
  wound: { rw: 'igikomere', fr: 'plaie', of: 'de la plaie' },
  burn: { rw: 'ubushye', fr: 'brûlure', of: 'de la brûlure' },
  burns: { rw: 'ubushye', fr: 'brûlures', of: 'des brûlures' },
  fracture: { rw: 'kuvunika', fr: 'fracture', of: 'de la fracture' },
  abscess: { rw: 'ikibyimba', fr: 'abcès', of: "de l'abcès" },
  conjunctivitis: { rw: "indwara y'amaso", fr: 'conjonctivite', of: 'de la conjonctivite' },
  hiv: { rw: 'virusi itera SIDA', fr: 'VIH', of: 'du VIH' },
  hepatitis: { rw: 'hepatite', fr: 'hépatite', of: "de l'hépatite" },
  syphilis: { rw: 'mburugu', fr: 'syphilis', of: 'de la syphilis' },
  cholera: { rw: 'korera', fr: 'choléra', of: 'du choléra' },
  measles: { rw: 'iseru', fr: 'rougeole', of: 'de la rougeole' },
  malnutrition: { rw: 'imirire mibi', fr: 'malnutrition', of: 'de la malnutrition' },
  dehydration: { rw: 'kubura amazi mu mubiri', fr: 'déshydratation', of: 'de la déshydratation' },
  allergy: { rw: 'aleriji', fr: 'allergie', of: "de l'allergie" },
  epilepsy: { rw: 'igicuri', fr: 'épilepsie', of: "de l'épilepsie" },
  'urinary tract infection': {
    rw: "indwara y'umuyoboro w'inkari",
    fr: 'infection urinaire',
    of: "de l'infection urinaire",
  },
  uti: {
    rw: "indwara y'umuyoboro w'inkari",
    fr: 'infection urinaire',
    of: "de l'infection urinaire",
  },
  'ear infection': { rw: "indwara y'amatwi", fr: 'otite', of: "de l'otite" },
  'skin infection': {
    rw: "indwara y'uruhu",
    fr: 'infection cutanée',
    of: "de l'infection cutanée",
  },
  'eye infection': {
    rw: "indwara y'amaso",
    fr: 'infection oculaire',
    of: "de l'infection oculaire",
  },
  covid: { rw: 'COVID-19', fr: 'COVID-19', of: 'de la COVID-19' },
  'covid-19': { rw: 'COVID-19', fr: 'COVID-19', of: 'de la COVID-19' },
}

/** Single words used to build "<word> test" / "<word> consultation" names. */
const WORDS: Record<string, Entry> = {
  blood: { rw: 'amaraso', fr: 'sang' },
  urine: { rw: 'inkari', fr: 'urine' },
  sugar: { rw: 'isukari', fr: 'sucre' },
  glucose: { rw: 'isukari', fr: 'glucose' },
  pregnancy: { rw: 'inda', fr: 'grossesse' },
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

/** Words that qualify a name wherever they stand: "Malaria treatment (uncomplicated)". */
const QUALIFIERS: Record<string, Entry> = {
  severe: { rw: 'ikabije', fr: 'grave' },
  complicated: { rw: 'ikabije', fr: 'compliqué' },
  uncomplicated: { rw: 'yoroheje', fr: 'simple' },
  simple: { rw: 'yoroheje', fr: 'simple' },
  mild: { rw: 'yoroheje', fr: 'léger' },
  chronic: { rw: 'idakira', fr: 'chronique' },
  acute: { rw: 'ikaze', fr: 'aigu' },
  adult: { rw: '(abakuru)', fr: '(adulte)' },
  adults: { rw: '(abakuru)', fr: '(adultes)' },
  child: { rw: '(abana)', fr: '(enfant)' },
  children: { rw: '(abana)', fr: '(enfants)' },
  paediatric: { rw: '(abana)', fr: '(pédiatrique)' },
  pediatric: { rw: '(abana)', fr: '(pédiatrique)' },
}

export interface Suggestion {
  rw: string
  fr: string
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[()[\],]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
const done = (e: Entry): Suggestion => ({ rw: cap(e.rw), fr: cap(e.fr) })

/** The name without its qualifiers, and the qualifiers in order. */
function splitQualifiers(n: string): { core: string; quals: Entry[] } {
  const words = n.split(' ')
  const quals: Entry[] = []
  const core: string[] = []
  for (const w of words) {
    const q = QUALIFIERS[w]
    // a qualifier only when something else names the treatment
    if (q && words.length > 1) quals.push(q)
    else core.push(w)
  }
  return { core: core.join(' '), quals }
}

/** The name itself, without qualifiers. */
function suggestCore(n: string): Entry | null {
  if (PHRASES[n]) return PHRASES[n]
  if (DISEASES[n]) return DISEASES[n]
  // "Blood sugar test" → "blood sugar": the glossary entry already names the test.
  const bare = n.replace(/ (test|exam|examination|check)$/, '')
  if (bare !== n && PHRASES[bare]) return PHRASES[bare]

  // "<disease> treatment", "treatment of <disease>", "<disease> management"
  const treat =
    n.match(/^(.+) (?:treatment|management|care)$/) ??
    n.match(/^(?:treatment|management) (?:of|for) (.+)$/)
  if (treat && DISEASES[treat[1]!]) {
    const d = DISEASES[treat[1]!]!
    return { rw: `Kuvura ${d.rw}`, fr: `Traitement ${d.of}` }
  }
  // "<disease or thing> test" / "test for <thing>"
  const test =
    n.match(/^(?:test for |test )?(.+?) (?:test|rdt|screening)$/) ?? n.match(/^test (?:for )?(.+)$/)
  if (test) {
    const d = DISEASES[test[1]!]
    if (d) return { rw: `Gupima ${d.rw}`, fr: `Test ${d.of}` }
    const w = WORDS[test[1]!]
    if (w) {
      const fr = /^[aeiouyhé]/.test(w.fr) ? `d'${w.fr}` : `de ${w.fr}`
      return { rw: `Gupima ${w.rw}`, fr: `Test ${fr}` }
    }
  }
  // "<qualifier> consultation"
  const consult = n.match(/^([a-z]+) consultation$/)
  if (consult && WORDS[consult[1]!]) {
    const w = WORDS[consult[1]!]!
    return { rw: `Kubonana na muganga ${w.rw}`, fr: `Consultation ${w.fr}` }
  }
  return null
}

/** Suggest Kinyarwanda and French names for an English treatment name, or null. */
export function suggestNames(english: string): Suggestion | null {
  const n = norm(english)
  if (n.length < 2) return null
  const whole = suggestCore(n)
  if (whole) return done(whole)
  const { core, quals } = splitQualifiers(n)
  const base = core !== n ? suggestCore(core) : null
  if (base)
    return done({
      rw: [base.rw, ...quals.map((q) => q.rw)].join(' '),
      fr: [base.fr, ...quals.map((q) => q.fr)].join(' '),
    })
  // A phrase that starts the name: "malaria rdt (rapid)" → "malaria rdt" + the rest as typed.
  for (const [k, v] of Object.entries(PHRASES)) {
    if (k.length >= 5 && (n.startsWith(`${k} `) || n.endsWith(` ${k}`))) {
      const rest = n.startsWith(`${k} `) ? english.slice(k.length).trim() : ''
      return done(rest ? { rw: `${v.rw} ${rest}`, fr: `${v.fr} ${rest}` } : v)
    }
  }
  return null
}
