// User interface of "CSV to Parquet" (browser version).
import * as E from './engine.js'
import { t, Msg, MsgList, setLanguage, getLanguage, detectLanguage, LANGUAGES, fmtInt, fmtBytes, fmtSeconds } from './i18n.js'

const $ = id => document.getElementById(id)
const CAN_PICK_FOLDER = typeof window.showDirectoryPicker === 'function'
const OPTIONS_KEY = 'csv-to-parquet:options'
const LANGUAGE_KEY = 'csv-to-parquet:language'

const state = {
  items: [],              // everything chosen: { file, root, relPath, depth, rootHandle }
  sources: [],            // what will be converted (filtered and sorted)
  sourceNames: [],        // names of what was chosen (for the log)
  results: new Map(),     // source index -> engine result
  fraction: [],           // progress of each source (0..1)
  phase: [],              // 'analyzing' | 'writing' | 'waiting' while a source is being converted
  targetHandle: null,
  busy: false,
  cancel: null,
  selected: -1,
  previewToken: 0,
  preview: null,          // what the Preview tab shows: { data } | { error } | { reading } | { empty }
  lastDownload: null,
  dirty: new Set(),
  painting: false,
  started: 0,
  runs: 0,
  status: new Msg('bar_start'),
  resultBox: null,        // { text: MsgList, errors, cancelled }
  logEntries: [],         // { time: Date, msg, level }
  lastStatus: '',
}

// --------------------------------------------------------------------------
//  Language
// --------------------------------------------------------------------------
function readStoredLanguage() {
  try { return localStorage.getItem(LANGUAGE_KEY) } catch { return null }
}

function switchLanguage(code) {
  if (state.busy || code === getLanguage()) return
  setLanguage(code)
  try { localStorage.setItem(LANGUAGE_KEY, code) } catch { /* storage not available: not a problem */ }
  applyLanguage()
}

// Puts every text of the page in the current language.
function applyLanguage() {
  const lang = getLanguage()
  document.documentElement.lang = lang
  document.title = t('app_title')
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n)
  for (const el of document.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel))
  for (const b of document.querySelectorAll('.languages button')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang))
  $('source-col-text').textContent = t('opt_source_column', { column: E.SOURCE_COLUMN })
  if (state.targetHandle) $('target-folder').textContent = state.targetHandle.name
  fillSelect($('opt-sep'), E.SEPARATORS, $('opt-sep').value)
  fillSelect($('opt-enc'), E.ENCODINGS, $('opt-enc').value)
  fillSelect($('opt-dec'), E.DECIMALS, $('opt-dec').value)
  fillSelect($('opt-compression'), E.COMPRESSIONS, $('opt-compression').value)
  paintZone()
  paintTable()
  paintPreview()
  paintLog()
  paintStatus()
  paintResultBox()
  updateControls()
}

