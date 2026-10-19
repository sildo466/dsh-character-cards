import { test } from 'node:test'
import assert from 'node:assert/strict'

let loaded
globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
}

await import('../src/client.js')

test('the client half registers under its own package id', () => {
  assert.equal(loaded.id, 'dsh-character-cards')
})

test('switcherMode picks session mode only for a non-empty sessionId', () => {
  const { switcherMode } = loaded.factory((name) => {
    assert.equal(name, 'react')
    return fakeReact
  })
  assert.equal(switcherMode({ sessionId: 'session-a' }), 'session')
  assert.equal(switcherMode({ sessionId: undefined }), 'global')
  assert.equal(switcherMode({ sessionId: '' }), 'global')
  assert.equal(switcherMode({}), 'global')
  assert.equal(switcherMode(undefined), 'global')
})

test('apply claims a settings page and survives a ctx with no slots', () => {
  const { apply } = loaded.factory(() => fakeReact)
  const registered = []
  const slots = {
    inject: (key, callback) => { assert.equal(key, 'settings.section'); callback() },
    register: (options, component) => { registered.push({ options, component }); return () => {} },
  }
  apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'settings.section')
  // The id has to be unique among sections; 'plugins' is the shipped entry.
  assert.equal(registered[0].options.id, 'character-cards')
  assert.equal(typeof registered[0].options.order, 'number')
  assert.equal(registered[0].options.label(), '角色卡')

  assert.doesNotThrow(() => apply({ get: () => undefined }))
  assert.doesNotThrow(() => apply({ get: () => { throw new Error('hostile') } }))
})

test('initialSelection shows the default in global mode and the override in session mode', () => {
  const { initialSelection } = loaded.factory(() => fakeReact)
  const cards = { defaultCard: 'terse', cards: [] }

  // Global mode carries no "follow the default" entry, so selecting '' would
  // leave the browser showing whichever option happens to be first.
  assert.equal(initialSelection('global', cards, undefined), 'terse')

  // Session mode selects the override, or '' - the "follow the default" entry -
  // even though the effective card is still reported separately.
  assert.equal(initialSelection('session', cards, { override: 'teacher', cardId: 'teacher' }), 'teacher')
  assert.equal(initialSelection('session', cards, { override: null, cardId: 'terse' }), '')

  // A host with no default set must not select an option that does not exist.
  assert.equal(initialSelection('global', { defaultCard: null, cards: [] }, undefined), '')
  assert.equal(initialSelection('global', undefined, undefined), '')
})

