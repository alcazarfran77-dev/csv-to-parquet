// CSV / JSON -> Apache Parquet conversion engine that runs inside the browser.
// No server and no network: it reads the files with the browser File API and
// writes the Parquet one row group at a time to a "target" (a folder on this
// computer, a download or, in the tests, the disk).
//
// Each file is processed in two passes:
//   1. Analysis: reads the whole file and decides the type of every column
//      (so an "N/A" in row 1,400,000 can't break anything halfway through).
//   2. Writing: reads it again, converts every value and writes the Parquet.
//
// User-facing messages are `Msg` objects (translation key + parameters), so the
// interface shows them in the selected language.

import { ParquetWriter, ByteWriter } from 'hyparquet-writer'
import { gzipSync } from 'fflate'
import { Msg, MsgList } from './i18n.js'

export { Msg, MsgList }

const EXT_CSV = ['.csv.gz', '.tsv.gz', '.csv', '.tsv']
const EXT_JSON = ['.json.gz', '.jsonl.gz', '.ndjson.gz', '.json', '.jsonl', '.ndjson']
export const EXTENSIONS = [...EXT_CSV, ...EXT_JSON]
export const SOURCE_COLUMN = 'source_file'

const SAMPLE_SIZE = 1 << 20          // 1 MB to detect encoding, separator and decimal
const BLOCK_SIZE = 4 << 20           // 4 MB per read
const CELLS_PER_GROUP = 500_000      // target size of each row group (rows x columns)
const MIN_GROUP_ROWS = 5_000
const MAX_GROUP_ROWS = 100_000
export const ANALYSIS_WEIGHT = 0.35  // share of a file's progress that belongs to the first pass

// Choices: code -> translation key of its label
export const SEPARATORS = { auto: 'sep_auto', ',': 'sep_comma', ';': 'sep_semicolon', '\t': 'sep_tab', '|': 'sep_pipe' }
export const ENCODINGS = { auto: 'enc_auto', 'utf-8': 'enc_utf8', 'windows-1252': 'enc_cp1252', 'utf-16le': 'enc_utf16' }
export const DECIMALS = { auto: 'dec_auto', '.': 'dec_point', ',': 'dec_comma' }
export const COMPRESSIONS = { SNAPPY: 'comp_snappy', GZIP: 'comp_gzip_web', UNCOMPRESSED: 'comp_none' }
export const SEPARATOR_KEYS = { ',': 'sep_name_comma', ';': 'sep_name_semicolon', '\t': 'sep_name_tab', '|': 'sep_name_pipe' }
export const ENCODING_NAMES = {
  'utf-8': 'UTF-8', 'windows-1252': 'Windows-1252', 'utf-16le': 'UTF-16', 'utf-16be': 'UTF-16',
}
export const TYPE_KEYS = {
  int: 'type_int', float: 'type_float', bool: 'type_bool', date: 'type_date',
  timestamp: 'type_timestamp', string: 'type_string', null: 'type_null',
}
export const PARQUET_TYPES = {
  int: 'INT64', float: 'DOUBLE', bool: 'BOOLEAN', date: 'DATE', timestamp: 'TIMESTAMP(ms)',
  string: 'STRING', null: 'STRING',
}

export const DEFAULT_OPTIONS = {
  separator: 'auto', encoding: 'auto', decimal: 'auto', header: true, dmyDates: true,
  allText: false, skipBadRows: false, compression: 'SNAPPY', combine: false,
  combinedName: 'combined.parquet', sourceColumn: true, overwrite: false,
  split: null,   // { mode: 'rows' | 'mb', value: number } to write each Parquet as several parts
}

export class Cancelled extends Error {
  constructor() { super('Cancelled by the user.'); this.name = 'Cancelled' }
}

/** An error explained to the user (see `msg`). */
export class ConversionError extends Error {
  constructor(key, params = {}) {
    super(key)
    this.name = 'ConversionError'
    this.msg = new Msg(key, params)
  }
}

class EncodingError extends Error {}

export function separatorName(sep) {
  return SEPARATOR_KEYS[sep] ? new Msg(SEPARATOR_KEYS[sep]) : new Msg('raw', { text: JSON.stringify(sep) })
}

export function encodingName(code) {
  return ENCODING_NAMES[code] || code
}

// --------------------------------------------------------------------------
//  Names and helpers
// --------------------------------------------------------------------------
export function isSupported(name) {
  const n = name.toLowerCase()
  return EXTENSIONS.some(e => n.endsWith(e))
}

export function isJSON(name) {
  const n = name.toLowerCase()
  return EXT_JSON.some(e => n.endsWith(e))
}

export function baseName(name) {
  const n = name.toLowerCase()
  const ext = EXTENSIONS.find(e => n.endsWith(e))
  return ext ? name.slice(0, -ext.length) : name.replace(/\.[^.]*$/, '')
}

export function cleanNames(names) {
  const used = new Set()
  return names.map((n, i) => {
    let name = (n ?? '').replace(/\uFEFF/g, '').trim() || `column_${i + 1}`
    const base = name
    let k = 2
    while (used.has(name.toLowerCase())) name = `${base}_${k++}`
    used.add(name.toLowerCase())
    return name
  })
}

function checkCancel(cancel) {
  if (cancel?.cancelled) throw new Cancelled()
}