// --------------------------------------------------------------------------
//  Options (remembered in this browser)
// --------------------------------------------------------------------------
function readSaved() {
  try {
    return JSON.parse(localStorage.getItem(OPTIONS_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

function saveOptions() {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify({
      ...engineOptions(), subfolders: $('opt-subfolders').checked, keepStructure: $('opt-structure').checked,
      target: targetMode(), splitOn: $('opt-split').checked, splitUnit: $('opt-split-unit').value,
      splitValue: $('opt-split-value').value,
    }))
  } catch { /* storage not available: not a problem */ }
}

function fillSelect(sel, choices, value) {
  sel.replaceChildren(...Object.entries(choices).map(([v, key]) => new Option(t(key), v)))
  sel.value = value in choices ? value : Object.keys(choices)[0]
}

function radio(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value
}

function setRadio(name, value) {
  const r = document.querySelector(`input[name="${name}"][value="${value}"]`)
  if (r && !r.disabled) r.checked = true
}

function engineOptions() {
  let name = $('opt-combined-name').value.trim().replace(/[\\/:*?"<>|]+/g, '_') || E.DEFAULT_OPTIONS.combinedName
  if (!name.toLowerCase().endsWith('.parquet')) name += '.parquet'
  return {
    separator: $('opt-sep').value,
    encoding: $('opt-enc').value,
    decimal: $('opt-dec').value,
    header: $('opt-header').checked,
    dmyDates: $('opt-dmy').checked,
    allText: $('opt-all-text').checked,
    skipBadRows: $('opt-skip-bad').checked,
    compression: $('opt-compression').value,
    combine: radio('output') === 'combine',
    combinedName: name,
    sourceColumn: $('opt-source-col').checked,
    overwrite: $('opt-overwrite').checked,
    split: $('opt-split').checked ? { mode: $('opt-split-unit').value, value: splitValue() } : null,
  }
}

function splitValue() {
  const v = Number(String($('opt-split-value').value).replace(',', '.'))
  return Number.isFinite(v) && v > 0 ? v : 0
}

function targetMode() {
  return radio('target') || (CAN_PICK_FOLDER ? 'folder' : 'download')
}

function initOptions() {
  const g = { ...E.DEFAULT_OPTIONS, ...readSaved() }
  fillSelect($('opt-sep'), E.SEPARATORS, g.separator)
  fillSelect($('opt-enc'), E.ENCODINGS, g.encoding)
  fillSelect($('opt-dec'), E.DECIMALS, g.decimal)
  fillSelect($('opt-compression'), E.COMPRESSIONS, g.compression)
  $('opt-header').checked = g.header
  $('opt-dmy').checked = g.dmyDates
  $('opt-all-text').checked = g.allText
  $('opt-skip-bad').checked = g.skipBadRows
  $('opt-combined-name').value = g.combinedName
  $('opt-source-col').checked = g.sourceColumn
  $('opt-overwrite').checked = g.overwrite
  $('opt-subfolders').checked = g.subfolders ?? true
  $('opt-structure').checked = g.keepStructure ?? true
  $('opt-split').checked = !!g.splitOn
  $('opt-split-unit').value = g.splitUnit === 'mb' ? 'mb' : 'rows'
  if (g.splitValue) $('opt-split-value').value = g.splitValue
  setRadio('output', g.combine ? 'combine' : 'per-file')
  if (!CAN_PICK_FOLDER) {
    const r = document.querySelector('input[name="target"][value="folder"]')
    r.disabled = true
    $('label-folder').classList.add('disabled')
    $('btn-target').disabled = true
  }
  setRadio('target', g.target && g.target !== 'next-to' ? g.target : (CAN_PICK_FOLDER ? 'folder' : 'download'))
  if (!radio('target')) setRadio('target', 'download')
}

// --------------------------------------------------------------------------
//  Enabling / disabling depending on the context
// --------------------------------------------------------------------------
function canSaveNextTo() {
  return CAN_PICK_FOLDER && state.sources.length > 0 && state.sources.every(s => s.rootHandle)
}

function updateControls() {
  const busy = state.busy
  const rNextTo = document.querySelector('input[name="target"][value="next-to"]')
  rNextTo.disabled = busy || !canSaveNextTo()
  $('label-next-to').classList.toggle('disabled', rNextTo.disabled)
  if (rNextTo.checked && !canSaveNextTo()) setRadio('target', CAN_PICK_FOLDER ? 'folder' : 'download')
  const mode = targetMode()
  const combine = radio('output') === 'combine'

  const help = CAN_PICK_FOLDER ? '' : t('dst_help_download_only')
  $('target-help').textContent = help
  $('target-help').hidden = !help
  $('label-next-to').title = rNextTo.disabled && !busy ? t('dst_next_to_hint') : ''

  const withStructure = mode !== 'next-to' && !combine
  $('opt-structure').disabled = busy || !withStructure
  $('label-structure').classList.toggle('disabled', !withStructure)
  const withOverwrite = mode !== 'download'
  $('opt-overwrite').disabled = busy || !withOverwrite
  $('label-overwrite').classList.toggle('disabled', !withOverwrite)
  const split = $('opt-split').checked
  $('opt-split').disabled = busy
  $('opt-split-value').disabled = busy || !split
  $('opt-split-unit').disabled = busy || !split
  $('split-help').classList.toggle('disabled', !split)
  $('opt-combined-name').disabled = busy || !combine
  $('opt-source-col').disabled = busy || !combine
  $('label-source-col').classList.toggle('disabled', !combine)

  for (const id of ['btn-files', 'btn-folder', 'opt-subfolders', 'opt-compression', 'opt-sep', 'opt-enc', 'opt-dec',
    'opt-header', 'opt-dmy', 'opt-all-text', 'opt-skip-bad']) $(id).disabled = busy
  for (const r of document.querySelectorAll('input[name="output"], input[name="target"]')) {
    if (r.value !== 'next-to' && !(r.value === 'folder' && !CAN_PICK_FOLDER)) r.disabled = busy
  }
  for (const b of document.querySelectorAll('.languages button')) b.disabled = busy
  $('btn-target').disabled = busy || !CAN_PICK_FOLDER
  $('btn-convert').disabled = busy || !state.sources.length
  $('btn-cancel').disabled = !busy
  $('drop-zone').setAttribute('aria-disabled', String(busy))
}

// --------------------------------------------------------------------------
//  Source: files, folder or drag and drop
// --------------------------------------------------------------------------
async function walkHandle(dir, rootHandle, prefix, depth, items) {
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'directory') {
      await walkHandle(h, rootHandle, `${prefix}${name}/`, depth + 1, items)
    } else if (E.isSupported(name)) {
      items.push({ file: await h.getFile(), root: rootHandle.name, relPath: prefix + name, depth, rootHandle })
    }
  }
}

function readEntries(reader) {
  return new Promise((ok, fail) => reader.readEntries(ok, fail))
}

async function walkEntry(dir, root, prefix, depth, items) {
  const reader = dir.createReader()
  for (let batch = await readEntries(reader); batch.length; batch = await readEntries(reader)) {
    for (const e of batch) {
      if (e.isDirectory) {
        await walkEntry(e, root, `${prefix}${e.name}/`, depth + 1, items)
      } else if (E.isSupported(e.name)) {
        const file = await new Promise((ok, fail) => e.file(ok, fail))
        items.push({ file, root, relPath: prefix + e.name, depth, rootHandle: null })
      }
    }
  }
}

function fromFileList(files) {
  const items = []
  for (const file of files) {
    if (!E.isSupported(file.name)) continue
    const rel = file.webkitRelativePath
    if (rel) {
      const parts = rel.split('/')
      items.push({ file, root: parts[0], relPath: parts.slice(1).join('/'), depth: parts.length - 2, rootHandle: null })
    } else {
      items.push({ file, root: '', relPath: file.name, depth: 0, rootHandle: null })
    }
  }
  return items
}

async function chooseSourceFolder() {
  if (state.busy) return
  if (CAN_PICK_FOLDER) {
    try {
      const h = await window.showDirectoryPicker({ id: 'csv-source', mode: 'read' })
      setStatus(new Msg('status_searching_in', { name: h.name }))
      const items = []
      await walkHandle(h, h, '', 0, items)
      setItems(items, [h.name])
      return
    } catch (e) {
      if (e.name === 'AbortError') return
      log(new Msg('log_picker_fallback', { error: e.name }), 'warning')
    }
  }
  $('input-folder').click()
}

async function onDrop(ev) {
  ev.preventDefault()
  $('drop-zone').classList.remove('dragover')
  if (state.busy) return
  const elements = [...ev.dataTransfer.items].filter(i => i.kind === 'file')
  if (!elements.length) return
  // everything in the DataTransfer must be requested during the event, before the first await
  const withHandles = CAN_PICK_FOLDER && typeof elements[0].getAsFileSystemHandle === 'function'
  const promises = withHandles ? elements.map(i => i.getAsFileSystemHandle().catch(() => null)) : []
  const entries = elements.map(i => i.webkitGetAsEntry?.()).filter(Boolean)
  const loose = [...ev.dataTransfer.files]
  setStatus(new Msg('status_searching'))
  const items = []
  const names = []
  try {
    const handles = withHandles ? (await Promise.all(promises)).filter(Boolean) : []
    if (handles.length) {
      for (const h of handles) {
        names.push(h.name)
        if (h.kind === 'directory') await walkHandle(h, h, '', 0, items)
        else if (E.isSupported(h.name)) items.push({ file: await h.getFile(), root: '', relPath: h.name, depth: 0, rootHandle: null })
      }
    } else if (entries.length) {
      for (const e of entries) {
        names.push(e.name)
        if (e.isDirectory) await walkEntry(e, e.name, '', 0, items)
        else if (E.isSupported(e.name)) items.push({ file: await new Promise((ok, fail) => e.file(ok, fail)), root: '', relPath: e.name, depth: 0, rootHandle: null })
      }
    } else {
      items.push(...fromFileList(loose))
      names.push(...loose.map(f => f.name))
    }
  } catch (e) {
    log(new Msg('log_drop_failed', { error: E.errorMessage(e) }), 'error')
  }
  setItems(items, names)
}

function setItems(items, names = []) {
  state.items = items
  state.sourceNames = names
  state.results.clear()
  state.selected = -1
  updateSources()
}

function updateSources() {
  const sub = $('opt-subfolders').checked
  const roots = new Set(state.items.map(i => i.root))
  const several = roots.size > 1
  state.sources = state.items
    .filter(i => sub || i.depth <= 0)
    .map(i => ({ ...i, name: several && i.root ? `${i.root}/${i.relPath}` : i.relPath }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }))
  state.results.clear()
  state.fraction = state.sources.map(() => 0)
  state.phase = state.sources.map(() => null)
  state.selected = -1
  state.resultBox = null
  paintResultBox()
  paintTable()
  paintZone()
  paintPreviewSelector()
  setProgress(0)
  const n = state.sources.length
  const total = state.sources.reduce((a, s) => a + s.file.size, 0)
  if (n) {
    setStatus(new Msg('bar_ready', { n, size: total }))
    log(new Msg('log_source', { paths: state.sourceNames.join(', ') || t('selection_word'), n }))
    loadPreview()
  } else if (state.items.length || state.sourceNames.length) {
    setStatus(new Msg('bar_none_found'))
    showPreview({ empty: new Msg('preview_empty') })
  }
  updateControls()
}

function paintZone() {
  const n = state.sources.length
  const z = $('drop-zone')
  z.classList.toggle('has-files', n > 0)
  if (!n) {
    $('zone-title').textContent = state.items.length || state.sourceNames.length ? t('zone_none') : t('zone_drop')
    $('zone-sub').textContent = t('zone_types')
    return
  }
  const names = state.sourceNames
  const roots = new Set(state.sources.map(s => s.root))
  let title
  if (roots.size === 1 && [...roots][0]) title = [...roots][0]
  else if (n === 1) title = state.sources[0].file.name
  else if (names.length > 1 && state.sources.some(s => s.root)) title = t('zone_items', { n: names.length })
  else title = t('zone_files', { n })
  $('zone-title').textContent = title
  const total = state.sources.reduce((a, s) => a + s.file.size, 0)
  $('zone-sub').textContent = t('zone_count', { n, size: total })
}

// --------------------------------------------------------------------------
//  Files table
// --------------------------------------------------------------------------
function cells(i) {
  const s = state.sources[i]
  const r = state.results.get(i)
  let status = 'pending'
  let text = t('status_pending')
  if (r) {
    status = r.status
    text = t(`status_${r.status}`)
  } else if (state.phase[i]) {
    status = 'running'
    text = state.phase[i] === 'waiting' ? t('phase_waiting')
      : `${t(`phase_${state.phase[i]}`)} ${Math.floor(state.fraction[i] * 100)} %`
  }
  let pq = ''
  if (r?.status === 'ok') {
    if (r.combined) pq = t('parquet_in_combined')
    else if (r.parts) pq = t('parquet_in_parts', { size: r.parquetBytes, n: r.parts })
    else {
      pq = fmtBytes(r.parquetBytes)
      if (r.sourceBytes >= 16 * 1024) {      // for tiny files the percentage means nothing
        const change = Math.round((1 - r.parquetBytes / r.sourceBytes) * 100)
        pq += '  (' + (change >= 0 ? t('pct_down', { pct: change }) : t('pct_up', { pct: -change })) + ')'
      }
    }
  }
  return {
    status,
    values: [s.name, fmtBytes(s.file.size), text, r?.status === 'ok' ? fmtInt(r.rows) : '',
      r?.status === 'ok' ? String(r.columns) : '', pq, r ? fmtSeconds(r.seconds) : ''],
  }
}

function paintTable() {
  const tbody = $('files-table').tBodies[0]
  const rows = state.sources.map((s, i) => {
    const tr = document.createElement('tr')
    tr.dataset.i = i
    tr.tabIndex = -1
    for (let k = 0; k < 7; k++) {
      const td = document.createElement('td')
      if (k === 0) td.className = 'file'
      if (k === 1 || k >= 3) td.classList.add('num')
      if (k === 2) td.classList.add('status')
      tr.appendChild(td)
    }
    return tr
  })
  tbody.replaceChildren(...rows)
  state.sources.forEach((_, i) => updateRow(i))
  const any = state.sources.length > 0
  $('files-table').hidden = !any
  $('files-empty').hidden = any
  $('file-count').textContent = any ? `(${state.sources.length})` : ''
  paintDetail()
}

function updateRow(i) {
  const tr = $('files-table').tBodies[0].rows[i]
  if (!tr) return
  const { status, values } = cells(i)
  values.forEach((v, k) => { if (tr.cells[k].textContent !== v) tr.cells[k].textContent = v })
  tr.cells[0].title = state.sources[i].name
  tr.cells[2].className = `status ${status}`
  tr.classList.toggle('has-error', status === 'error')
  tr.setAttribute('aria-selected', String(i === state.selected))
}

function markDirty(i) {
  state.dirty.add(i)
  if (state.painting) return
  state.painting = true
  requestAnimationFrame(() => {
    state.painting = false
    for (const k of state.dirty) updateRow(k)
    state.dirty.clear()
    setProgress(totalProgress())
  })
}

function select(i) {
  const before = state.selected
  state.selected = i
  if (before >= 0) updateRow(before)
  updateRow(i)
  paintDetail()
}

function describeTarget(r) {
  const info = r.targetInfo
  if (!info) return ''
  let path = info.output.path
  if (info.parts) path = `${E.partsFolder(info.output).path}/  (${t('parts_count', { n: info.parts })})`
  if (info.mode === 'download') return t('target_download', { path })
  return `${info.output.root?.name || ''}/${path}`
}

function paintDetail() {
  const d = $('detail')
  const i = state.selected
  if (i < 0 || !state.sources[i]) {
    const p = document.createElement('p')
    p.textContent = t('detail_placeholder')
    d.replaceChildren(p)
    return
  }
  const s = state.sources[i]
  const r = state.results.get(i)
  const dl = document.createElement('dl')
  const pair = (dt, dd, cls) => {
    const a = document.createElement('dt'); a.textContent = dt
    const b = document.createElement('dd'); b.textContent = dd
    if (cls) b.className = cls
    dl.append(a, b)
  }
  pair(t('detail_source'), `${s.name} (${fmtBytes(s.file.size)})`)
  if (r?.targetInfo && (r.status === 'ok' || r.status === 'skipped')) pair(t('detail_target'), describeTarget(r))
  if (r?.format && r.format.key !== 'fmt_csv') {
    pair(t('detail_read_as'), `${r.format}, ${E.encodingName(r.encoding)}`)
  } else if (r?.separator) {
    pair(t('detail_read_with'), t('detail_csv_reading', {
      separator: E.separatorName(r.separator), encoding: E.encodingName(r.encoding),
      decimal: t(r.decimal === ',' ? 'dec_name_comma' : 'dec_name_point'),
    }))
  }
  if (r?.kinds) pair(t('detail_types'), r.kinds.map(k => t(E.TYPE_KEYS[k])).join(', '))
  const message = r ? E.resultMessage(r) : ''
  if (message) pair(t(r.status === 'ok' ? 'detail_note' : 'detail_reason'), message, r.status === 'error' ? 'error' : 'warning')
  d.replaceChildren(dl)
}

// --------------------------------------------------------------------------
//  Preview
// --------------------------------------------------------------------------
function paintPreviewSelector() {
  const sel = $('preview-file')
  sel.replaceChildren(...state.sources.map((s, i) => new Option(s.name, String(i))))
  sel.disabled = !state.sources.length
}

let previewTimer = null
function schedulePreview() {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(loadPreview, 250)
}

function formatValue(v, kind) {
  if (v === null || v === undefined) return ''
  if (kind === 'date' && typeof v === 'number') return new Date(v * 86400000).toISOString().slice(0, 10)
  if (kind === 'timestamp' && typeof v === 'bigint') {
    const s = new Date(Number(v)).toISOString().replace('T', ' ').replace('Z', '')
    return s.endsWith('.000') ? s.slice(0, -4) : s
  }
  const s = String(v).replace(/\r?\n/g, ' ↵ ')
  return s.length > 200 ? s.slice(0, 199) + '…' : s
}

async function loadPreview() {
  const i = Number($('preview-file').value)
  const s = state.sources[i]
  if (!s) return
  const token = ++state.previewToken
  $('detected').textContent = t('preview_reading')
  try {
    const pv = await E.preview(s.file, engineOptions())
    if (token !== state.previewToken) return
    showPreview({ data: pv })
  } catch (e) {
    if (token !== state.previewToken) return
    showPreview({ error: new Msg('preview_error_web', { error: E.errorMessage(e) }) })
  }
}

function showPreview(p) {
  state.preview = p
  paintPreview()
}

function paintPreview() {
  const p = state.preview
  if (!p) return
  if (!p.data) {
    $('data-table').tHead.replaceChildren()
    $('data-table').tBodies[0].replaceChildren()
    $('schema').replaceChildren()
    $('note-types').hidden = true
    $('note-json').hidden = true
    $('detected').replaceChildren()
    const v = $('preview-empty')
    const div = document.createElement('div')
    div.textContent = String(p.error || p.empty)
    if (p.error) div.className = 'preview-error'
    v.replaceChildren(div)
    v.hidden = false
    return
  }
  const pv = p.data
  $('preview-empty').hidden = true
  const thead = $('data-table').tHead
  const tr = document.createElement('tr')
  const numeric = j => pv.kinds[j] === 'int' || pv.kinds[j] === 'float'
  pv.names.forEach((n, j) => {
    const th = document.createElement('th')
    th.textContent = n
    if (numeric(j)) th.className = 'num'
    tr.appendChild(th)
  })
  thead.replaceChildren(tr)
  const frag = document.createDocumentFragment()
  for (const row of pv.values) {
    const r = document.createElement('tr')
    row.forEach((v, j) => {
      const td = document.createElement('td')
      const text = formatValue(v, pv.kinds[j])
      td.textContent = text
      if (numeric(j)) td.className = 'num'
      if (text.length > 30) td.title = String(v)
      r.appendChild(td)
    })
    frag.appendChild(r)
  }
  $('data-table').tBodies[0].replaceChildren(frag)
  $('schema').replaceChildren(...pv.names.map((n, j) => {
    const li = document.createElement('li')
    const a = document.createElement('span'); a.className = 'name'; a.textContent = n
    const b = document.createElement('span'); b.className = `chip ${pv.kinds[j]}`; b.textContent = t(E.TYPE_KEYS[pv.kinds[j]])
    const c = document.createElement('span'); c.className = 'physical'; c.textContent = E.PARQUET_TYPES[pv.kinds[j]]
    li.append(a, b, c)
    return li
  }))
  $('note-types').hidden = false
  $('note-json').hidden = pv.kind !== 'json'
  const shown = t('rows_count', { n: pv.values.length })
  const info = pv.kind === 'json' ? [
    [t('lbl_format'), String(pv.description)],
    [t('lbl_encoding'), E.encodingName(pv.encoding)],
    [t('lbl_columns'), String(pv.names.length)],
    [t('lbl_showing'), shown],
  ] : [
    [t('lbl_separator'), String(E.separatorName(pv.separator))],
    [t('lbl_encoding'), E.encodingName(pv.encoding)],
    [t('lbl_decimal'), t(pv.decimal === ',' ? 'dec_name_comma' : 'dec_name_point')],
    [t('lbl_columns'), String(pv.names.length)],
    [t('lbl_showing'), shown],
  ]
  $('detected').replaceChildren(...info.map(([k, v]) => {
    const s = document.createElement('span')
    const b = document.createElement('b')
    b.textContent = v
    s.append(`${k}: `, b)
    return s
  }))
}

// --------------------------------------------------------------------------
//  Log and status
// --------------------------------------------------------------------------
function log(msg, level = 'info') {
  const entry = { time: new Date(), msg, level }
  state.logEntries.push(entry)
  appendLog(entry)
}

function appendLog(entry) {
  const pre = $('log')
  const time = document.createElement('span')
  time.className = 'time'
  time.textContent = entry.time.toLocaleTimeString(getLanguage(), { hour12: false }) + '  '
  const text = document.createElement('span')
  text.className = entry.level
  text.textContent = String(entry.msg) + '\n'
  pre.append(time, text)
  const box = pre.parentElement
  box.scrollTop = box.scrollHeight
}

function paintLog() {
  $('log').replaceChildren()
  for (const e of state.logEntries) appendLog(e)
}

function setStatus(msg) {
  state.status = msg
  paintStatus()
}

function paintStatus() {
  const text = String(state.status)
  $('status').textContent = text
  $('status').title = text
}

function setProgress(f) {
  const p = Math.max(0, Math.min(1, f))
  $('progress').firstElementChild.style.width = `${(p * 100).toFixed(1)}%`
  $('progress').setAttribute('aria-valuenow', String(Math.round(p * 100)))
}

function totalProgress() {
  let total = 0
  let done = 0
  state.sources.forEach((s, i) => {
    const weight = Math.max(s.file.size, 4096)
    total += weight
    done += weight * (state.fraction[i] || 0)
  })
  return total ? done / total : 0
}

function paintResultBox() {
  const box = $('result')
  const r = state.resultBox
  if (!r) { box.hidden = true; return }
  box.classList.toggle('has-errors', r.errors)
  box.classList.toggle('cancelled', r.cancelled && !r.errors)
  $('result-text').textContent = String(r.text)
  $('btn-download-again').hidden = !state.lastDownload
  box.hidden = false
}

// --------------------------------------------------------------------------
//  Targets: a folder on this computer or a download
// --------------------------------------------------------------------------
async function chooseTarget() {
  try {
    const h = await window.showDirectoryPicker({ id: 'csv-target', mode: 'readwrite' })
    state.targetHandle = h
    $('target-folder').textContent = h.name
    $('target-folder').removeAttribute('data-i18n')
    $('target-folder').classList.add('chosen')
    setRadio('target', 'folder')
    updateControls()
    return true
  } catch (e) {
    if (e.name !== 'AbortError') {
      const msg = new Msg('dst_folder_failed', { error: E.errorMessage(e) })
      log(msg, 'error')
      setStatus(msg)
    }
    return false
  }
}

async function askPermission(h) {
  try {
    if (await h.queryPermission({ mode: 'readwrite' }) === 'granted') return true
    return await h.requestPermission({ mode: 'readwrite' }) === 'granted'
  } catch {
    return false
  }
}

function splitFilePath(path) {
  const parts = path.split('/').filter(Boolean)
  return { dirs: parts.slice(0, -1), name: parts.at(-1) }
}

function createFolderTarget() {
  async function folder(root, dirs, create) {
    let d = root
    for (const p of dirs) d = await d.getDirectoryHandle(p, { create })
    return d
  }
  return {
    async exists(o) {
      const { dirs, name } = splitFilePath(o.path)
      try {
        const d = await folder(o.root, dirs, false)
        await d.getFileHandle(name)
        return true
      } catch (e) {
        if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') return false
        throw e
      }
    },
    async list(o) {
      try {
        const d = await folder(o.root, o.path.split('/').filter(Boolean), false)
        const names = []
        for await (const [n, h] of d.entries()) if (h.kind === 'file') names.push(n)
        return names
      } catch (e) {
        if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') return []
        throw e
      }
    },
    async remove(o) {
      const { dirs, name } = splitFilePath(o.path)
      const d = await folder(o.root, dirs, false)
      await d.removeEntry(name)
    },
    async open(o) {
      const { dirs, name } = splitFilePath(o.path)
      const d = await folder(o.root, dirs, true)
      let existed = true
      try { await d.getFileHandle(name) } catch { existed = false }
      const fh = await d.getFileHandle(name, { create: true })
      // createWritable writes to a temporary file and only replaces the target when closed
      const w = await fh.createWritable({ keepExistingData: false })
      let n = 0
      return {
        async write(b) { await w.write(b); n += b.length },
        async close() { await w.close(); return n },
        async abort() {
          await w.abort().catch(() => {})
          if (!existed) await d.removeEntry(name).catch(() => {})
        },
      }
    },
  }
}

// CRC-32 (needed by the .zip)
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(crc, b) {
  let c = ~crc >>> 0
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8)
  return ~c >>> 0
}

