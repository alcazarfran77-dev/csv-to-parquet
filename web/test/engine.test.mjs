// Tests of the browser engine (src/engine.js), run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parquetReadObjects, parquetMetadata } from 'hyparquet'
import * as E from '../src/engine.js'
import { setLanguage } from '../src/i18n.js'
import { convertPath, nodeFile } from './run-node.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(HERE, '..', '..', 'tests', 'fixtures')
setLanguage('en')

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'csv-to-parquet-'))
}

async function read(file) {
  const b = fs.readFileSync(file)
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  return parquetReadObjects({ file: buf })
}

async function one(rel, options = {}) {
  const out = tmp()
  const [r] = await convertPath(path.join(FIXTURES, rel), out, options)
  return { r, out }
}

const keys = r => r.messages.map(m => m.key)

test('CSV: types, separator and quoted values', async () => {
  const { r, out } = await one('csv/sales.csv')
  assert.equal(r.status, 'ok')
  assert.equal(r.rows, 300)
  assert.equal(r.separator, ',')
  assert.deepEqual(r.kinds, ['int', 'string', 'float', 'date', 'string'])
  const rows = await read(path.join(out, 'sales.parquet'))
  assert.equal(rows[24].comment, 'Order, urgent')
  assert.equal(typeof rows[0].id, 'bigint')
})

test('CSV: Excel export with BOM, messy header and decimal comma', async () => {
  const { r, out } = await one('csv/erp_export.csv')
  assert.equal(r.decimal, ',')
  const rows = await read(path.join(out, 'erp_export.parquet'))
  assert.deepEqual(Object.keys(rows[0]), ['Order', 'Artículo', 'column_3', 'Artículo_2', 'order_2'])
  assert.equal(rows[1].order_2, 10.5)
})

test('CSV: Windows-1252 and dd/mm/yyyy dates', async () => {
  const { r } = await one('csv/inventory_es.csv')
  assert.equal(r.encoding, 'windows-1252')
  assert.deepEqual(r.kinds, ['string', 'string', 'int', 'float', 'date', 'string'])
})

test('CSV: a column that turns into text is reported', async () => {
  const { r } = await one('csv/late_text.csv')
  assert.equal(r.kinds[1], 'string')
  assert.deepEqual(keys(r), ['note_mixed_columns'])
  assert.match(E.resultMessage(r), /batch \(e\.g\. “N\/D” in record 2,002\)/)
})

test('CSV: malformed rows stop the file unless they are skipped', async () => {
  let { r, out } = await one('csv/malformed.csv')
  assert.equal(r.status, 'error')
  assert.deepEqual(keys(r), ['err_wrong_columns'])
  assert.equal(fs.readdirSync(out).length, 0)                    // nothing half-written
  ;({ r } = await one('csv/malformed.csv', { skipBadRows: true }))
  assert.equal(r.status, 'ok')
  assert.equal(r.rows, 2)
  assert.deepEqual(keys(r), ['note_skipped_rows'])
})

test('CSV: empty file, header only, TSV and .gz', async () => {
  assert.deepEqual(keys((await one('csv/empty.csv')).r), ['err_empty_file'])
  assert.equal((await one('csv/header_only.csv')).r.rows, 0)
  assert.equal((await one('csv/plant/defects.tsv')).r.separator, '\t')
  assert.equal((await one('csv/plant/history.csv.gz')).r.rows, 2000)
})

test('CSV parser: quotes, CRLF and line breaks split across blocks', () => {
  const text = 'a,b\r\n"x, ""y""","multi\nline"\r\n3,4\r\n'
  for (let size = 1; size <= text.length; size++) {
    const rows = []
    const p = new E.CsvParser(',', r => rows.push(r))
    for (let i = 0; i < text.length; i += size) p.push(text.slice(i, i + size))
    p.finish()
    assert.deepEqual(rows, [['a', 'b'], ['x, "y"', 'multi\nline'], ['3', '4']], `block size ${size}`)
  }
  const p = new E.CsvParser(',', () => {})
  p.push('a,b\n"open,2\n')
  assert.throws(() => p.finish(), e => e.msg.key === 'err_unclosed_quote')
})

test('Dates', () => {
  assert.equal(E.parseDate('2026-03-05', true).ms, Date.UTC(2026, 2, 5))
  assert.equal(E.parseDate('05/03/2026', true).ms, Date.UTC(2026, 2, 5))
  assert.equal(E.parseDate('05/03/2026', false), null)
  assert.equal(E.parseDate('2026-01-01T10:00:00+02:00', true).ms, Date.UTC(2026, 0, 1, 8))
  assert.equal(E.parseDate('2026-02-30', true), null)
})

