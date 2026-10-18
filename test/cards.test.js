import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyBudget, renderCard, validateCard } from '../src/cards.js'

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

test('applyBudget passes a card within budget through untouched', () => {
  const logger = collector()
  const result = applyBudget('short', { budget: { maxTokens: 400 } }, 'c', logger)
  assert.equal(result.text, 'short')
  assert.equal(result.truncated, false)
  assert.equal(result.maxTokens, 400)
  assert.deepEqual(logger.warnings, [])
})

test('applyBudget truncates at a line boundary and warns rather than staying silent', () => {
  const logger = collector()
  const rendered = `${'x'.repeat(20)}\n${'y'.repeat(20)}\n${'z'.repeat(20)}`
  const result = applyBudget(rendered, { budget: { maxTokens: 10 } }, 'big', logger)
  assert.equal(result.truncated, true)
  assert.equal(result.text, 'x'.repeat(20))
  assert.equal(logger.warnings.length, 1)
  assert.match(logger.warnings[0], /card "big" renders to ~\d+ tokens, over its budget of 10/)
})

test('applyBudget falls back to the default budget when the card declares none', () => {
  const result = applyBudget('short', {}, 'c', collector())
  assert.equal(result.maxTokens, 400)
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

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listCardSummaries, loadCardLibrary, readDefaultCardId, readSessionOverrides,
  renderCardById, resolveCardId, setSessionOverride,
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

test('setSessionOverride writes and clears one entry without touching the others', () => {
  const dir = library({})
  const logger = collector()
  assert.equal(setSessionOverride(dir, 's1', 'terse', logger), true)
  assert.equal(setSessionOverride(dir, 's2', 'teacher', logger), true)
  assert.equal(setSessionOverride(dir, 's1', null, logger), true)

  assert.deepEqual(readSessionOverrides(dir, logger), { s2: 'teacher' })
  assert.equal(readFileSync(join(dir, 'sessions.json'), 'utf8').endsWith('\n'), true)
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

  const logger = collector()
  assert.equal(renderCardById(dir, 'ghost', logger), undefined)
  assert.equal(logger.warnings.length, 1)
})

test('listCardSummaries reports every card with its estimated cost', () => {
  const dir = library({ 'terse.dshcd': TERSE, 'teacher.dshcd': TEACHER })
  const summaries = listCardSummaries(dir, collector())
  assert.deepEqual(summaries.map(entry => entry.id).sort(), ['teacher', 'terse'])
  assert.equal(summaries[0].maxTokens, 400)
  assert.equal(summaries[0].truncated, false)
  assert.ok(summaries[0].tokens > 0)
})