// .zip without compression (the Parquet files are already compressed)
function createZip(entries) {
  const enc = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0
  const now = new Date()
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  for (const e of entries) {
    if (e.n >= 0xFFFFFFFF || offset + e.n >= 0xFFFFFFFF) throw new E.ConversionError('err_zip_too_big')
    const name = enc.encode(e.path)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034B50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true)           // UTF-8 names
    local.setUint16(8, 0, true)                // stored (no compression)
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, e.crc, true)
    local.setUint32(18, e.n, true)
    local.setUint32(22, e.n, true)
    local.setUint16(26, name.length, true)
    local.setUint16(28, 0, true)
    parts.push(local.buffer, name, e.blob)
    const c = new DataView(new ArrayBuffer(46))
    c.setUint32(0, 0x02014B50, true)
    c.setUint16(4, 20, true)
    c.setUint16(6, 20, true)
    c.setUint16(8, 0x0800, true)
    c.setUint16(10, 0, true)
    c.setUint16(12, time, true)
    c.setUint16(14, date, true)
    c.setUint32(16, e.crc, true)
    c.setUint32(20, e.n, true)
    c.setUint32(24, e.n, true)
    c.setUint16(28, name.length, true)
    c.setUint32(42, offset, true)
    central.push(c.buffer, name)
    offset += 30 + name.length + e.n
  }
  const centralSize = central.reduce((a, b) => a + b.byteLength, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054B50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' })
}

