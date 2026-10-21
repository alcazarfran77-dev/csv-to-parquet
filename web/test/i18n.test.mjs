// Translation tests, run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { t, Msg, setLanguage, getLanguage, detectLanguage, fmtInt, fmtBytes, fmtSeconds, strings } from '../src/i18n.js'

test('both languages have the same keys', () => {
  assert.deepEqual(Object.keys(strings('en')).sort(), Object.keys(strings('es')).sort())
})

test('every data-i18n key of the page exists', () => {
  const html = fs.readFileSync(new URL('../src/index.html', import.meta.url), 'utf8')
  for (const [, key] of html.matchAll(/data-i18n(?:-aria-label)?="([a-z0-9_]+)"/g)) assert.ok(key in strings('en'), key)
})

test('formatting and plurals per language', () => {
  setLanguage('en')
  assert.equal(fmtInt(1234567), '1,234,567')
  assert.equal(fmtInt(12n ** 20n), '3,833,759,992,447,475,122,176')
  assert.equal(fmtBytes(1536), '1.5 KB')
  assert.equal(fmtSeconds(125), '2 min 05 s')
  assert.equal(t('rows_count', { n: 1 }), '1 row')
  assert.equal(t('zone_count', { n: 3, size: 2048 }), '3 files · 2.0 KB')
  setLanguage('es')
  assert.equal(fmtInt(1234567), '1.234.567')
  assert.equal(fmtBytes(1536), '1,5 KB')
  assert.equal(t('rows_count', { n: 2000 }), '2.000 filas')
  setLanguage('en')
})

test('messages follow the language', () => {
  const m = new Msg('note_skipped_rows', { n: 3 })
  setLanguage('es')
  assert.equal(String(m), 'Se omitieron 3 filas mal formadas.')
  setLanguage('en')
  assert.equal(String(m), '3 malformed rows skipped.')
})

test('language detection and fallback', () => {
  assert.equal(detectLanguage(['es-MX', 'en']), 'es')
  assert.equal(detectLanguage(['fr-FR', 'es']), 'es')
  assert.equal(detectLanguage(['de-DE']), 'en')
  setLanguage('xx')
  assert.equal(getLanguage(), 'en')
})
