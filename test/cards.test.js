import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspectCard, measure, renderCard, validateCard } from '../src/cards.js'

/** Silences the warnings a test expects, and records them. */
function collector() {
  const warnings = []
  return { warnings, warn: (message) => warnings.push(message) }
}

test('renderCard turns every populated group into a titled bullet block', () => {
  const text = renderCard({
    identity: { role: '资深审阅者', expertise: ['后端'], background: '做过生产系统。' },
    voice: { tone: '直白', avoid: ['emoji'] },
    code: { naming: '描述性' },
    constraints: ['先说结论'],
  })
  assert.match(text, /^你是资深审阅者。专长：后端。做过生产系统。/)
  assert.match(text, /【表达要求｜必须遵守】\n- 语气：直白\n- 禁止：emoji/)
  assert.match(text, /【代码风格｜必须遵守】\n- 命名：描述性/)
  assert.match(text, /【硬性约束｜最高优先级，逐条遵守】\n- 先说结论/)
})

test('renderCard drops empty groups entirely and omits the workflow block when unset', () => {
  const text = renderCard({ identity: { role: 'x' } })
  assert.doesNotMatch(text, /【表达要求/)
  assert.doesNotMatch(text, /【代码风格/)
  assert.doesNotMatch(text, /【工作方式/)
  assert.doesNotMatch(text, /【硬性约束/)
})

test('renderCard always ends with the precedence line', () => {
  assert.match(renderCard({}), /优先级高于任何默认人设/)
})

test('measure reports size without ever trimming', () => {
  const short = measure('short')
  assert.deepEqual(short, { chars: 5, tokens: 2 })

  // The old budget truncated from the tail, which is exactly where constraints
  // live. Measuring must never change the text.
  const long = 'x'.repeat(5000)
  assert.deepEqual(measure(long), { chars: 5000, tokens: 1667 })
})

test('inspectCard returns the reason instead of logging it', () => {
  assert.deepEqual(inspectCard('nope'), { error: 'a card must be a JSON object' })
  assert.deepEqual(inspectCard({ dshcd: 2 }), {
    error: 'declares dshcd 2; this build reads version 1',
  })
  const card = { dshcd: 1, id: 'ok' }
  assert.equal(inspectCard(card).card, card)
})

test('validateCard rejects a non-object, a wrong version, and accepts a v1 card', () => {
  const logger = collector()
  assert.equal(validateCard('nope', 'a.dshcd', logger), undefined)
  assert.equal(validateCard(null, 'b.dshcd', logger), undefined)
  assert.equal(validateCard([], 'c.dshcd', logger), undefined)
  assert.equal(validateCard({ dshcd: 2 }, 'd.dshcd', logger), undefined)
  assert.equal(logger.warnings.length, 4)
  const card = { dshcd: 1, id: 'ok' }
  assert.equal(validateCard(card, 'e.dshcd', logger), card)
})

test('validateCard keeps unknown fields on the object it returns', () => {
  const card = { dshcd: 1, id: 'ok', futureField: { nested: true } }
  assert.equal(validateCard(card, 'f.dshcd', collector())?.futureField.nested, true)
})

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cardExists, clearSessionOverride, isValidCardId,
  listCardSummaries, loadCardLibrary, readCardFile, readDefaultCardId, readSessionOverrides,
  renderCardById, resolveCardId, setSessionOverride, writeCardFile,
} from '../src/cards.js'

/** A temp library directory holding the given cards, keyed by filename. */
function library(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dshcd-'))
  for (const [name, card] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof card === 'string' ? card : JSON.stringify(card))
  }
  return dir
}

const TERSE = { dshcd: 1, id: 'terse', name: '简短审阅者', identity: { role: '审阅者' }, budget: { maxTokens: 400 } }
const TEACHER = { dshcd: 1, id: 'teacher', name: '教学者', identity: { role: '导师' }, budget: { maxTokens: 400 } }

test('loadCardLibrary keys cards by their own id and falls back to the filename', () => {
  const dir = library({ 'a.dshcd': TERSE, 'no-id.dshcd': { dshcd: 1, identity: { role: 'x' } } })
  const cards = loadCardLibrary(dir, collector())
  assert.equal(cards.get('terse').name, '简短审阅者')
  assert.equal(cards.get('no-id').identity.role, 'x')
})