test('JSON: list, JSON Lines, wrapper, single object, .gz', async () => {
  const cases = [
    ['json/list.json', 400, 'fmt_json_list'], ['json/lines.jsonl', 400, 'fmt_json_lines'],
    ['json/wrapper.json', 120, 'fmt_json_key'], ['json/single_object.json', 1, 'fmt_json_single'],
    ['json/nested/compressed.jsonl.gz', 150, 'fmt_json_lines'],
  ]
  for (const [rel, rows, key] of cases) {
    const { r } = await one(rel)
    assert.equal(r.status, 'ok', rel)
    assert.equal(r.rows, rows, rel)
    assert.equal(r.format.key, key, rel)
  }
  const { out } = await one('json/list.json')
  const rows = await read(path.join(out, 'list.parquet'))
  assert.equal(rows[2].tags, '["a","b"]')
  assert.equal(rows[0]['customer.contact.email'], 'c0@example.com')
  assert.equal(rows[0].size, null)
})

test('JSON: mixed types and big integers', async () => {
  const { r, out } = await one('json/mixed.json')
  assert.deepEqual(r.kinds, ['string', 'float', 'int', 'string', 'timestamp', 'date', 'string'])
  const rows = await read(path.join(out, 'mixed.parquet'))
  assert.deepEqual(rows.map(x => x.big), [9007199254740993n, 9007199254740995n, -9223372036854775808n])
  assert.equal(rows[0].huge, '123456789012345678901234567890')
})

test('JSON: errors', async () => {
  const cases = {
    'json/scalars.json': 'err_json_scalars', 'json/broken.json': 'err_json_incomplete',
    'json/empty_list.json': 'err_json_no_records', 'json/empty.json': 'err_empty_file',
    'json/bad_line.jsonl': 'err_json_bad_line',
  }
  for (const [rel, key] of Object.entries(cases)) assert.deepEqual(keys((await one(rel)).r), [key], rel)
  const { r } = await one('json/bad_line.jsonl', { skipBadRows: true })
  assert.equal(r.rows, 3)
})

test('JSON scanner: the result does not depend on the block size', async () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'json/wrapper.json'), 'utf8')
  const collect = size => {
    const records = []
    const scanner = E.__createScanner({ mode: 'document' }, (obj, n) => records.push([n, obj.id]), () => {})
    for (let i = 0; i < text.length; i += size) scanner.push(text.slice(i, i + size))
    scanner.finish()
    return { records, key: scanner.key }
  }
  const whole = collect(text.length)
  assert.equal(whole.key, 'data')
  assert.equal(whole.records.length, 120)
  for (const size of [1, 2, 3, 7, 64, 1000]) assert.deepEqual(collect(size), whole, `block size ${size}`)
})

test('Split by rows, overwrite and skip', async () => {
  const out = tmp()
  const src = path.join(FIXTURES, 'json/list.json')
  let [r] = await convertPath(src, out, { split: { mode: 'rows', value: 100 } })
  assert.equal(r.parts, 4)
  const folder = path.join(out, 'list')
  const counts = fs.readdirSync(folder).sort().map(f => parquetMetadata(
    new Uint8Array(fs.readFileSync(path.join(folder, f))).buffer).num_rows)
  assert.deepEqual(counts.map(Number), [100, 100, 100, 100])
  ;[r] = await convertPath(src, out, { split: { mode: 'rows', value: 100 }, overwrite: false })
  assert.equal(r.status, 'skipped')
  ;[r] = await convertPath(src, out, { split: { mode: 'rows', value: 300 } })
  assert.deepEqual(fs.readdirSync(folder).sort(), ['list_0001.parquet', 'list_0002.parquet'])
})

test('Combine several files, with source column and parts', async () => {
  const out = tmp()
  const logs = []
  const results = await convertPath(path.join(FIXTURES, 'json'), out,
    { combine: true, split: { mode: 'rows', value: 500 }, skipBadRows: true },
    (ev, ...d) => { if (ev === 'log') logs.push(d[0].key) })
  assert.ok(results.combined)
  assert.ok(logs.includes('log_combined_summary'))
  const files = fs.readdirSync(path.join(out, 'combined'))
  assert.equal(files.length, Math.ceil(results.combined.rows / 500))
  const first = await read(path.join(out, 'combined', files.sort()[0]))
  assert.ok('source_file' in first[0])
})

test('Cancel', async () => {
  const out = tmp()
  const [r] = await convertPath(path.join(FIXTURES, 'json/list.json'), out, {}, () => {}, { cancelled: true })
  assert.equal(r, undefined)                                       // nothing was started
  const file = await nodeFile(path.join(FIXTURES, 'json/list.json'))
  await assert.rejects(E.analyze(file, E.DEFAULT_OPTIONS, null, { cancelled: true }), E.Cancelled)
})