// --------------------------------------------------------------------------
//  Reading bytes (including .gz) and decoding
// --------------------------------------------------------------------------
async function* readBytes(file, progress, cancel) {
  const gz = file.name.toLowerCase().endsWith('.gz')
  const total = Math.max(file.size, 1)
  if (!gz) {
    for (let pos = 0; pos < file.size; pos += BLOCK_SIZE) {
      checkCancel(cancel)
      const chunk = new Uint8Array(await file.slice(pos, pos + BLOCK_SIZE).arrayBuffer())
      progress?.(Math.min(pos + chunk.length, total) / total)
      yield chunk
    }
    return
  }
  if (typeof DecompressionStream === 'undefined') throw new ConversionError('err_gz_unsupported')
  let read = 0
  const counter = new TransformStream({
    transform(ch, ctl) { read += ch.byteLength; ctl.enqueue(ch) },
  })
  const reader = file.stream().pipeThrough(counter).pipeThrough(new DecompressionStream('gzip')).getReader()
  try {
    while (true) {
      checkCancel(cancel)
      let r
      try {
        r = await reader.read()
      } catch {
        throw new ConversionError('err_gz_damaged')
      }
      if (r.done) break
      progress?.(Math.min(read / total, 1))
      yield r.value
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

// Returns the start of the file (already decompressed) and whether that start is the whole file.
async function readSample(file, n = SAMPLE_SIZE) {
  const gz = file.name.toLowerCase().endsWith('.gz')
  const chunks = []
  let size = 0
  let cut = false
  for await (const c of readBytes(file)) {
    chunks.push(c)
    size += c.length
    if (size >= n) { cut = true; break }
  }
  const complete = !cut || (!gz && size >= file.size)
  const bytes = new Uint8Array(size)
  let o = 0
  for (const c of chunks) { bytes.set(c, o); o += c.length }
  return { bytes, complete }
}

function detectEncoding(b) {
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return 'utf-8'
  if (b[0] === 0xFF && b[1] === 0xFE) return 'utf-16le'
  if (b[0] === 0xFE && b[1] === 0xFF) return 'utf-16be'
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b, { stream: true })
    return 'utf-8'
  } catch {
    return 'windows-1252'
  }
}

function createDecoder(encoding) {
  const d = new TextDecoder(encoding, { fatal: encoding === 'utf-8' })
  return {
    decode(bytes, stream = true) {
      try {
        return d.decode(bytes, { stream })
      } catch {
        throw new EncodingError()
      }
    },
  }
}

// --------------------------------------------------------------------------
//  Streaming CSV parser (RFC 4180: quotes, doubled quotes, line breaks inside
//  a value, \n, \r\n and \r)
// --------------------------------------------------------------------------
export class CsvParser {
  constructor(sep, onRow) {
    this.sep = sep.charCodeAt(0)
    this.onRow = onRow
    this.field = ''
    this.row = []
    this.state = 0         // 0 field start · 1 unquoted field · 2 inside quotes · 3 quote read inside quotes
    this.skipLF = false
    this.records = 0       // records emitted (including the header)
    this.quoteStartRecord = 0
  }

  _emit(row) {
    if (row.length === 1 && row[0] === '') return  // empty line
    this.records++
    this.onRow(row)
  }

  push(s) {
    const n = s.length
    const SEP = this.sep
    let i = 0
    let st = this.state
    let field = this.field
    let row = this.row
    if (this.skipLF && n > 0) {
      if (s.charCodeAt(0) === 10) i = 1
      this.skipLF = false
    }
    while (i < n) {
      if (st === 0) {
        if (s.charCodeAt(i) === 34) { st = 2; i++; this.quoteStartRecord = this.records + 1; continue }
        st = 1
      }
      if (st === 1) {
        let j = i
        while (j < n) {
          const c = s.charCodeAt(j)
          if (c === SEP || c === 10 || c === 13) break
          j++
        }
        field = field === '' ? s.slice(i, j) : field + s.slice(i, j)
        if (j === n) { i = n; break }
        const c = s.charCodeAt(j)
        row.push(field)
        field = ''
        st = 0
        if (c === SEP) { i = j + 1; continue }
        this.row = []
        this._emit(row)
        row = this.row
        if (c === 13) {
          if (j + 1 < n) i = s.charCodeAt(j + 1) === 10 ? j + 2 : j + 1
          else { this.skipLF = true; i = n }
        } else {
          i = j + 1
        }
        continue
      }
      if (st === 2) {
        const q = s.indexOf('"', i)
        if (q === -1) { field += s.slice(i); i = n; break }
        field += s.slice(i, q)
        i = q + 1
        st = 3
        continue
      }
      // st === 3: the quote just read either closes the value or is an escaped quote ("")
      const c = s.charCodeAt(i)
      if (c === 34) { field += '"'; i++; st = 2; continue }
      if (c === SEP) { row.push(field); field = ''; st = 0; i++; continue }
      if (c === 10 || c === 13) {
        row.push(field)
        field = ''
        st = 0
        this.row = []
        this._emit(row)
        row = this.row
        if (c === 13) {
          if (i + 1 < n) i = s.charCodeAt(i + 1) === 10 ? i + 2 : i + 1
          else { this.skipLF = true; i = n }
        } else {
          i++
        }
        continue
      }
      st = 1 // text after the closing quote: kept as is (lenient reading)
    }
    this.state = st
    this.field = field
    this.row = row
  }

  finish() {
    if (this.state === 2) throw new ConversionError('err_unclosed_quote', { row: this.quoteStartRecord })
    if (this.state !== 0 || this.field !== '' || this.row.length) {
      const row = this.row
      row.push(this.field)
      this.row = []
      this.field = ''
      this.state = 0
      this._emit(row)
    }
  }
}

function rowsFromText(text, sep, complete, max = 1000) {
  const rows = []
  const p = new CsvParser(sep, r => { if (rows.length < max) rows.push(r) })
  p.push(text)
  if (complete) p.finish()
  return rows
}

// --------------------------------------------------------------------------
//  Separator and decimal detection
// --------------------------------------------------------------------------
export function detectSeparator(text) {
  let best = ','
  let bestScore = -1
  for (const sep of [',', ';', '\t', '|']) {
    let rows
    try {
      rows = rowsFromText(text, sep, false, 60)
    } catch {
      continue
    }
    if (rows.length > 2) rows = rows.slice(0, -1)
    if (!rows.length) continue
    const counts = new Map()
    for (const r of rows) counts.set(r.length, (counts.get(r.length) || 0) + 1)
    let mode = 0
    let times = 0
    for (const [k, v] of counts) if (v > times || (v === times && k > mode)) { mode = k; times = v }
    if (mode < 2) continue
    const score = (times / rows.length) * 1000 + mode
    if (score > bestScore) { best = sep; bestScore = score }
  }
  return best
}

const RE_COMMA = /^-?\d+,\d+$/
const RE_POINT = /^-?\d+\.\d+$/

function detectDecimal(rows, sep) {
  if (sep === ',') return '.'
  let comma = 0
  let point = 0
  for (const r of rows) {
    for (const v0 of r) {
      const v = v0.trim()
      if (RE_COMMA.test(v)) comma++
      else if (RE_POINT.test(v)) point++
    }
  }
  return comma > point ? ',' : '.'
}

// --------------------------------------------------------------------------
//  Data types
// --------------------------------------------------------------------------
// Same texts that pyarrow treats as null in numeric or date columns.
const NULLS = new Set(['', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND',
  '1.#QNAN', 'N/A', 'NA', 'NULL', 'NaN', 'n/a', 'nan', 'null'])
const TRUE_VALUES = new Set(['true', 'verdadero'])
const BOOLEANS = new Set(['true', 'false', 'verdadero', 'falso'])

const RE_INT = /^[+-]?\d{1,18}$/
const RE_LEADING_ZERO = /^[+-]?0\d/          // "007": kept as text (part codes)
const RE_FLOAT_POINT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
const RE_FLOAT_COMMA = /^[+-]?(\d+,?\d*|,\d+)([eE][+-]?\d+)?$/
const RE_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/
const RE_DMY = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3}))?)?)?$/

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function validDate(y, m, d, h, mi, s) {
  if (m < 1 || m > 12 || d < 1 || d > MONTH_DAYS[m - 1]) return false
  if (m === 2 && d === 29 && !((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) return false
  return h < 24 && mi < 60 && s < 60
}

// Days since 1970-01-01 for a Gregorian calendar date (H. Hinnant's algorithm).
function daysFromEpoch(y, m, d) {
  y -= m <= 2 ? 1 : 0
  const era = Math.floor(y / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468
}

function digits(v, i, n) {
  let x = 0
  for (let k = i; k < i + n; k++) {
    const c = v.charCodeAt(k) - 48
    if (c < 0 || c > 9) return -1
    x = x * 10 + c
  }
  return x
}

const DATE_RESULT = { ms: 0, time: false, zone: false }

// Most common fixed-width formats, without regular expressions (fast).
function parseDateFast(v, dmy) {
  const L = v.length
  if (L !== 10 && L !== 16 && L !== 19) return undefined
  let y, m, d
  const c4 = v.charCodeAt(4)
  if (c4 === 45 && v.charCodeAt(7) === 45) {               // YYYY-MM-DD
    y = digits(v, 0, 4); m = digits(v, 5, 2); d = digits(v, 8, 2)
  } else if (dmy && v.charCodeAt(2) === 47 && c4 === 47) {  // DD/MM/YYYY
    d = digits(v, 0, 2); m = digits(v, 3, 2); y = digits(v, 6, 4)
  } else {
    return undefined
  }
  if (y < 0 || m < 0 || d < 0) return undefined
  let h = 0, mi = 0, s = 0
  if (L > 10) {
    const timeSep = v.charCodeAt(10)
    if ((timeSep !== 84 && timeSep !== 32) || v.charCodeAt(13) !== 58) return undefined
    h = digits(v, 11, 2); mi = digits(v, 14, 2)
    if (L === 19) { if (v.charCodeAt(16) !== 58) return undefined; s = digits(v, 17, 2) }
    if (h < 0 || mi < 0 || s < 0) return undefined
  }
  if (y < 100 || !validDate(y, m, d, h, mi, s)) return null
  DATE_RESULT.ms = daysFromEpoch(y, m, d) * 86400000 + ((h * 60 + mi) * 60 + s) * 1000
  DATE_RESULT.time = L > 10
  DATE_RESULT.zone = false
  return DATE_RESULT
}

// Returns { ms, time, zone } or null. ms = milliseconds since 1970 (UTC when there is a zone).
export function parseDate(v, dmy) {
  const c = v.charCodeAt(0)
  if (c < 48 || c > 57) return null
  const fast = parseDateFast(v, dmy)
  if (fast !== undefined) return fast
  let m = RE_ISO.exec(v)
  let y, mo, d, h = 0, mi = 0, s = 0, frac = '', zone = null, time = false
  if (m) {
    y = +m[1]; mo = +m[2]; d = +m[3]
    if (m[4] !== undefined) { time = true; h = +m[4]; mi = +m[5]; s = m[6] ? +m[6] : 0; frac = m[7] || ''; zone = m[8] || null }
  } else if (dmy && (m = RE_DMY.exec(v))) {
    d = +m[1]; mo = +m[2]; y = +m[3]
    if (m[4] !== undefined) { time = true; h = +m[4]; mi = +m[5]; s = m[6] ? +m[6] : 0; frac = m[7] || '' }
  } else {
    return null
  }
  if (!validDate(y, mo, d, h, mi, s)) return null
  let ms = Date.UTC(y, mo - 1, d, h, mi, s, frac ? +(frac + '00').slice(0, 3) : 0)
  if (y < 100) ms = new Date(ms).setUTCFullYear(y)
  if (zone && zone !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1
    const zz = zone.replace(':', '')
    ms -= sign * ((+zz.slice(1, 3)) * 60 + (+zz.slice(3, 5))) * 60000
  }
  return { ms, time, zone: !!zone }
}

const P_INT = 1
const P_FLOAT = 2
const P_BOOL = 4
const P_DATE = 8

class TypeGuesser {
  constructor(decimal, dmy) {
    this.possible = P_INT | P_FLOAT | P_BOOL | P_DATE
    this.reFloat = decimal === ',' ? RE_FLOAT_COMMA : RE_FLOAT_POINT
    this.dmy = dmy
    this.valid = 0        // non-null values
    this.literals = 0     // non-empty values (including "NA", "NULL"…)
    this.time = false
    this.zone = false
    this.mixed = null     // { value, record } that turned the column into text
  }

  probe(v0, record) {
    if (this.possible === 0 && this.valid > 0) return
    if (v0 === '') return
    this.literals++
    const v = v0.trim()
    if (NULLS.has(v)) return
    this.valid++
    const before = this.possible
    let p = before
    if (p & P_INT && (!RE_INT.test(v) || RE_LEADING_ZERO.test(v))) p &= ~P_INT
    if (p & P_FLOAT && (!this.reFloat.test(v) || RE_LEADING_ZERO.test(v) || (/^[+-]?\d{16,}$/.test(v)))) p &= ~P_FLOAT
    if (p & P_BOOL && !BOOLEANS.has(v.toLowerCase())) p &= ~P_BOOL
    if (p & P_DATE) {
      const f = parseDate(v, this.dmy)
      if (!f) p &= ~P_DATE
      else { if (f.time) this.time = true; if (f.zone) this.zone = true }
    }
    if (p === 0 && before !== 0 && this.valid > 1 && !this.mixed) this.mixed = { value: v0, record }
    this.possible = p
  }

  kind() {
    if (this.valid === 0) return this.literals > 0 ? 'string' : 'null'
    const p = this.possible
    if (p & P_INT) return 'int'
    if (p & P_FLOAT) return 'float'
    if (p & P_BOOL) return 'bool'
    if (p & P_DATE) return this.time ? 'timestamp' : 'date'
    return 'string'
  }
}

const MS_PER_DAY = 86400000

function createConverter(kind, decimal, dmy) {
  const isNull = v => v === '' || NULLS.has(v)
  switch (kind) {
    case 'int':
      return v0 => {
        const v = v0.trim()
        if (isNull(v)) return null
        return BigInt(v.charCodeAt(0) === 43 ? v.slice(1) : v)
      }
    case 'float':
      return v0 => {
        const v = v0.trim()
        if (isNull(v)) return null
        const x = Number(decimal === ',' ? v.replace(',', '.') : v)
        if (Number.isNaN(x)) throw new Error()
        return x
      }
    case 'bool':
      return v0 => {
        const v = v0.trim()
        if (isNull(v)) return null
        const l = v.toLowerCase()
        if (!BOOLEANS.has(l)) throw new Error()
        return TRUE_VALUES.has(l)
      }
    case 'date':
      return v0 => {
        const v = v0.trim()
        if (isNull(v)) return null
        const f = parseDate(v, dmy)
        if (!f) throw new Error()
        return Math.floor(f.ms / MS_PER_DAY)
      }
    case 'timestamp':
      return v0 => {
        const v = v0.trim()
        if (isNull(v)) return null
        const f = parseDate(v, dmy)
        if (!f) throw new Error()
        return BigInt(f.ms)
      }
    default:
      return v => (v === '' ? null : v)
  }
}

// Merges the types of one column that comes from several files.
export function commonType(kinds) {
  const k = [...new Set(kinds.filter(x => x !== 'null'))]
  if (!k.length) return 'null'
  if (k.length === 1) return k[0]
  if (k.every(x => x === 'int' || x === 'float')) return 'float'
  if (k.every(x => x === 'date' || x === 'timestamp')) return 'timestamp'
  return 'string'
}

function parquetElement({ name, kind, utc }) {
  const opt = { name, repetition_type: 'OPTIONAL' }
  switch (kind) {
    case 'int': return { ...opt, type: 'INT64' }
    case 'float': return { ...opt, type: 'DOUBLE' }
    case 'bool': return { ...opt, type: 'BOOLEAN' }
    case 'date': return { ...opt, type: 'INT32', converted_type: 'DATE', logical_type: { type: 'DATE' } }
    case 'timestamp':
      return utc
        ? { ...opt, type: 'INT64', converted_type: 'TIMESTAMP_MILLIS', logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: true, unit: 'MILLIS' } }
        : { ...opt, type: 'INT64', logical_type: { type: 'TIMESTAMP', isAdjustedToUTC: false, unit: 'MILLIS' } }
    default:
      return { ...opt, type: 'BYTE_ARRAY', converted_type: 'UTF8', logical_type: { type: 'STRING' } }
  }
}

// --------------------------------------------------------------------------
//  File format (encoding, separator, header, decimal)
// --------------------------------------------------------------------------
export async function detectCsvFormat(file, op) {
  const { bytes, complete } = await readSample(file)
  if (!bytes.length) throw new ConversionError('err_empty_file')
  let encoding = op.encoding === 'auto' ? detectEncoding(bytes) : op.encoding
  if (encoding === 'utf-16le' && bytes[0] === 0xFE && bytes[1] === 0xFF) encoding = 'utf-16be'
  const text = new TextDecoder(encoding).decode(bytes, { stream: !complete })
  if (!text.trim()) throw new ConversionError('err_empty_file')
  const separator = op.separator === 'auto' ? detectSeparator(text) : op.separator
  const rows = rowsFromText(text, separator, complete, 1001)
  if (!rows.length) throw new ConversionError('err_empty_file')
  const names = op.header ? cleanNames(rows[0]) : rows[0].map((_, i) => `column_${i + 1}`)
  const data = op.header ? rows.slice(1) : rows
  const decimal = op.decimal === 'auto' ? detectDecimal(data, separator) : op.decimal
  return { kind: 'csv', separator, encoding, decimal, names, sample: data }
}

function wrongColumns(record, row, expected, sep) {
  const text = row.join(sep).replace(/\s+/g, ' ')
  return new ConversionError('err_wrong_columns', {
    row: record, got: row.length, expected, text: text.length > 90 ? text.slice(0, 89) + '…' : text,
  })
}

// First rows, already converted, to show on screen. The types come from the
// sample (up to 1,000 rows); the conversion confirms them with the whole file.
async function previewCsv(file, op, maxRows = 200) {
  const fmt = await detectCsvFormat(file, op)
  const ncol = fmt.names.length
  const guessers = fmt.names.map(() => new TypeGuesser(fmt.decimal, op.dmyDates))
  const rows = []
  let record = op.header ? 1 : 0
  for (const r of fmt.sample) {
    record++
    if (r.length !== ncol) {
      if (op.skipBadRows) continue
      throw wrongColumns(record, r, ncol, fmt.separator)
    }
    rows.push(r)
    if (!op.allText) for (let j = 0; j < ncol; j++) guessers[j].probe(r[j], record)
  }
  const kinds = op.allText ? fmt.names.map(() => 'string') : guessers.map(g => g.kind())
  const conv = kinds.map(k => createConverter(k, fmt.decimal, op.dmyDates))
  const values = rows.slice(0, maxRows).map(r => r.map((v, j) => {
    try { return conv[j](v) } catch { return v }
  }))
  return { ...fmt, kinds, values, sampleRows: rows.length }
}

// --------------------------------------------------------------------------
//  First pass: full analysis
// --------------------------------------------------------------------------
export async function analyze(file, op, progress, cancel) {
  let fmt = isJSON(file.name) ? await detectJsonFormat(file, op) : await detectCsvFormat(file, op)
  let note = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await (fmt.kind === 'json' ? analyzeJsonPass : analyzeCsvPass)(file, fmt, op, progress, cancel)
      return { ...r, note }
    } catch (e) {
      if (e instanceof EncodingError) {
        if (op.encoding === 'auto' && fmt.encoding === 'utf-8' && attempt === 0) {
          fmt = { ...fmt, encoding: 'windows-1252' }
          note = new Msg('note_encoding_adjusted')
          continue
        }
        throw new ConversionError('err_not_utf8')
      }
      throw e
    }
  }
  throw new ConversionError('err_could_not_read')
}

