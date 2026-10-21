// Runs the browser engine in Node over files or folders, writing to disk.
// Used by the tests and handy for debugging:
//   node test/run-node.mjs <input> <output folder> [option=value …]
// Options are those of DEFAULT_OPTIONS (e.g. combine=true splitMode=rows splitValue=1000).
import fs from 'node:fs'
import path from 'node:path'
import { openAsBlob } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as E from '../src/engine.js'
import { setLanguage, fmtInt, fmtBytes } from '../src/i18n.js'

function listFiles(input, root = input) {
  const st = fs.statSync(input)
  if (st.isFile()) return [{ file: input, rel: path.basename(input) }]
  return fs.readdirSync(input).sort().flatMap(n => {
    const p = path.join(input, n)
    if (fs.statSync(p).isDirectory()) return listFiles(p, root)
    return E.isSupported(n) ? [{ file: p, rel: path.relative(root, p).split(path.sep).join('/') }] : []
  })
}

export function diskTarget(outDir) {
  return {
    async exists(o) { return fs.existsSync(path.join(outDir, o.path)) },
    async list(o) { const p = path.join(outDir, o.path); return fs.existsSync(p) ? fs.readdirSync(p) : [] },
    async remove(o) { fs.rmSync(path.join(outDir, o.path), { force: true }) },
    async open(o) {
      const p = path.join(outDir, o.path)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      const fh = await fs.promises.open(p + '.partial', 'w')
      let n = 0
      return {
        async write(b) { await fh.write(b); n += b.length },
        async close() { await fh.close(); fs.renameSync(p + '.partial', p); return n },
        async abort() { await fh.close(); fs.rmSync(p + '.partial', { force: true }) },
      }
    },
  }
}

export async function nodeFile(p) {
  const b = await openAsBlob(p)
  return { name: path.basename(p), size: b.size, slice: (a, c) => b.slice(a, c), stream: () => b.stream() }
}

export async function convertPath(input, outDir, options = {}, notify = () => {}, cancel = {}) {
  const op = { ...E.DEFAULT_OPTIONS, overwrite: true, ...options }
  const sources = []
  for (const { file, rel } of listFiles(input)) {
    const dir = path.posix.dirname(rel)
    sources.push({
      file: await nodeFile(file), name: rel,
      output: { path: (dir === '.' ? '' : dir + '/') + E.baseName(path.basename(rel)) + '.parquet' },
    })
  }
  if (op.combine) op.combinedOutput = { path: op.combinedName }
  return E.convertBatch(sources, op, diskTarget(outDir), notify, cancel)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , input, outDir, ...flags] = process.argv
  const options = {}
  for (const f of flags) {
    const [k, v] = f.split('=')
    options[k] = v === 'true' ? true : v === 'false' ? false : v
  }
  if (options.splitMode) options.split = { mode: options.splitMode, value: Number(options.splitValue) }
  setLanguage(options.lang || 'en')
  const t0 = performance.now()
  const results = await convertPath(input, outDir, options, (ev, ...d) => {
    if (ev === 'log') console.log('LOG', d[1], String(d[0]))
  })
  for (const r of results) {
    console.log(`[${r.status.toUpperCase().padEnd(9)}] ${r.name} -> ${fmtInt(r.rows)} rows ${r.columns} cols ` +
      `${fmtBytes(r.parquetBytes)}${r.parts ? ` in ${r.parts} parts` : ''} ${r.seconds.toFixed(1)}s ` +
      `${r.format ? String(r.format) : ''}/${r.separator}/${r.encoding}/${r.decimal} ${r.kinds ? r.kinds.join(',') : ''} ${E.resultMessage(r)}`)
  }
  console.log('total s', ((performance.now() - t0) / 1000).toFixed(1), 'peak RAM MB', Math.round(process.resourceUsage().maxRSS / 1024))
}