function download(blob, name) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function createDownloadTarget(zipName) {
  const outputs = []
  return {
    async exists() { return false },
    async list() { return [] },
    async remove(o) {
      const k = outputs.findIndex(x => x.path === o.path)
      if (k >= 0) outputs.splice(k, 1)
    },
    async open(o) {
      const parts = []
      let n = 0
      let crc = 0
      return {
        async write(b) { parts.push(new Blob([b])); n += b.length; crc = crc32(crc, b) },
        async close() {
          outputs.push({ path: o.path, blob: new Blob(parts, { type: 'application/vnd.apache.parquet' }), n, crc })
          return n
        },
        async abort() { parts.length = 0 },
      }
    },
    async finish(_results, notify) {
      if (!outputs.length) return
      let blob
      let name
      if (outputs.length === 1) {
        blob = outputs[0].blob
        name = splitFilePath(outputs[0].path).name
      } else {
        blob = createZip(outputs)
        name = zipName
      }
      state.lastDownload = { blob, name }
      download(blob, name)
      notify('log', outputs.length > 1
        ? new Msg('log_download_many', { name, size: blob.size, n: outputs.length })
        : new Msg('log_download', { name, size: blob.size }), 'ok')
    },
  }
}

// --------------------------------------------------------------------------
//  Conversion
// --------------------------------------------------------------------------
function dirOf(path) {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(0, i + 1) : ''
}