async function analyzeCsvPass(file, fmt, op, progress, cancel) {
  const ncol = fmt.names.length
  const guessers = fmt.names.map(() => new TypeGuesser(fmt.decimal, op.dmyDates))
  let rows = 0
  let bad = 0
  let headerPending = op.header
  const allText = op.allText
  const parser = new CsvParser(fmt.separator, row => {
    if (headerPending) { headerPending = false; return }
    if (row.length !== ncol) {
      if (op.skipBadRows) { bad++; return }
      throw wrongColumns(parser.records, row, ncol, fmt.separator)
    }
    rows++
    if (!allText) for (let j = 0; j < ncol; j++) guessers[j].probe(row[j], parser.records)
  })
  const dec = createDecoder(fmt.encoding)
  for await (const bytes of readBytes(file, progress, cancel)) {
    parser.push(dec.decode(bytes))
  }
  parser.push(dec.decode(new Uint8Array(0), false))
  parser.finish()
  const kinds = allText ? fmt.names.map(() => 'string') : guessers.map(g => g.kind())
  const mixed = []
  guessers.forEach((g, j) => {
    if (kinds[j] === 'string' && g.mixed) mixed.push({ column: fmt.names[j], ...g.mixed })
  })
  return { fmt, kinds, zones: guessers.map(g => g.zone), rows, bad, mixed }
}


