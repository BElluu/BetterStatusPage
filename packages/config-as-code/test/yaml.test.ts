import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parse, parseAllDocuments } from 'yaml'
import { MAX_DOCUMENTS, readDocuments, toYaml, toYamlStream } from '@better-kit/config-as-code'

describe('writing YAML', () => {
  it('quotes what an older parser would read as something else', () => {
    const text = toYaml({ merge: '<<', equals: '=', octal: '0o17', time: '22:00', yes: 'yes', plain: 'hello' })
    assert.match(text, /equals: "="/)
    assert.match(text, /octal: "0o17"/)
    assert.match(text, /time: "22:00"/)
    assert.match(text, /"yes": "yes"/)
    assert.match(text, /plain: hello/)
  })

  it('gives the same values whether it is read as YAML 1.1 or 1.2', () => {
    const value = { a: '<<', b: '=', c: '0o17', d: '22:00', e: 'on', f: 'no', g: '1e3', h: '0x1f' }
    const text = toYaml(value)
    assert.deepEqual(parse(text, { version: '1.2' }), value)
    assert.deepEqual(parse(text, { version: '1.1' }), value)
  })

  it('writes a key named << as a string', () => {
    const text = toYaml({ '<<': 'x' })
    assert.deepEqual(parse(text, { version: '1.1' }), { '<<': 'x' })
  })

  it('does not fold long lines', () => {
    const url = `https://example.test/${'a'.repeat(200)}`
    assert.ok(toYaml({ url }).includes(`url: ${url}\n`))
  })

  it('joins documents with a separator line', () => {
    const text = toYamlStream([{ a: 1 }, { b: 2 }])
    assert.equal(text, 'a: 1\n---\nb: 2\n')
    assert.deepEqual(parseAllDocuments(text).map((document) => document.toJS()), [{ a: 1 }, { b: 2 }])
    assert.equal(toYamlStream([]), '')
  })
})

describe('reading YAML', () => {
  it('reads several documents in order and leaves out empty ones', () => {
    assert.deepEqual(readDocuments('a: 1\n---\n---\nb: 2\n---\nnull\n'), { documents: [{ a: 1 }, { b: 2 }] })
    assert.deepEqual(readDocuments(''), { documents: [] })
  })

  it('reads YAML 1.2 values, so 22:00 is text and yes is text', () => {
    assert.deepEqual(readDocuments('a: 22:00\nb: yes\n'), { documents: [{ a: '22:00', b: 'yes' }] })
  })

  it('asks for text, and refuses a %YAML directive', () => {
    assert.deepEqual(readDocuments({ a: 1 }), { error: 'Send the documents as YAML' })
    assert.deepEqual(readDocuments('%YAML 1.1\n---\na: 1\n'), { error: 'Invalid YAML: %YAML directives are not supported' })
  })

  it('reports a syntax error, clipped, with its position', () => {
    const result = readDocuments('a: [1')
    assert.ok('error' in result && result.error.startsWith('Invalid YAML: '))
    const long = readDocuments(`a: [${'x'.repeat(2000)}`)
    assert.ok('error' in long && long.error.length <= 'Invalid YAML: '.length + 400)
  })

  it('refuses more than twenty aliases and an alias that contains itself', () => {
    const many = `base: &b {x: 1}\n${Array.from({ length: 25 }, (_, i) => `k${i}: *b`).join('\n')}\n`
    const tooMany = readDocuments(many)
    assert.ok('error' in tooMany && tooMany.error.startsWith('Invalid YAML'))
    assert.deepEqual(readDocuments('a: &x {b: *x}\n'), { error: 'Invalid YAML: an alias may not refer to a value that contains it' })
    assert.ok('documents' in readDocuments('base: &b {x: 1}\nk: *b\n'))
  })

  it('refuses more documents than the limit', () => {
    const text = Array.from({ length: MAX_DOCUMENTS + 1 }, (_, i) => `n: ${i}`).join('\n---\n')
    assert.deepEqual(readDocuments(text), { error: `Too many documents: at most ${MAX_DOCUMENTS}` })
    assert.ok('documents' in readDocuments(Array.from({ length: MAX_DOCUMENTS }, (_, i) => `n: ${i}`).join('\n---\n')))
  })
})