async function convert() {
  if (state.busy || !state.sources.length) return
  const mode = targetMode()
  // First what needs the user's gesture (picker and permissions)
  if ($('opt-split').checked && !splitValue()) {
    setStatus(new Msg('dlg_split_value'))
    $('opt-split-value').focus()
    return
  }
  if (mode === 'folder') {
    if (!state.targetHandle && !(await chooseTarget())) return
    if (!(await askPermission(state.targetHandle))) {
      setStatus(new Msg('err_no_permission_dest'))
      return
    }
  } else if (mode === 'next-to') {
    for (const r of new Set(state.sources.map(s => s.rootHandle))) {
      if (!(await askPermission(r))) {
        setStatus(new Msg('err_no_permission_root', { name: r.name }))
        return
      }
    }
  }
  const op = engineOptions()
  const keepStructure = $('opt-structure').checked
  saveOptions()

  const outputOf = s => {
    const name = E.baseName(s.file.name) + '.parquet'
    if (mode === 'next-to') return { root: s.rootHandle, path: dirOf(s.relPath) + name }
    return { root: state.targetHandle, path: (keepStructure ? dirOf(s.name) : '') + name }
  }
  if (op.combine) {
    op.combinedOutput = mode === 'next-to'
      ? { root: state.sources[0].rootHandle, path: op.combinedName }
      : { root: state.targetHandle, path: op.combinedName }
  }

  // Prepare the table and detect repeated output names
  state.results.clear()
  state.fraction = state.sources.map(() => 0)
  state.phase = state.sources.map(() => null)
  const jobs = []
  const indexes = []
  const seen = new Map()
  const rootIds = new Map()
  state.sources.forEach((s, i) => {
    const output = outputOf(s)
    if (!op.combine) {
      if (!rootIds.has(output.root)) rootIds.set(output.root, rootIds.size)
      const key = `${rootIds.get(output.root)}|${output.path.toLowerCase()}`
      if (seen.has(key)) {
        state.results.set(i, {
          status: 'error', rows: 0, seconds: 0, sourceBytes: s.file.size,
          messages: [new Msg('err_same_output', { other: seen.get(key) })],
        })
        state.fraction[i] = 1
        return
      }
      seen.set(key, s.name)
    }
    indexes.push(i)
    jobs.push({ file: s.file, name: s.name, output })
  })
  paintTable()

  state.busy = true
  state.cancel = { cancelled: false }
  state.lastDownload = null
  state.started = performance.now()
  state.resultBox = null
  paintResultBox()
  updateControls()
  activateTab('tab-files')
  const modeMsg = op.combine ? new Msg('mode_combining', { name: op.combinedName }) : new Msg('mode_per_file')
  const splitMsg = op.split
    ? new Msg('mode_split', { value: String(op.split.value), unit: new Msg(op.split.mode === 'mb' ? 'split_mb_short' : 'split_rows') })
    : ''
  log(new Msg('log_start', { n: jobs.length, compression: op.compression.toLowerCase(), mode: modeMsg, split: splitMsg }))

  const roots = new Set(state.sources.map(s => s.root).filter(Boolean))
  const zipName = `${roots.size === 1 ? [...roots][0] : 'csv'}_parquet.zip`
  const target = mode === 'download' ? createDownloadTarget(zipName) : createFolderTarget()

  const notify = (event, ...d) => {
    if (event === 'state') {
      const i = indexes[d[0]]
      state.fraction[i] = d[2]
      state.phase[i] = d[1]
      const key = `${d[0]}|${d[1]}`
      if (key !== state.lastStatus) {
        state.lastStatus = key
        setStatus(new Msg('bar_phase', { phase: new Msg(`phase_${d[1]}`), i: d[0] + 1, n: jobs.length, name: state.sources[i].name }))
      }
      markDirty(i)
    } else if (event === 'done') {
      const i = indexes[d[0]]
      const r = d[1]
      r.targetInfo = r.combined
        ? { output: op.combinedOutput, mode, parts: 0 }
        : { output: r.output || jobs[d[0]].output, mode, parts: r.parts }
      state.results.set(i, r)
      state.phase[i] = null
      state.fraction[i] = r.status === 'cancelled' ? state.fraction[i] : 1
      markDirty(i)
      if (i === state.selected) paintDetail()
      if (r.status === 'ok' && !r.combined) {
        log(new Msg('log_ok_web', {
          name: r.name, n: r.rows, parts: r.parts ? new Msg('parts_suffix', { n: r.parts }) : '', seconds: r.seconds,
        }), 'ok')
        for (const m of r.messages) log(new Msg('log_note', { message: m }), 'warning')
      } else if (r.status === 'ok') {
        log(new Msg('log_ok_added', { name: r.name, n: r.rows }), 'ok')
        for (const m of r.messages) log(new Msg('log_note', { message: m }), 'warning')
      } else if (r.status === 'skipped') {
        log(new Msg('log_skipped', { name: r.name, message: r.messages[0] || '' }), 'warning')
      } else if (r.status === 'error') {
        log(new Msg('log_error', { name: r.name, message: r.messages[0] || '' }), 'error')
      }
    } else if (event === 'log') {
      log(d[0], d[1])
    }
  }

  let results = []
  try {
    results = await E.convertBatch(jobs, op, target, notify, state.cancel)
  } catch (e) {
    log(new Msg('log_unexpected', { error: E.errorMessage(e) }), 'error')
  }
  finish(results, op, mode)
}

