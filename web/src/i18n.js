// Translations for the browser version.
//
// The strings live in ../../locales/<language>.json and are shared with the
// desktop app. A string is either plain text or a {"one": …, "other": …}
// object for singular/plural; placeholders look like {name}. Parameters are
// formatted for the current language:
//   * integers get thousands separators (1,234 / 1.234),
//   * parameters named `size` or ending in `_size` are byte counts (13.8 MB / 13,8 MB),
//   * parameters named `seconds` are durations (4.2 s / 4,2 s).

import en from '../../locales/en.json' with { type: 'json' }
import es from '../../locales/es.json' with { type: 'json' }

export const LANGUAGES = { en: 'English', es: 'Español' }
export const DEFAULT_LANGUAGE = 'en'
const STRINGS = { en, es }
const PLACEHOLDER = /\{(\w+)\}/g

let language = DEFAULT_LANGUAGE

export function strings(code) {
  return STRINGS[code]
}

/** Spanish if the browser prefers Spanish, English otherwise. */
export function detectLanguage(preferred = globalThis.navigator?.languages || [globalThis.navigator?.language]) {
  for (const l of preferred || []) {
    const code = String(l || '').toLowerCase().slice(0, 2)
    if (code in LANGUAGES) return code
  }
  return DEFAULT_LANGUAGE
}

export function setLanguage(code) {
  language = code in LANGUAGES ? code : DEFAULT_LANGUAGE
}

export function getLanguage() {
  return language
}

// --------------------------------------------------------------------------
//  Number formatting
// --------------------------------------------------------------------------
function separators() {
  return language === 'es' ? ['.', ','] : [',', '.']          // [thousands, decimal]
}

export function fmtInt(n) {
  const [thousands] = separators()
  const s = typeof n === 'bigint' ? n.toString() : Math.round(n).toString()
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, thousands)
}

export function fmtDecimal(x, digits = 1) {
  const [, decimal] = separators()
  return x.toFixed(digits).replace('.', decimal)
}

export function fmtBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return i === 0 ? `${Math.round(n)} B` : `${fmtDecimal(n)} ${units[i]}`
}

export function fmtSeconds(s) {
  if (s >= 90) return `${Math.floor(s / 60)} min ${String(Math.floor(s % 60)).padStart(2, '0')} s`
  return `${fmtDecimal(s)} s`
}

function formatParam(name, value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return String(value)
  if (name === 'size' || name.endsWith('_size')) return fmtBytes(Number(value))
  if (name === 'seconds') return fmtSeconds(Number(value))
  if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))) return fmtInt(value)
  return String(value)
}

/** Translated text for `key` in the current language. */
export function t(key, params = {}) {
  let text = STRINGS[language][key] ?? STRINGS[DEFAULT_LANGUAGE][key] ?? key
  if (typeof text === 'object') {
    const n = params.n ?? params.count ?? 0
    text = Number(n) === 1 ? text.one : text.other
  }
  return text.replace(PLACEHOLDER, (m, name) => (name in params ? formatParam(name, params[name]) : m))
}

/** A message for the user: translation key + parameters, rendered on demand (so it follows the language). */
export class Msg {
  constructor(key, params = {}) {
    this.key = key
    this.params = params
  }

  toString() {
    return t(this.key, this.params)
  }
}

/** Several messages shown together, joined with `separator`. */
export class MsgList {
  constructor(items, separator = ' ') {
    this.items = items
    this.separator = separator
  }

  toString() {
    return this.items.map(String).join(this.separator)
  }
}
