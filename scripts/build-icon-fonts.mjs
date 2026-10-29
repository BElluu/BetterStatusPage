// Cuts the Material Symbols font down to the icons the sources use, one file per product surface.
//
// The shared interface (packages/ui) lists the icons its own sources use in packages/ui/icons.json. A product builds
// its font from its sources plus that list, so an update of the package never drops an icon of the shared pages.
//
// The icons are written as names in the markup (`<span class="material-symbols-outlined">check_circle</span>`) and the
// font turns each name into one glyph (a ligature). The full font has thousands of icons; this keeps the ones whose
// name appears as a word in the surface's sources, and pins the axes the styles never vary (weight 400, grade 0,
// optical size 24).
//
//   node scripts/build-icon-fonts.mjs          rewrite the font files
//   node scripts/build-icon-fonts.mjs --check  fail when a used icon is missing from a font file
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fontverter from 'fontverter'
import * as hb from 'harfbuzzjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const source = path.join(root, 'node_modules', 'material-symbols', 'material-symbols-outlined.woff2')

// `fill` pins the FILL axis when the surface never varies it: the public page only draws outlined icons, the admin also
// fills the active one, so its font keeps the axis and the filled glyph of every icon.
const surfaces = [
  { file: 'apps/status/src/fonts/material-symbols-outlined.woff2', dirs: ['apps/status'], fill: 0 },
  { file: 'apps/admin/src/fonts/material-symbols-outlined-fill.woff2', dirs: ['apps/admin'], fill: undefined, withUiIcons: true },
  { file: 'packages/ui/styles/fonts/material-symbols-outlined-fill.woff2', dirs: ['packages/ui/src', 'apps/template'], fill: undefined },
]
const uiIconList = 'packages/ui/icons.json'
const uiSources = ['packages/ui/src']

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(dir, entry.name)
  if (entry.isDirectory()) return ['node_modules', 'dist', 'build', 'coverage'].includes(entry.name) ? [] : walk(file)
  return /\.(ts|tsx|html)$/.test(entry.name) && !/\.(test|spec)\.|\.d\.ts$/.test(entry.name) ? [file] : []
})

// Every lowercase word in the sources. Quotes are not paired to find the string literals: an apostrophe in a text or a
// comment throws the pairing off and an icon would be dropped without notice. Most words are not icons, which is
// settled by shaping, so the extra ones cost nothing but the few icons that share a name with a word.
const wordsIn = (dirs) => {
  const words = new Set()
  for (const dir of dirs) for (const file of walk(path.join(root, dir))) {
    for (const word of fs.readFileSync(file, 'utf8').match(/[a-z][a-z0-9_]*/g) ?? []) words.add(word)
  }
  return [...words]
}

const toSfnt = (woff2) => fontverter.convert(woff2, 'truetype')
const shaperOf = (sfnt) => new hb.Font(new hb.Face(new hb.Blob(new Uint8Array(sfnt))))

const glyphsOf = (font, text, fill = 0) => {
  font.setVariations([new hb.Variation('FILL', fill)])
  const buffer = new hb.Buffer()
  buffer.addText(text)
  buffer.guessSegmentProperties()
  hb.shape(font, buffer)
  return buffer.getGlyphInfos().map((info) => info.codepoint)
}

// The words of two or more letters that the font turns into a single glyph, with the glyph of each in the outlined
// (FILL 0) and filled (FILL 1) form. Not every icon has a code point, so the glyph itself is the test.
const iconsIn = (font, words) => {
  const icons = new Map()
  for (const word of words) {
    const [outlined, ...rest] = glyphsOf(font, word)
    if (word.length > 1 && rest.length === 0) icons.set(word, { outlined, filled: glyphsOf(font, word, 1)[0] })
  }
  return icons
}

const HB_TAG = (tag) => [...tag].reduce((value, char) => (value << 8) + char.charCodeAt(0), 0)
const HB_MEMORY_MODE_WRITABLE = 2
const HB_SUBSET_FLAGS_NO_LAYOUT_CLOSURE = 0x200