function finish(results, op, mode) {
  const cancelled = !!state.cancel?.cancelled
  state.busy = false
  state.runs++
  const duration = (performance.now() - state.started) / 1000
  state.sources.forEach((_, i) => {
    if (!state.results.has(i)) {
      state.results.set(i, { status: 'cancelled', messages: [new Msg('cancelled_by_user')], rows: 0, seconds: 0 })
    }
    state.phase[i] = null
  })
  const all = [...state.results.values()]
  const ok = all.filter(r => r.status === 'ok')
  const errors = all.filter(r => r.status === 'error')
  const skipped = all.filter(r => r.status === 'skipped')
  const srcBytes = ok.reduce((a, r) => a + (r.sourceBytes || 0), 0)
  const pqBytes = op.combine ? (results.combined?.bytes || 0) : ok.reduce((a, r) => a + (r.parquetBytes || 0), 0)
  const summary = new Msg('summary', {
    ok: new Msg('sum_ok', { n: ok.length }),
    errors: errors.length ? new Msg('sum_errors', { n: errors.length }) : '',
    skipped: skipped.length ? new Msg('sum_skipped', { n: skipped.length }) : '',
  })
  let sizes = ''
  if (ok.length && pqBytes) {
    const change = Math.round((1 - pqBytes / Math.max(srcBytes, 1)) * 100)
    sizes = new Msg('sizes_suffix', {
      sizes: new Msg(change >= 0 ? 'sizes_smaller' : 'sizes_larger', { src_size: srcBytes, pq_size: pqBytes, pct: Math.abs(change) }),
    })
  }
  const line = new Msg(cancelled ? 'run_cancelled' : 'run_finished', { summary, seconds: duration, sizes })
  setStatus(line)
  setProgress(cancelled ? 0 : 1)
  log(line, errors.length ? 'error' : cancelled ? 'warning' : 'ok')

  const parts = [new Msg('sentence', { text: line })]
  if (!cancelled && ok.length) {
    if (mode === 'download') parts.push(new Msg('result_downloaded'))
    else if (mode === 'folder') parts.push(new Msg('result_saved_folder', { name: state.targetHandle?.name || '' }))
    else parts.push(new Msg('result_saved_next_to'))
  }
  if (errors.length) parts.push(new Msg('result_errors_hint'))
  state.resultBox = { text: new MsgList(parts, ' '), errors: errors.length > 0, cancelled }
  paintResultBox()
  paintTable()
  updateControls()
}