// --------------------------------------------------------------------------
//  JSON: a list of objects, JSON Lines (one object per line) or an object that
//  wraps the list ({"data": [...]}). Nested objects are flattened
//  ("customer.name") and inner lists are stored as JSON text.
// --------------------------------------------------------------------------
const SINGLE_OBJECT_LIMIT = 64 << 20   // a JSON that is a single object is read whole only up to this size

// Integers with more than 15 digits: read exactly when the browser allows it (JSON.parse with "source").
const SUPPORTS_SOURCE = (() => {
  let ok = false
  try { JSON.parse('1', (k, v, c) => { ok = !!c && 'source' in c; return v }) } catch { /* not supported */ }
  return ok
})()
const RE_LONG_DIGITS = /\d{16}/
function reviveIntegers(k, v, c) {
  if (typeof v === 'number' && !Number.isSafeInteger(v) && Number.isInteger(v) && c && /^-?\d+$/.test(c.source)) return BigInt(c.source)
  return v
}
function parseJSON(text) {
  return SUPPORTS_SOURCE && RE_LONG_DIGITS.test(text) ? JSON.parse(text, reviveIntegers) : JSON.parse(text)
}
function toJSONText(v) {
  return JSON.stringify(v, (k, x) => (typeof x === 'bigint'
    ? (typeof JSON.rawJSON === 'function' ? JSON.rawJSON(x.toString()) : x.toString()) : x))
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function flatten(obj, prefix, fn) {
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    const key = prefix === '' ? k : `${prefix}.${k}`
    if (v !== null && typeof v === 'object') {
      if (Array.isArray(v)) fn(key, toJSONText(v), true)
      else flatten(v, key, fn)
    } else {
      fn(key, v, false)
    }
  }
}

function looksLikeJsonLines(text, complete) {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (!complete) lines.pop()     // the last one may be cut
  if (lines.length < 2) return false
  try {
    return lines.slice(0, 5).every(l => isObject(JSON.parse(l)))
  } catch {
    return false
  }
}

export async function detectJsonFormat(file, op) {
  const { bytes, complete } = await readSample(file)
  if (!bytes.length) throw new ConversionError('err_empty_file')
  let encoding = op.encoding === 'auto' ? detectEncoding(bytes) : op.encoding
  if (encoding === 'utf-16le' && bytes[0] === 0xFE && bytes[1] === 0xFF) encoding = 'utf-16be'
  const text = new TextDecoder(encoding).decode(bytes, { stream: !complete })
  const s = text.trimStart()
  if (!s) throw new ConversionError('err_empty_file')
  const name = file.name.toLowerCase().replace(/\.gz$/, '')
  let mode
  if (name.endsWith('.jsonl') || name.endsWith('.ndjson')) mode = 'lines'
  else if (s[0] === '[') mode = 'document'
  else if (s[0] === '{') mode = looksLikeJsonLines(s, complete) ? 'lines' : 'document'
  else throw new ConversionError('err_json_not_json')
  return { kind: 'json', mode, encoding, sampleText: text, complete, key: null, names: [], keys: [] }
}

export function describeJson(fmt) {
  if (fmt.mode === 'lines') return new Msg('fmt_json_lines')
  if (fmt.single) return new Msg('fmt_json_single')
  if (fmt.key != null) return new Msg('fmt_json_key', { key: fmt.key })
  return new Msg('fmt_json_list')
}

// Splits JSON Lines into lines.
class LineScanner {
  constructor(onRecord) {
    this.onRecord = onRecord
    this.rest = ''
    this.line = 0
  }

  push(s) {
    let text = this.rest + s
    let start = 0
    let end
    while ((end = text.indexOf('\n', start)) !== -1) {
      this.line++
      const l = text.slice(start, end).trim()
      if (l) this.onRecord(l, this.line)
      start = end + 1
    }
    this.rest = text.slice(start)
    text = null
  }

  finish() {
    const l = this.rest.trim()
    this.line++
    if (l) this.onRecord(l, this.line)
    this.rest = ''
  }
}