// Keeps exactly the given glyphs. Without layout closure the subsetter adds no ligatures beyond the ones whose letters
// and icon glyph are both kept; `glyphs` therefore holds the letters, the icon glyphs and their filled forms.
let wasm
const subset = async (sfnt, glyphs, pins) => {
  if (!wasm) {
    wasm = (await WebAssembly.instantiate(fs.readFileSync(require.resolve('harfbuzzjs/dist/harfbuzz-subset.wasm')))).instance.exports
    wasm._initialize()
  }
  const input = wasm.hb_subset_input_create_or_fail()
  wasm.hb_subset_input_set_flags(input, wasm.hb_subset_input_get_flags(input) | HB_SUBSET_FLAGS_NO_LAYOUT_CLOSURE)
  const glyphSet = wasm.hb_subset_input_glyph_set(input)
  for (const glyph of glyphs) wasm.hb_set_add(glyphSet, glyph)
  const data = wasm.malloc(sfnt.byteLength)
  new Uint8Array(wasm.memory.buffer).set(new Uint8Array(sfnt), data)
  const blob = wasm.hb_blob_create(data, sfnt.byteLength, HB_MEMORY_MODE_WRITABLE, 0, 0)
  const face = wasm.hb_face_create(blob, 0)
  wasm.hb_blob_destroy(blob)
  for (const [axis, value] of Object.entries(pins)) {
    if (!wasm.hb_subset_input_pin_axis_location(input, face, HB_TAG(axis), value)) throw new Error(`cannot pin axis ${axis}`)
  }
  const result = wasm.hb_subset_or_fail(face, input)
  wasm.hb_subset_input_destroy(input)
  if (result === 0) throw new Error('the subsetter failed')
  const out = wasm.hb_face_reference_blob(result)
  const bytes = Buffer.from(new Uint8Array(wasm.memory.buffer, wasm.hb_blob_get_data(out, 0), wasm.hb_blob_get_length(out)))
  wasm.hb_blob_destroy(out)
  wasm.hb_face_destroy(result)
  wasm.hb_face_destroy(face)
  wasm.free(data)
  return bytes
}

const check = process.argv.includes('--check')
const fullSfnt = await toSfnt(fs.readFileSync(source))
const full = shaperOf(fullSfnt)
const letters = [...'abcdefghijklmnopqrstuvwxyz0123456789_'].map((letter) => full.nominalGlyph(letter.codePointAt(0)))
let failed = false

// The icons the shared interface uses, written next to the package so that products can add them to their fonts.
const uiIcons = JSON.stringify([...iconsIn(full, wordsIn(uiSources)).keys()].sort(), null, 2) + '\n'
const uiIconFile = path.join(root, uiIconList)
if (check) {
  if (!fs.existsSync(uiIconFile) || fs.readFileSync(uiIconFile, 'utf8').replace(/\r\n/g, '\n') !== uiIcons) {
    failed = true
    console.error(`${uiIconList} is out of date; run: node scripts/build-icon-fonts.mjs`)
  }
} else {
  fs.writeFileSync(uiIconFile, uiIcons)
}

for (const surface of surfaces) {
  const words = wordsIn(surface.dirs)
  if (surface.withUiIcons) words.push(...JSON.parse(uiIcons))
  const icons = iconsIn(full, words)
  const target = path.join(root, surface.file)
  if (check) {
    const cut = shaperOf(await toSfnt(fs.readFileSync(target)))
    const missing = [...icons.keys()].filter((name) => glyphsOf(cut, name).length !== 1)
    if (missing.length > 0) {
      failed = true
      console.error(`${surface.file} lacks ${missing.join(', ')}; run: node scripts/build-icon-fonts.mjs`)
    }
    continue
  }
  const glyphs = [...letters, ...[...icons.values()].flatMap(({ outlined, filled }) => [outlined, filled])]
  const pins = { wght: 400, GRAD: 0, opsz: 24, ...(surface.fill === undefined ? {} : { FILL: surface.fill }) }
  const output = await fontverter.convert(await subset(fullSfnt, glyphs, pins), 'woff2')
  fs.writeFileSync(target, output)
  console.log(`${surface.file}: ${icons.size} icons, ${(output.length / 1024).toFixed(0)} KB`)
}
if (failed) process.exit(1)