// --------------------------------------------------------------------------
//  Report
// --------------------------------------------------------------------------
function exportReport() {
  if (!state.results.size) {
    log(new Msg('dlg_no_results'), 'warning')
    activateTab('tab-log')
    return
  }
  // Spanish Excel expects ";" and decimal comma; English, "," and decimal point
  const spanish = getLanguage() === 'es'
  const sep = spanish ? ';' : ','
  const header = ['source', 'target', 'status', 'message', 'rows', 'columns', 'source_bytes', 'parquet_bytes', 'parts',
    'seconds', 'format', 'separator', 'encoding', 'decimal', 'skipped_rows']
  const esc = v => {
    const s = String(v ?? '')
    return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [header.join(sep)]
  state.sources.forEach((s, i) => {
    const r = state.results.get(i)
    if (!r) return
    const seconds = (r.seconds || 0).toFixed(2)
    lines.push([s.name, describeTarget(r), r.status, E.resultMessage(r), r.rows, r.columns, s.file.size, r.parquetBytes,
      r.parts, spanish ? seconds.replace('.', ',') : seconds, r.format ? String(r.format) : '', r.separator,
      r.encoding, r.decimal, r.skippedRows].map(esc).join(sep))
  })
  download(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }), t('report_file_name'))
}

// --------------------------------------------------------------------------
//  Tabs
// --------------------------------------------------------------------------
const TABS = ['tab-files', 'tab-preview', 'tab-log']