// Walks a JSON document block by block and hands over the text of each object
// of the list of records, without loading the whole file into memory.
const RE_STRING = /["\\]/g
const RE_STRUCTURE = /["{}[\]]/g

class JsonScanner {
  constructor(onRecord, onBad) {
    this.onRecord = onRecord         // (text, item number)
    this.onBad = onBad               // (item number) for items that are not objects
    this.stack = []
    this.inString = false
    this.escapePending = false
    this.capturing = false
    this.pieces = []
    this.depth = -1                  // stack depth inside the list of records
    this.awaitingFirst = false
    this.candidate = false           // the list is the value of a key of the root object
    this.closed = false              // the list of records has been walked
    this.items = 0
    this.badItem = false
    this.root = 0
    this.end = false
    this.string = null               // text of the current string at level 1 (possible key)
    this.lastString = null
    this.currentKey = null
    this.key = null
    this.emptyKey = null
    this.whole = []                  // copy of the text in case the JSON turns out to be a single object
    this.wholeSize = 0
    this.keepWhole = true
    this.single = false
  }

  _closeString(s, start, end) {
    if (this.string) {
      this.string.push(s.slice(start, end))
      try { this.lastString = JSON.parse('"' + this.string.join('') + '"') } catch { this.lastString = null }
      this.string = null
    }
  }

  push(s) {
    const n = s.length
    if (this.keepWhole && this.root !== 91) {
      this.whole.push(s)
      this.wholeSize += n
      if (this.wholeSize > SINGLE_OBJECT_LIMIT) { this.keepWhole = false; this.whole = [] }
    }
    let i = 0
    let recordStart = this.capturing ? 0 : -1
    let stringStart = this.string ? 0 : -1
    if (this.escapePending && n) { i = 1; this.escapePending = false }
    while (i < n) {
      if (this.inString) {
        RE_STRING.lastIndex = i
        const m = RE_STRING.exec(s)
        if (!m) { i = n; break }
        if (m[0] === '\\') {
          if (m.index + 1 >= n) { this.escapePending = true; i = n; break }
          i = m.index + 2
          continue
        }
        this.inString = false
        if (stringStart >= 0) { this._closeString(s, stringStart, m.index); stringStart = -1 }
        i = m.index + 1
        continue
      }
      let c
      if (this.capturing) {
        RE_STRUCTURE.lastIndex = i
        const m = RE_STRUCTURE.exec(s)
        if (!m) { i = n; break }
        i = m.index
        c = s.charCodeAt(i)
      } else {
        c = s.charCodeAt(i)
        if (c === 32 || c === 10 || c === 13 || c === 9) { i++; continue }
      }
      const depth = this.stack.length
      if (!this.capturing && this.end) throw new ConversionError('err_json_trailing')
      // does an item of the list of records that is not an object start here?
      if (!this.capturing && depth === this.depth && c !== 44 && c !== 93 && c !== 123) {
        if (!this.badItem) {
          this.badItem = true
          this.items++
          if (this.awaitingFirst && this.candidate) {
            this.depth = -1                // it wasn't a list of objects: keep looking
            this.awaitingFirst = false
            this.candidate = false
            this.badItem = false
            this.items = 0
          } else if (this.awaitingFirst) {
            throw new ConversionError('err_json_scalars')
          } else {
            this.onBad(this.items)
          }
        }
      }
      if (c === 34) {
        if (depth === 0) throw new ConversionError('err_json_not_json')
        this.inString = true
        if (!this.capturing && depth === 1 && this.root === 123) { this.string = []; stringStart = i + 1 }
        i++
        continue
      }
      if (c === 123 || c === 91) {
        if (depth === 0) {
          if (this.root) throw new ConversionError('err_json_trailing')
          this.root = c
          if (c === 91) { this.depth = 1; this.awaitingFirst = true; this.keepWhole = false; this.whole = [] }
        } else if (!this.capturing && depth === this.depth && c === 123) {
          this.capturing = true
          recordStart = i
          this.pieces = []
          this.items++
          if (this.awaitingFirst) {
            this.awaitingFirst = false
            if (this.candidate) { this.key = this.currentKey; this.keepWhole = false; this.whole = [] }
          }
        } else if (!this.capturing && this.depth === -1 && !this.closed && depth === 1 && this.root === 123 && c === 91) {
          this.depth = 2
          this.awaitingFirst = true
          this.candidate = true
        }
        this.stack.push(c)
        i++
        continue
      }
      if (c === 125 || c === 93) {
        this.stack.pop()
        const p = this.stack.length
        if (this.capturing && p === this.depth) {
          const text = this.pieces.length ? this.pieces.join('') + s.slice(recordStart, i + 1) : s.slice(recordStart, i + 1)
          this.pieces = []
          this.capturing = false
          recordStart = -1
          this.onRecord(text, this.items)
        } else if (!this.capturing && c === 93 && p === this.depth - 1) {
          if (this.awaitingFirst && this.candidate) {      // empty list as the value of a key
            if (this.emptyKey === null) this.emptyKey = this.currentKey
            this.depth = -1
          } else {
            this.closed = true
            this.depth = -1
          }
          this.awaitingFirst = false
          this.candidate = false
        }
        if (p === 0) this.end = true
        i++
        continue
      }
      if (c === 44 && depth === this.depth) this.badItem = false
      if (c === 58 && depth === 1 && this.root === 123 && !this.capturing) this.currentKey = this.lastString
      if (depth === 0 && c !== 44) throw new ConversionError('err_json_not_json')
      i++
    }
    if (this.capturing && recordStart >= 0) this.pieces.push(s.slice(recordStart))
    if (this.string && stringStart >= 0) this.string.push(s.slice(stringStart))
  }

  finish() {
    if (this.inString || this.stack.length || this.capturing) throw new ConversionError('err_json_incomplete')
    if (!this.root) throw new ConversionError('err_empty_file')
    if (this.root === 123 && this.key === null && !this.closed) {
      if (this.emptyKey !== null) { this.key = this.emptyKey; return }
      if (!this.keepWhole) throw new ConversionError('err_json_single_too_big')
      this.single = true
      this.onRecord(this.whole.join('').trim(), 1)
      this.whole = []
    }
  }
}

// Columns as they appear in the objects (in order of appearance)
class JsonColumns {
  constructor(dmy) {
    this.dmy = dmy
    this.indexes = new Map()
    this.keys = []
    this.names = []
    this.used = new Set()
    this.guessers = []
  }

  index(key) {
    let k = this.indexes.get(key)
    if (k === undefined) {
      k = this.keys.length
      let name = key.replace(/\uFEFF/g, '').trim() || `column_${k + 1}`
      const base = name
      for (let j = 2; this.used.has(name.toLowerCase()); j++) name = `${base}_${j}`
      this.used.add(name.toLowerCase())
      this.indexes.set(key, k)
      this.keys.push(key)
      this.names.push(name)
      this.guessers.push(new JsonTypeGuesser(this.dmy))
    }
    return k
  }
}

const J_INT = 1
const J_FLOAT = 2
const J_BOOL = 4
const J_TEXT = 8
const MIN_I64 = -(2n ** 63n)
const MAX_I64 = 2n ** 63n

function jsonKind(seen, dates, time) {
  if (seen === J_INT) return 'int'
  if (seen === J_FLOAT || seen === (J_INT | J_FLOAT)) return 'float'
  if (seen === J_BOOL) return 'bool'
  if (seen === J_TEXT) return dates ? (time ? 'timestamp' : 'date') : 'string'
  return 'string'
}

class JsonTypeGuesser {
  constructor(dmy) {
    this.dmy = dmy
    this.seen = 0
    this.valid = 0
    this.literals = 0
    this.dates = true
    this.time = false
    this.zone = false
    this.mixed = null
  }

  probe(v, isList, record) {
    if (v === null || v === undefined) return
    this.literals++
    if (v === '') return            // "" does not decide the type (in date columns it counts as empty)
    this.valid++
    let cat
    switch (typeof v) {
      case 'number': cat = Number.isSafeInteger(v) ? J_INT : J_FLOAT; break
      case 'bigint':
        cat = v >= MIN_I64 && v < MAX_I64 ? J_INT : J_TEXT     // outside INT64: stored as text
        if (cat === J_TEXT) this.dates = false
        break
      case 'boolean': cat = J_BOOL; break
      default:
        cat = J_TEXT
        if (this.dates) {
          const f = isList ? null : parseDate(v, this.dmy)
          if (!f) this.dates = false
          else { if (f.time) this.time = true; if (f.zone) this.zone = true }
        }
    }
    const before = this.seen
    this.seen |= cat
    if (!this.mixed && before && before !== this.seen && jsonKind(this.seen, false, false) === 'string' &&
        jsonKind(before, this.dates, this.time) !== 'string') {
      this.mixed = { value: typeof v === 'string' ? v : toJSONText(v), record }
    }
  }

  kind() {
    if (!this.valid) return this.literals ? 'string' : 'null'
    return jsonKind(this.seen, this.dates, this.time)
  }
}

function createJsonConverter(kind, dmy) {
  switch (kind) {
    case 'int': return v => (typeof v === 'bigint' ? v : BigInt(v))
    case 'float': return v => Number(v)
    case 'bool': return v => v
    case 'date':
      return v => {
        if (v === '') return null
        const f = parseDate(v, dmy)
        if (!f) throw new Error()
        return Math.floor(f.ms / MS_PER_DAY)
      }
    case 'timestamp':
      return v => {
        if (v === '') return null
        const f = parseDate(v, dmy)
        if (!f) throw new Error()
        return BigInt(f.ms)
      }
    default:
      return v => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v)
        : typeof v === 'bigint' ? v.toString() : toJSONText(v))
  }
}

