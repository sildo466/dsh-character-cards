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

test('apply claims the settings page and the composer tool row', () => {
  const { apply } = loaded.factory(() => fakeReact)
  const injected = []
  const registered = []
  const slots = {
    inject: (key, callback) => { injected.push(key); callback() },
    register: (options, component) => { registered.push({ options, component }); return () => {} },
  }
  apply({ get: (name) => (name === 'slots' ? slots : undefined) })

  assert.deepEqual(injected, ['settings.section', 'conversation.input.left'])
  assert.equal(registered.length, 2)

  const [settings, composer] = registered
  assert.equal(settings.options.name, 'settings.section')
  // The id has to be unique among sections; 'plugins' and 'agent-presets' are
  // shipped entries in the same list.
  assert.equal(settings.options.id, 'character-cards')
  assert.equal(typeof settings.options.order, 'number')
  assert.equal(settings.options.label(), '角色卡')

  assert.equal(composer.options.name, 'conversation.input.left')
  // A list slot accepts id / order / label - not the `key` or `priority` a
  // keyed or single slot would take.
  assert.deepEqual(Object.keys(composer.options).sort(), ['id', 'name', 'order'])
  assert.equal(composer.options.id, 'character-cards')

  assert.equal(typeof settings.component, 'function')
  assert.equal(typeof composer.component, 'function')
  // The two surfaces are different components: the composer cell is the
  // session-scoped switcher, the page is the root-scoped library panel.
  assert.notEqual(settings.component, composer.component)
})

test('a slot that throws while mounting does not stop the other surface', () => {
  const { apply } = loaded.factory(() => fakeReact)
  const registered = []
  const slots = {
    inject: (key, callback) => {
      if (key === 'settings.section') throw new Error('reshaped')
      callback()
    },
    register: (options) => { registered.push(options); return () => {} },
  }
  assert.doesNotThrow(() => apply({ get: (name) => (name === 'slots' ? slots : undefined) }))
  assert.deepEqual(registered.map(options => options.name), ['conversation.input.left'])
})

test('apply survives a ctx with no slots and a hostile one', () => {
  const { apply } = loaded.factory(() => fakeReact)
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