function activateTab(id) {
  for (const tabId of TABS) {
    const b = $(tabId)
    const active = tabId === id
    b.setAttribute('aria-selected', String(active))
    b.tabIndex = active ? 0 : -1
    $(b.getAttribute('aria-controls')).classList.toggle('active', active)
  }
}

// --------------------------------------------------------------------------
//  Events
// --------------------------------------------------------------------------
function start() {
  setLanguage(readStoredLanguage() || detectLanguage())
  initOptions()
  applyLanguage()

  for (const b of document.querySelectorAll('.languages button')) {
    b.addEventListener('click', () => switchLanguage(b.dataset.lang))
  }
  $('btn-files').addEventListener('click', () => $('input-files').click())
  $('btn-folder').addEventListener('click', chooseSourceFolder)
  $('input-files').addEventListener('change', e => {
    const files = [...e.target.files]
    if (files.length) setItems(fromFileList(files), files.map(f => f.name))
    e.target.value = ''
  })
  $('input-folder').addEventListener('change', e => {
    const files = [...e.target.files]
    if (files.length) setItems(fromFileList(files), [files[0].webkitRelativePath.split('/')[0]])
    e.target.value = ''
  })
  const zone = $('drop-zone')
  zone.addEventListener('click', () => { if (!state.busy) chooseSourceFolder() })
  zone.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && !state.busy) { e.preventDefault(); chooseSourceFolder() }
  })
  let dragDepth = 0
  document.addEventListener('dragenter', e => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return
    dragDepth++
    zone.classList.add('dragover')
  })
  document.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (!dragDepth) zone.classList.remove('dragover')
  })
  document.addEventListener('dragover', e => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = state.busy ? 'none' : 'copy'
  })
  document.addEventListener('drop', e => { dragDepth = 0; onDrop(e) })

  $('opt-subfolders').addEventListener('change', () => { updateSources(); saveOptions() })
  $('btn-target').addEventListener('click', chooseTarget)
  for (const r of document.querySelectorAll('input[name="target"], input[name="output"]')) {
    r.addEventListener('change', () => { updateControls(); saveOptions() })
  }
  for (const id of ['opt-structure', 'opt-overwrite', 'opt-compression', 'opt-source-col', 'opt-combined-name', 'opt-split-value']) {
    $(id).addEventListener('change', saveOptions)
  }
  $('opt-split').addEventListener('change', () => { updateControls(); saveOptions() })
  $('opt-split-unit').addEventListener('change', () => {
    // when the unit changes, propose a sensible value if it had not been edited
    const v = $('opt-split-value').value.trim()
    if ($('opt-split-unit').value === 'mb' && (v === '' || v === '1000000')) $('opt-split-value').value = '128'
    if ($('opt-split-unit').value === 'rows' && (v === '' || v === '128')) $('opt-split-value').value = '1000000'
    saveOptions()
  })
  for (const id of ['opt-sep', 'opt-enc', 'opt-dec', 'opt-header', 'opt-dmy', 'opt-all-text', 'opt-skip-bad']) {
    $(id).addEventListener('change', () => { schedulePreview(); saveOptions() })
  }
  $('preview-file').addEventListener('change', loadPreview)

  const tbody = $('files-table').tBodies[0]
  tbody.addEventListener('click', e => {
    const tr = e.target.closest('tr')
    if (tr) select(Number(tr.dataset.i))
  })
  tbody.addEventListener('dblclick', e => {
    const tr = e.target.closest('tr')
    if (!tr) return
    $('preview-file').value = tr.dataset.i
    loadPreview()
    activateTab('tab-preview')
  })
  $('files-table').addEventListener('keydown', e => {
    if (!state.sources.length || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
    e.preventDefault()
    const i = Math.max(0, Math.min(state.sources.length - 1, state.selected + (e.key === 'ArrowDown' ? 1 : -1)))
    select(i)
    tbody.rows[i]?.scrollIntoView({ block: 'nearest' })
  })
  $('files-table').tabIndex = 0

  for (const id of TABS) {
    $(id).addEventListener('click', () => activateTab(id))
    $(id).addEventListener('keydown', e => {
      const k = TABS.indexOf(id)
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const next = TABS[(k + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]
        activateTab(next)
        $(next).focus()
      }
    })
  }

  $('btn-convert').addEventListener('click', convert)
  $('btn-cancel').addEventListener('click', () => {
    if (!state.busy) return
    state.cancel.cancelled = true
    setStatus(new Msg('bar_cancelling'))
    $('btn-cancel').disabled = true
  })
  $('btn-download-again').addEventListener('click', () => {
    if (state.lastDownload) download(state.lastDownload.blob, state.lastDownload.name)
  })
  $('btn-clear').addEventListener('click', () => { state.logEntries = []; paintLog() })
  $('btn-report').addEventListener('click', exportReport)
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) convert()
  })
  window.addEventListener('beforeunload', e => {
    if (state.busy) { e.preventDefault(); e.returnValue = '' }
  })

  updateControls()
  if (!CAN_PICK_FOLDER) log(new Msg('log_download_only'), 'warning')
}

start()
// for the automated tests
window.__csvToParquet = { state, setItems, fromFileList, convert, createZip, switchLanguage, LANGUAGES }
