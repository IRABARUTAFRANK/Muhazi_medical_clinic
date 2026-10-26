import { beforeAll, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { apiError, translateDbSentence } from './errors'

describe('database sentences', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en')
  })

  it('translates a sentence the database wrote, with its inserted words', async () => {
    const key = 'dbErrors.' + keyOf('that patient is at % (not waiting for a doctor)')
    expect(i18n.exists(key)).toBe(true)
    const e = apiError({
      code: '22023',
      message: 'that patient is at Laboratory (not waiting for a doctor)',
    })
    expect(e.kind).toBeNull()
    expect(e.message).toBe(i18n.t(key, { p1: 'Laboratory' }))
    // in Kinyarwanda the sentence and the desk name both change
    await i18n.changeLanguage('rw')
    const rw = apiError({
      code: '22023',
      message: 'that patient is at Laboratory (not waiting for a doctor)',
    })
    expect(rw.message).toBe(i18n.t(key, { p1: i18n.t('register.stations.laboratory') }))
    expect(rw.message).not.toBe(e.message)
    await i18n.changeLanguage('en')
  })

  it('keeps an unknown sentence as the server wrote it', () => {
    expect(translateDbSentence('a sentence no migration raises')).toBeNull()
    expect(apiError({ code: '22023', message: 'a sentence no migration raises' }).message).toBe(
      'a sentence no migration raises',
    )
  })

  it('still prefers the hint table and the general reasons', () => {
    expect(apiError({ code: '42501', hint: 'not_permitted', message: 'not allowed' }).kind).toBe(
      'notPermitted',
    )
    const bare = apiError({ code: '42501', message: 'some reason only the server knows' })
    expect(bare.message).toBe(i18n.t('apiErrors.notAllowed'))
  })

  it('keeps the delivery line number around the translated sentence', () => {
    const e = apiError({ code: '22023', message: 'line 2: a reason is required' })
    expect(e.line).toBe(2)
    expect(e.message).toContain(i18n.t('dbErrors.' + keyOf('a reason is required')))
  })
})

/** The key scripts/db-messages.mjs gives a sentence (8 hex of its sha1). */
function keyOf(sentence: string): string {
  // the generated table is the source of truth; read the key back from it
  const row = DB_ROWS.find((r) => r.re.test(sentence.replace(/%/g, 'x')))
  if (!row) throw new Error('not in the generated table: ' + sentence)
  return row.key.slice('dbErrors.'.length)
}
import { DB_MESSAGES } from './db-messages.generated'
const DB_ROWS = DB_MESSAGES.map(([re, key]) => ({ re, key }))