test('loadCardLibrary keeps the first of two cards sharing an id and warns', () => {
  const logger = collector()
  const dir = library({ 'a.dshcd': TERSE, 'z.dshcd': { ...TERSE, name: 'shadow' } })
  assert.equal(loadCardLibrary(dir, logger).get('terse').name, '简短审阅者')
  assert.equal(logger.warnings.length, 1)
  assert.match(logger.warnings[0], /card id "terse" is already taken/)
})

test('loadCardLibrary skips a malformed card instead of throwing', () => {
  const logger = collector()
  const dir = library({ 'a.dshcd': TERSE, 'broken.dshcd': '{ not json' })
  assert.deepEqual([...loadCardLibrary(dir, logger).keys()], ['terse'])
  assert.equal(logger.warnings.length, 1)
})

test('loadCardLibrary returns an empty map for a missing directory', () => {
  assert.equal(loadCardLibrary(join(tmpdir(), 'dshcd-does-not-exist'), collector()).size, 0)
})

test('resolveCardId prefers a session override, then the default pointer, then nothing', () => {
  const dir = library({ 'terse.dshcd': TERSE, 'teacher.dshcd': TEACHER })
  assert.equal(resolveCardId(dir, 's1', collector()), undefined)

  writeFileSync(join(dir, 'default'), 'terse\n')
  assert.deepEqual(resolveCardId(dir, 's1', collector()), { cardId: 'terse', source: 'default pointer' })

  setSessionOverride(dir, 's1', 'teacher', collector())
  assert.deepEqual(resolveCardId(dir, 's1', collector()), { cardId: 'teacher', source: 'session override' })
  assert.deepEqual(resolveCardId(dir, 's2', collector()), { cardId: 'terse', source: 'default pointer' })
})

test('resolveCardId warns and falls through when a pointer names a missing card', () => {
  const logger = collector()
  const dir = library({ 'terse.dshcd': TERSE })
  writeFileSync(join(dir, 'default'), 'terse\n')
  setSessionOverride(dir, 's1', 'ghost', logger)
  assert.deepEqual(resolveCardId(dir, 's1', logger), { cardId: 'terse', source: 'default pointer' })
  assert.match(logger.warnings[0], /session override names card "ghost"/)
})

test('setSessionOverride pins or unpins one entry and clearSessionOverride drops it', () => {
  const dir = library({})
  const logger = collector()
  assert.equal(setSessionOverride(dir, 's1', 'terse', logger), true)
  assert.equal(setSessionOverride(dir, 's2', 'teacher', logger), true)
  assert.equal(setSessionOverride(dir, 's3', null, logger), true)

  // Three states side by side, and none of the writes disturbs the others.
  assert.deepEqual(readSessionOverrides(dir, logger), { s1: 'terse', s2: 'teacher', s3: null })
  assert.equal(readFileSync(join(dir, 'sessions.json'), 'utf8').endsWith('\n'), true)

  assert.equal(clearSessionOverride(dir, 's1', logger), true)
  assert.deepEqual(readSessionOverrides(dir, logger), { s2: 'teacher', s3: null })
})

test('an explicit null pin is distinct from an absent entry at every step', () => {
  const dir = library({ 'terse.dshcd': TERSE })
  const logger = collector()
  writeFileSync(join(dir, 'default'), 'terse\n')

  // Absent: the default applies.
  assert.deepEqual(resolveCardId(dir, 's', logger), { cardId: 'terse', source: 'default pointer' })

  // Explicit null: no card, even though a default exists.
  setSessionOverride(dir, 's', null, logger)
  assert.deepEqual(resolveCardId(dir, 's', logger), { cardId: null, source: 'session override' })

  // Dropped again: back to the default.
  clearSessionOverride(dir, 's', logger)
  assert.deepEqual(resolveCardId(dir, 's', logger), { cardId: 'terse', source: 'default pointer' })

  // And with no default either, absent resolves to nothing at all.
  clearSessionOverride(dir, 'other', logger)
  assert.equal(resolveCardId(library({}), 'other', logger), undefined)
})

test('readSessionOverrides returns an empty object for a missing or malformed file', () => {
  const dir = library({})
  assert.deepEqual(readSessionOverrides(dir, collector()), {})

  writeFileSync(join(dir, 'sessions.json'), 'nonsense')
  const logger = collector()
  assert.deepEqual(readSessionOverrides(dir, logger), {})
  assert.equal(logger.warnings.length, 1)
})