function badRecord(fmt, number, text) {
  const sample = text == null ? '…' : `${text.replace(/\s+/g, ' ').slice(0, 80)}${text.length > 80 ? '…' : ''}`
  return new ConversionError(fmt.mode === 'lines' ? 'err_json_bad_line' : 'err_json_bad_item', { n: number, text: sample })
}

function createScanner(fmt, onObject, onBad) {
  const onText = (text, number) => {
    let obj
    try {
      obj = parseJSON(text)
    } catch {
      onBad(number, text)
      return
    }
    if (!isObject(obj)) { onBad(number, text); return }
    onObject(obj, number)
  }
  return fmt.mode === 'lines' ? new LineScanner(onText) : new JsonScanner(onText, n => onBad(n, null))
}

async function analyzeJsonPass(file, fmt, op, progress, cancel) {
  const cols = new JsonColumns(op.dmyDates)
  const allText = op.allText
  let rows = 0
  let bad = 0
  const scanner = createScanner(fmt, obj => {
    rows++
    flatten(obj, '', (key, v, isList) => {
      const k = cols.index(key)
      if (!allText) cols.guessers[k].probe(v, isList, rows)
    })
  }, (number, text) => {
    if (op.skipBadRows) { bad++; return }
    throw badRecord(fmt, number, text)
  })
  const dec = createDecoder(fmt.encoding)
  for await (const bytes of readBytes(file, progress, cancel)) scanner.push(dec.decode(bytes))
  scanner.push(dec.decode(new Uint8Array(0), false))
  scanner.finish()
  const finalFmt = {
    ...fmt, sampleText: null, key: scanner.key ?? null, single: !!scanner.single, names: cols.names, keys: cols.keys,
  }
  const kinds = allText ? cols.names.map(() => 'string') : cols.guessers.map(g => g.kind())
  const mixed = []
  cols.guessers.forEach((g, j) => { if (kinds[j] === 'string' && g.mixed) mixed.push({ column: cols.names[j], ...g.mixed }) })
  if (!cols.names.length) throw new ConversionError(rows ? 'err_json_empty_objects' : 'err_json_no_records')
  return { fmt: finalFmt, kinds, zones: cols.guessers.map(g => g.zone), rows, bad, mixed }
}

async function writeJsonPass(file, an, op, acc, label, progress, cancel) {
  const { fmt } = an
  const index = new Map(acc.columns.map((c, k) => [c.name, k]))
  const map = new Map(fmt.keys.map((key, j) => [key, index.get(fmt.names[j])]))
  const ncol = acc.columns.length
  const kSource = label != null ? index.get(acc.sourceName) : -1
  const conv = acc.columns.map(c => createJsonConverter(c.kind, op.dmyDates))
  const row = new Array(ncol)
  let number = 0
  const scanner = createScanner(fmt, obj => {
    number++
    row.fill(null)
    flatten(obj, '', (key, v) => {
      const k = map.get(key)
      if (k !== undefined) row[k] = v
    })
    const d = acc.data
    for (let k = 0; k < ncol; k++) {
      if (k === kSource) { d[k].push(label); continue }
      const v = row[k]
      if (v === null || v === undefined) { d[k].push(null); continue }
      try {
        d[k].push(conv[k](v))
      } catch {
        throw new ConversionError('err_value_changed', { value: String(v).slice(0, 60), column: acc.columns[k].name, row: number })
      }
    }
    acc.n++
  }, (n, text) => {
    if (!op.skipBadRows) throw badRecord(fmt, n, text)
  })
  const dec = createDecoder(fmt.encoding)
  for await (const bytes of readBytes(file, progress, cancel)) {
    scanner.push(dec.decode(bytes))
    if (acc.full) await acc.flush()
  }
  scanner.push(dec.decode(new Uint8Array(0), false))
  scanner.finish()
}

async function previewJson(file, op, maxRows) {
  const fmt = await detectJsonFormat(file, op)
  const cols = new JsonColumns(op.dmyDates)
  const records = []
  const MAX = 1000
  const scanner = createScanner(fmt, obj => {
    if (records.length >= MAX) return
    const flat = []
    flatten(obj, '', (key, v, isList) => {
      const k = cols.index(key)
      flat.push([k, v])
      if (!op.allText) cols.guessers[k].probe(v, isList, records.length + 1)
    })
    records.push(flat)
  }, (number, text) => {
    if (op.skipBadRows) return
    throw badRecord(fmt, number, text)
  })
  scanner.push(fmt.sampleText)
  if (fmt.complete) scanner.finish()
  if (!records.length) throw new ConversionError(fmt.complete ? 'err_json_no_records' : 'err_json_preview_no_record')
  const kinds = op.allText ? cols.names.map(() => 'string') : cols.guessers.map(g => g.kind())
  const conv = kinds.map(k => createJsonConverter(k, op.dmyDates))
  const values = records.slice(0, maxRows).map(flat => {
    const row = new Array(cols.names.length).fill(null)
    for (const [k, v] of flat) {
      if (v === null || v === undefined) continue
      try { row[k] = conv[k](v) } catch { row[k] = v }
    }
    return row
  })
  const f = { ...fmt, sampleText: null, key: scanner.key ?? null, single: !!scanner.single }
  return { ...f, description: describeJson(f), names: cols.names, kinds, values, sampleRows: records.length }
}

export async function preview(file, op, maxRows = 200) {
  return isJSON(file.name) ? previewJson(file, op, maxRows) : previewCsv(file, op, maxRows)
}

function writePass(file, an, op, columns, acc, label, progress, cancel) {
  return an.fmt.kind === 'json'
    ? writeJsonPass(file, an, op, acc, label, progress, cancel)
    : writeCsvPass(file, an, op, columns, acc, label, progress, cancel)
}

// --------------------------------------------------------------------------
//  Second pass: writing
// --------------------------------------------------------------------------
function createParquetWriter(columns, compression, sink) {
  const w = new ByteWriter(1 << 20)
  const drain = () => {
    if (!w.index) return undefined
    const b = w.getBytes().slice()
    w.index = 0
    return sink.write(b)
  }
  w.flush = drain
  w.finish = drain
  const schema = [{ name: 'root', num_children: columns.length }, ...columns.map(parquetElement)]
  return new ParquetWriter({
    writer: w,
    schema,
    codec: compression,
    compressors: { GZIP: b => gzipSync(b, { level: 6 }) },
    kvMetadata: [{ key: 'created_by_app', value: 'csv-to-parquet (browser version)' }],
  })
}

class Accumulator {
  constructor(output, columns) {
    this.output = output
    this.columns = columns
    this.data = columns.map(() => [])
    this.n = 0
    this.target = Math.max(MIN_GROUP_ROWS, Math.min(MAX_GROUP_ROWS, Math.floor(CELLS_PER_GROUP / columns.length)))
    this.rows = 0
    this.sourceName = null
  }

  get full() { return this.n >= this.target }

  async flush() {
    if (!this.n) return
    const columnData = this.columns.map((c, j) => ({ name: c.name, data: this.data[j] }))
    const n = this.n
    this.data = this.columns.map(() => [])
    this.n = 0
    this.rows += n
    await this.output.write(columnData, n)
  }
}

// --------------------------------------------------------------------------
//  Output: one Parquet or, when splitting, several parts inside a folder
//  named after the file (sales/sales_0001.parquet, …)
// --------------------------------------------------------------------------
function splitPath(path) {
  const i = path.lastIndexOf('/')
  const dir = i >= 0 ? path.slice(0, i + 1) : ''
  const name = path.slice(i + 1)
  return { dir, base: name.replace(/\.parquet$/i, '') }
}

export function splitOption(op) {
  const s = op.split
  if (!s || !(s.value > 0) || (s.mode !== 'rows' && s.mode !== 'mb')) return null
  return s
}

// Folder that holds the parts of a split output
export function partsFolder(output) {
  const { dir, base } = splitPath(output.path)
  return { ...output, path: dir + base }
}

