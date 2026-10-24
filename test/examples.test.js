import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { cardWarnings, inspectCard, measure, renderCard } from '../src/cards.js'

const examples = join(dirname(fileURLToPath(import.meta.url)), '..', 'example_cards')

test('every example card is valid, renders, and stays within the rule advisories', () => {
  const files = readdirSync(examples).filter(name => name.endsWith('.dshcd'))
  assert.ok(files.length > 0, 'example_cards must contain at least one card')

  for (const file of files) {
    const card = JSON.parse(readFileSync(join(examples, file), 'utf8'))
    const inspected = inspectCard(card)
    assert.equal('error' in inspected, false, `${file}: ${inspected.error}`)
    assert.equal(card.id, file.slice(0, -'.dshcd'.length), `${file}: id must match the filename`)

    const rendered = renderCard(card)
    assert.ok(rendered.length > 0, `${file}: renders empty`)
    assert.ok(measure(rendered).tokens > 0, `${file}: zero tokens`)
    assert.deepEqual(cardWarnings(card), [], `${file}: ${JSON.stringify(cardWarnings(card))}`)
  }
})
