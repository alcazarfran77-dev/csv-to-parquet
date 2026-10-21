// Builds a single self-contained HTML file (no external dependencies) in dist/.
import { build } from 'esbuild'
import fs from 'node:fs'

const result = await build({
  entryPoints: ['src/app.js'],
  bundle: true,
  format: 'iife',
  target: ['chrome105', 'edge105', 'firefox115', 'safari16'],
  write: false,
  charset: 'utf8',
  minify: process.argv.includes('--min'),
  legalComments: 'inline',
  banner: {
    js: '/* CSV to Parquet (browser version) - MIT License. ' +
      'Includes hyparquet-writer and hyparquet (MIT, Hyperparam) and fflate (MIT, Arjun Barrett). */',
  },
})
let js = result.outputFiles[0].text
js = js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')
const html = fs.readFileSync('src/index.html', 'utf8').replace('/*__APP__*/', () => js)
fs.mkdirSync('dist', { recursive: true })
fs.writeFileSync('dist/csv-to-parquet.html', html)
console.log('dist/csv-to-parquet.html', (html.length / 1024).toFixed(0), 'KB')