function partsPattern(base) {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${esc}_(\\d{4,})\\.parquet$`, 'i')
}

export async function outputExists(target, output, op) {
  if (!splitOption(op)) return target.exists(output)
  const { base } = splitPath(output.path)
  const names = (await target.list?.(partsFolder(output))) || []
  const re = partsPattern(base)
  return names.some(n => re.test(n))
}

class ParquetOutput {
  constructor(target, output, columns, op) {
    this.target = target
    this.output = output
    this.columns = columns
    this.compression = op.compression
    this.split = splitOption(op)
    this.rowLimit = this.split?.mode === 'rows' ? Math.max(1, Math.floor(this.split.value)) : Infinity
    this.byteLimit = this.split?.mode === 'mb' ? Math.max(0.01, this.split.value) * 1048576 : Infinity
    this.parts = []
    this.current = null
    this.dataBytes = 0
    this.dataRows = 0
  }

  partPath(k) {
    if (!this.split) return this.output
    const { dir, base } = splitPath(this.output.path)
    return { ...this.output, path: `${dir}${base}/${base}_${String(k).padStart(4, '0')}.parquet` }
  }

  async openPart() {
    const output = this.partPath(this.parts.length + 1)
    const file = await this.target.open(output)
    const part = { output, bytes: 0, rows: 0 }
    part.sink = {
      write: b => { part.bytes += b.length; return file.write(b) },
      close: () => file.close(),
      abort: () => file.abort(),
    }
    part.writer = createParquetWriter(this.columns, this.compression, part.sink)
    this.current = part
  }

  async closePart() {
    const p = this.current
    this.current = null
    await p.writer.finish()
    p.bytes = await p.sink.close()
    this.parts.push(p)
  }

  async write(columnData, n) {
    let start = 0
    while (start < n) {
      if (!this.current) await this.openPart()
      const p = this.current
      let k = n - start
      if (this.rowLimit !== Infinity) k = Math.min(k, this.rowLimit - p.rows)
      if (this.byteLimit !== Infinity) {
        // small row groups (≈ ¼ of the limit) so the parts don't overshoot the requested size by much
        const bpr = this.dataRows ? this.dataBytes / this.dataRows : 0
        k = Math.min(k, bpr ? Math.max(1, Math.floor(this.byteLimit / 4 / bpr)) : 10_000)
        if (p.rows > 0 && bpr && p.bytes + k * bpr > this.byteLimit) { await this.closePart(); continue }
      }
      const data = start === 0 && k === n ? columnData : columnData.map(c => ({ name: c.name, data: c.data.slice(start, start + k) }))
      const before = p.bytes
      await p.writer.write({ columnData: data, rowGroupSize: k })
      p.rows += k
      start += k
      this.dataBytes += p.bytes - before
      this.dataRows += k
      if (p.rows >= this.rowLimit || p.bytes >= this.byteLimit) await this.closePart()
    }
  }

  async close() {
    if (this.current) await this.closePart()
    if (!this.parts.length) { await this.openPart(); await this.closePart() }  // no rows: a file with the schema
    if (this.split) await this.removeLeftovers()
    return { bytes: this.parts.reduce((a, p) => a + p.bytes, 0), parts: this.parts.length }
  }

  // When overwriting, removes the parts of a previous conversion that no longer belong
  async removeLeftovers() {
    if (!this.target.list || !this.target.remove) return
    const folder = partsFolder(this.output)
    const { base } = splitPath(this.output.path)
    const re = partsPattern(base)
    for (const name of (await this.target.list(folder)) || []) {
      const m = re.exec(name)
      if (m && Number(m[1]) > this.parts.length) {
        await this.target.remove({ ...folder, path: `${folder.path}/${name}` }).catch(() => {})
      }
    }
  }

  async abort() {
    if (this.current) { await this.current.sink.abort().catch(() => {}); this.current = null }
    for (const p of this.parts) await this.target.remove?.(p.output).catch(() => {})
    this.parts = []
  }
}

async function writeCsvPass(file, an, op, targetColumns, acc, label, progress, cancel) {
  const { fmt } = an
  const ncol = fmt.names.length
  const index = new Map(acc.columns.map((c, k) => [c.name, k]))
  const map = fmt.names.map(n => index.get(n))
  const present = new Set(map)
  const kSource = label != null ? index.get(acc.sourceName) : -1
  const missing = acc.columns.map((_, k) => k).filter(k => !present.has(k) && k !== kSource)
  const conv = fmt.names.map((_, j) => createConverter(targetColumns[map[j]].kind, fmt.decimal, op.dmyDates))
  let headerPending = op.header
  const parser = new CsvParser(fmt.separator, row => {
    if (headerPending) { headerPending = false; return }
    if (row.length !== ncol) {
      if (op.skipBadRows) return
      throw wrongColumns(parser.records, row, ncol, fmt.separator)
    }
    const d = acc.data
    for (let j = 0; j < ncol; j++) {
      let v
      try {
        v = conv[j](row[j])
      } catch {
        throw new ConversionError('err_value_changed', { value: row[j], column: fmt.names[j], row: parser.records })
      }
      d[map[j]].push(v)
    }
    for (const k of missing) d[k].push(null)
    if (kSource >= 0) d[kSource].push(label)
    acc.n++
  })
  const dec = createDecoder(fmt.encoding)
  for await (const bytes of readBytes(file, progress, cancel)) {
    parser.push(dec.decode(bytes))
    if (acc.full) await acc.flush()
  }
  parser.push(dec.decode(new Uint8Array(0), false))
  parser.finish()
}

// --------------------------------------------------------------------------
//  Converting a batch
// --------------------------------------------------------------------------
//  sources: [{ file, name, output }]   (output: whatever the target understands, e.g. { root, path })
//  target:  { exists(output), open(output) -> { write(bytes), close() -> bytes, abort() },
//             list?(folder) -> [names], remove?(output), finish?(results, notify) }
//  notify(event, ...data): ('state', i, phase, fraction) with phase analyzing | writing | waiting
//                          ('done', i, result)   ('log', Msg, level)   level: info | ok | warning | error
export async function convertBatch(sources, op, target, notify = () => {}, cancel = {}) {
  const results = op.combine
    ? await convertCombined(sources, op, target, notify, cancel)
    : await convertSeparately(sources, op, target, notify, cancel)
  if (!cancel.cancelled) await target.finish?.(results, notify)
  return results
}

function newResult(s) {
  return {
    name: s.name, output: s.output, status: 'pending', messages: [], rows: 0, columns: 0,
    sourceBytes: s.file.size, parquetBytes: 0, parts: 0, seconds: 0, format: null, separator: '',
    encoding: '', decimal: '', skippedRows: 0, kinds: null, combined: false,
  }
}

/** All the messages of a result, as text. */
export function resultMessage(r) {
  return (r.messages || []).map(String).join(' ')
}

function describeFormat(r, fmt) {
  r.encoding = fmt.encoding
  if (fmt.kind === 'json') {
    r.format = describeJson(fmt)
    return
  }
  r.format = new Msg('fmt_csv')
  r.separator = fmt.separator
  r.decimal = fmt.decimal
}

function analysisNotes(an) {
  const notes = []
  if (an.note) notes.push(an.note)
  if (an.mixed.length) {
    notes.push(new Msg('note_mixed_columns', {
      items: new MsgList(an.mixed.map(m => new Msg('note_mixed_item', {
        column: m.column, value: m.value.length > 30 ? m.value.slice(0, 29) + '…' : m.value, row: m.record,
      })), '; '),
    }))
  }
  if (an.bad) notes.push(new Msg(an.fmt.kind === 'json' ? 'note_skipped_records' : 'note_skipped_rows', { n: an.bad }))
  return notes
}

/** Explains an exception to the user. */
export function errorMessage(e) {
  if (e instanceof ConversionError) return e.msg
  const n = e?.name
  if (n === 'NotAllowedError' || n === 'SecurityError') return new Msg('err_write_permission')
  if (n === 'NotReadableError' || n === 'NotFoundError') return new Msg('err_read_failed')
  if (n === 'QuotaExceededError') return new Msg('err_disk_full')
  if (n === 'NoModificationAllowedError' || n === 'InvalidStateError') return new Msg('err_target_locked')
  if (e instanceof RangeError) return new Msg('err_out_of_memory')
  return new Msg('raw', { text: e?.message || String(e) })
}

function columnsOf(an) {
  return an.fmt.names.map((name, j) => ({
    name, kind: an.kinds[j] === 'null' ? 'string' : an.kinds[j], utc: an.zones[j],
  }))
}

async function convertSeparately(sources, op, target, notify, cancel) {
  const results = []
  for (let i = 0; i < sources.length; i++) {
    if (cancel.cancelled) break
    const s = sources[i]
    const r = newResult(s)
    const t0 = performance.now()
    let output = null
    try {
      if (!op.overwrite && await outputExists(target, s.output, op)) {
        r.status = 'skipped'
        r.messages = [new Msg('skipped_exists')]
      } else {
        notify('state', i, 'analyzing', 0)
        const an = await analyze(s.file, op, x => notify('state', i, 'analyzing', x * ANALYSIS_WEIGHT), cancel)
        describeFormat(r, an.fmt)
        const columns = columnsOf(an)
        if (!columns.length) throw new ConversionError('err_no_columns')
        notify('state', i, 'writing', ANALYSIS_WEIGHT)
        output = new ParquetOutput(target, s.output, columns, op)
        const acc = new Accumulator(output, columns)
        await writePass(s.file, an, op, columns, acc, null,
          x => notify('state', i, 'writing', ANALYSIS_WEIGHT + x * (1 - ANALYSIS_WEIGHT)), cancel)
        await acc.flush()
        const end = await output.close()
        output = null
        r.parquetBytes = end.bytes
        r.parts = splitOption(op) ? end.parts : 0
        r.rows = acc.rows
        r.columns = columns.length
        r.skippedRows = an.bad
        r.kinds = an.kinds
        r.status = 'ok'
        r.messages = analysisNotes(an)
      }
    } catch (e) {
      if (output) await output.abort().catch(() => {})
      if (e instanceof Cancelled || cancel.cancelled) {
        r.status = 'cancelled'
        r.messages = [new Msg('cancelled_by_user')]
      } else {
        r.status = 'error'
        r.messages = [errorMessage(e)]
      }
    }
    r.seconds = (performance.now() - t0) / 1000
    results.push(r)
    notify('done', i, r)
    if (r.status === 'cancelled') break
  }
  return results
}

async function convertCombined(sources, op, target, notify, cancel) {
  const results = sources.map(newResult)
  const finalOutput = op.combinedOutput
  if (!op.overwrite && await outputExists(target, finalOutput, op)) {
    notify('log', new Msg('log_combined_exists', { path: op.combinedName }), 'error')
    results.forEach((r, i) => { r.status = 'skipped'; r.messages = [new Msg('skipped_combined_exists')]; notify('done', i, r) })
    return results
  }
  // Phase 1: analyze all of them
  const analyses = []
  for (let i = 0; i < sources.length; i++) {
    if (cancel.cancelled) break
    const r = results[i]
    const t0 = performance.now()
    try {
      notify('state', i, 'analyzing', 0)
      const an = await analyze(sources[i].file, op, x => notify('state', i, 'analyzing', x * ANALYSIS_WEIGHT), cancel)
      describeFormat(r, an.fmt)
      analyses[i] = an
      notify('state', i, 'waiting', ANALYSIS_WEIGHT)
    } catch (e) {
      r.status = e instanceof Cancelled || cancel.cancelled ? 'cancelled' : 'error'
      r.messages = [r.status === 'cancelled' ? new Msg('cancelled_by_user') : errorMessage(e)]
      notify('done', i, r)
    }
    r.seconds = (performance.now() - t0) / 1000
  }
  const valid = analyses.map((a, i) => (a ? i : -1)).filter(i => i >= 0)
  if (cancel.cancelled || !valid.length) {
    results.forEach((r, i) => {
      if (r.status === 'pending') { r.status = 'cancelled'; r.messages = [new Msg('cancelled_by_user')]; notify('done', i, r) }
    })
    return results
  }

  // Common schema
  const order = []
  const kindsByColumn = new Map()
  const zoneByColumn = new Map()
  for (const i of valid) {
    const an = analyses[i]
    an.fmt.names.forEach((n, j) => {
      if (!kindsByColumn.has(n)) { order.push(n); kindsByColumn.set(n, []) }
      kindsByColumn.get(n).push(an.kinds[j])
      if (an.zones[j]) zoneByColumn.set(n, true)
    })
  }
  const columns = order.map(n => {
    const k = commonType(kindsByColumn.get(n))
    return { name: n, kind: k === 'null' ? 'string' : k, utc: !!zoneByColumn.get(n) }
  })
  let sourceName = null
  if (op.sourceColumn) {
    // if a file already has a column with that name, another one is used so they don't get mixed up
    const used = new Set(order.map(n => n.toLowerCase()))
    sourceName = SOURCE_COLUMN
    for (let k = 2; used.has(sourceName.toLowerCase()); k++) sourceName = `${SOURCE_COLUMN}_${k}`
    columns.push({ name: sourceName, kind: 'string', utc: false })
  }
  const asText = order.filter(n => {
    const ks = kindsByColumn.get(n).filter(k => k !== 'null' && k !== 'string')
    return commonType(kindsByColumn.get(n)) === 'string' && ks.length > 0
  })

  // Phase 2: write all of them into a single Parquet (or its parts)
  notify('log', new Msg('log_combining', { n: valid.length, name: op.combinedName }), 'info')
  let output = null
  try {
    if (!columns.length) throw new ConversionError('err_files_no_columns')
    output = new ParquetOutput(target, finalOutput, columns, op)
    const acc = new Accumulator(output, columns)
    acc.sourceName = sourceName
    for (const i of valid) {
      checkCancel(cancel)
      const r = results[i]
      const t0 = performance.now()
      const before = acc.rows + acc.n
      try {
        notify('state', i, 'writing', ANALYSIS_WEIGHT)
        await writePass(sources[i].file, analyses[i], op, columns, acc, op.sourceColumn ? sources[i].name : null,
          x => notify('state', i, 'writing', ANALYSIS_WEIGHT + x * (1 - ANALYSIS_WEIGHT)), cancel)
      } catch (e) {
        if (e instanceof Cancelled || cancel.cancelled) throw e
        // a failure halfway through a file would leave partial rows in the combined file: abort everything
        r.status = 'error'
        r.messages = [errorMessage(e)]
        notify('done', i, r)
        throw new ConversionError('err_combine_file', { name: sources[i].name, error: r.messages[0] })
      }
      r.rows = acc.rows + acc.n - before
      r.columns = analyses[i].fmt.names.length
      r.skippedRows = analyses[i].bad
      r.kinds = analyses[i].kinds
      r.status = 'ok'
      r.messages = analysisNotes(analyses[i])
      r.seconds += (performance.now() - t0) / 1000
      r.combined = true
      notify('done', i, r)
    }
    await acc.flush()
    const end = await output.close()
    output = null
    const parts = splitOption(op) ? end.parts : 0
    results.combined = { bytes: end.bytes, parts, rows: acc.rows, columns: columns.length, name: op.combinedName }
    notify('log', new Msg('log_combined_summary', {
      name: op.combinedName, rows: new Msg('rows_count', { n: acc.rows }),
      columns: new Msg('columns_count', { n: columns.length }), size: end.bytes,
      parts: parts ? new Msg('in_parts_suffix', { n: parts }) : '',
    }), 'ok')
    if (asText.length) notify('log', new Msg('log_combined_text_columns', { columns: asText.join(', ') }), 'warning')
  } catch (e) {
    if (output) await output.abort().catch(() => {})
    const cancelled = e instanceof Cancelled || cancel.cancelled
    notify('log', cancelled ? new Msg('log_combine_cancelled_none') : errorMessage(e), 'error')
    results.forEach((r, i) => {
      if (r.status === 'pending' || r.status === 'ok') {
        r.status = cancelled ? 'cancelled' : 'error'
        r.messages = [new Msg(cancelled ? 'cancelled_by_user' : 'not_combined')]
        notify('done', i, r)
      }
    })
  }
  return results
}
export const __createScanner = createScanner  // for the tests only