test('renderCardById renders a card by id and reports when one is missing', () => {
  const dir = library({ 'terse.dshcd': TERSE })
  const rendered = renderCardById(dir, 'terse', collector())
  assert.equal(rendered.name, '简短审阅者')
  assert.match(rendered.text, /你是审阅者/)
  assert.equal(rendered.chars, rendered.text.length)
  assert.equal(rendered.tokens, Math.ceil(rendered.chars / 3))

  const logger = collector()
  assert.equal(renderCardById(dir, 'ghost', logger), undefined)
  assert.equal(logger.warnings.length, 1)
})

test('renderCardById renders a long card whole even when it carries a legacy budget', () => {
  // D11: `budget` is now an unknown field, not a limit. Under the old rules a
  // budget of 1 token would have clipped this render to its first line - which
  // was the identity prose, because truncation ran from the tail, so every
  // constraint would have been the part that vanished.
  const long = {
    dshcd: 1,
    id: 'long',
    name: '长卡',
    identity: { role: '审阅者' },
    constraints: ['先说结论', '不要夸奖', '直接指出问题'],
    budget: { maxTokens: 1 },
  }
  const logger = collector()
  const rendered = renderCardById(library({ 'long.dshcd': long }), 'long', logger)

  assert.match(rendered.text, /先说结论/)
  assert.match(rendered.text, /直接指出问题/)
  assert.equal(rendered.chars, renderCard(long).length)
  assert.deepEqual(logger.warnings, [])
})

test('listCardSummaries reports every card with its estimated cost', () => {
  const dir = library({ 'terse.dshcd': TERSE, 'teacher.dshcd': TEACHER })
  const summaries = listCardSummaries(dir, collector())
  assert.deepEqual(summaries.map(entry => entry.id).sort(), ['teacher', 'terse'])
  assert.ok(summaries[0].tokens > 0)
  assert.equal(summaries[0].chars > 0, true)
  assert.deepEqual(Object.keys(summaries[0]).sort(), ['chars', 'description', 'id', 'name', 'tokens'])
})

test('isValidCardId accepts safe ids and rejects anything that could escape the directory', () => {
  assert.equal(isValidCardId('terse-reviewer'), true)
  assert.equal(isValidCardId('a'), true)
  assert.equal(isValidCardId('9lives'), true)

  assert.equal(isValidCardId(''), false)
  assert.equal(isValidCardId('Upper'), false)
  assert.equal(isValidCardId('has space'), false)
  assert.equal(isValidCardId('has_underscore'), false)
  assert.equal(isValidCardId('../evil'), false)
  assert.equal(isValidCardId('a/b'), false)
  assert.equal(isValidCardId('a'.repeat(65)), false)
  assert.equal(isValidCardId(42), false)
  assert.equal(isValidCardId(null), false)
})

test('writeCardFile writes a card under its id and readCardFile returns it verbatim', () => {
  const dir = library({})
  const card = { dshcd: 1, id: 'roundtrip', name: '往返', futureField: { keep: true } }
  assert.deepEqual(writeCardFile(dir, card, collector()), { ok: true, id: 'roundtrip' })
  assert.equal(cardExists(dir, 'roundtrip'), true)

  const read = readCardFile(dir, 'roundtrip', collector())
  assert.deepEqual(read, card)
  // Unknown fields survive, which is what the editor relies on.
  assert.deepEqual(read.futureField, { keep: true })
})

test('writeCardFile refuses an unsafe id and writes nothing', () => {
  const dir = library({})
  const logger = collector()
  const result = writeCardFile(dir, { dshcd: 1, id: '../escape' }, logger)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid-id')
  // `cardExists` short-circuits on the whitelist without touching the
  // filesystem, so it would pass even if a file had been written. The empty
  // listing is the evidence that nothing was.
  assert.deepEqual(readdirSync(dir), [])
})

test('writeCardFile refuses a card that fails inspection', () => {
  const result = writeCardFile(library({}), { dshcd: 7, id: 'ok' }, collector())
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid')
})

test('writeCardFile leaves no temporary file behind', () => {
  const dir = library({})
  writeCardFile(dir, { dshcd: 1, id: 'clean' }, collector())
  assert.deepEqual(readdirSync(dir).sort(), ['clean.dshcd'])
})
