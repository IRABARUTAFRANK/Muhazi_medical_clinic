import { describe, expect, it } from 'vitest'
import { rwForVoice, rwSentence } from './speech'

// 0163: Kinyarwanda through another voice — respelled so the vowels and consonants come out right
describe('kinyarwanda for the voice', () => {
  it('english voice: syllables with english vowels, c as ch, names too, tickets never', () => {
    expect(rwForVoice('Umurwayi witwa', 'en')).toBe('oo-moo-rwah-yee wee-twah')
    expect(rwForVoice('deparitoma yo gusuzuma', 'en')).toBe(
      'deh-pah-ree-toh-mah yoh goo-soo-zoo-mah',
    )
    expect(rwForVoice('icyumba', 'en')).toBe('ee-chyoo-mbah')
    const s = rwSentence(
      'Umurwayi witwa §2§, urakenewe muri §3§, ukenewe na muganga §4§. Itike §1§.',
      [
        { token: '§1§', value: 'A 0 1 4' },
        { token: '§2§', value: 'Habimana Eric' },
        { token: '§3§', value: 'deparitoma y’ibipimo by’ibanze', kinyarwanda: true },
        { token: '§4§', value: 'Dr. Mukamana' },
      ],
      'en',
    )
    expect(s).toContain('hah-bee-mah-nah')
    expect(s).toContain('deh-pah-ree-toh-mah yee-bee-pee-moh byee-bah-nzeh')
    expect(s).toContain('Dr. moo-kah-mah-nah')
    expect(s).toContain('A 0 1 4')
  })
  it('french voice: ou for u, tch for c, gn for ny, every e said; names left alone', () => {
    expect(rwForVoice('Umurwayi urakenewe muri icyumba, nyamuneka', 'fr')).toBe(
      'oumourwayi ourakénéwé mouri itchyoumba, gnamounéka',
    )
    const s = rwSentence('§2§ urakenewe', [{ token: '§2§', value: 'Béatrice' }], 'fr')
    expect(s).toBe('Béatrice ourakénéwé')
  })
  it('spanish voice: ch, y for j, j for h, ñ', () => {
    expect(rwForVoice('Habimana jya nyamuneka icyumba', 'es')).toBe('jabimana ya ñamuneka ichyumba')
  })
  it('swahili or kinyarwanda voice: nothing changes', () => {
    expect(rwForVoice('Umurwayi witwa', 'sw')).toBe('Umurwayi witwa')
    expect(rwForVoice('Umurwayi witwa', 'rw')).toBe('Umurwayi witwa')
  })
})
