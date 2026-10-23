import { test } from 'node:test'
import assert from 'node:assert/strict'

let loaded
globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec } } }

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
}

const fakePrimitives = {
  Menu: () => null,
  Pill: () => null,
  IconChevronDownOutline14: () => null,
}

/**
 * A stand-in for the module loader's synchronous require.
 * @param primitives - what the primitives package resolves to; pass null to
 *   simulate a build that does not have it.
 * @returns a require function.
 */
function makeFakeRequire(primitives = fakePrimitives) {
  return (name) => {
    if (name === 'react') return fakeReact
    if (name === '@deepseek-ai/dsh-client-ui-primitives' && primitives !== undefined) return primitives
    throw new Error(`unexpected require: ${name}`)
  }
}

await import('../src/client.js')

test('the client half registers under its own package id', () => {
  assert.equal(loaded.id, 'dsh-character-cards')
})

test('switcherMode picks session mode only for a non-empty sessionId', () => {
  const { switcherMode } = loaded.factory(makeFakeRequire())
  assert.equal(switcherMode({ sessionId: 'session-a' }), 'session')
  assert.equal(switcherMode({ sessionId: undefined }), 'global')
  assert.equal(switcherMode({ sessionId: '' }), 'global')
  assert.equal(switcherMode({}), 'global')
  assert.equal(switcherMode(undefined), 'global')
})

test('the factory still loads when the primitives package is unavailable', () => {
  // An unregistered specifier throws rather than resolving to undefined, so a
  // build without the primitives must be caught rather than allowed to take
  // the whole client module down. `null` (not undefined) opts out of the
  // helper's default, which is how the absence is simulated.
  const module = loaded.factory(makeFakeRequire(null))
  assert.equal(typeof module.apply, 'function')
  // The switcher still has all its other surfaces to fall back on.
  assert.equal(typeof module.switcherEntries, 'function')
})

test('apply claims the settings page and the composer tool row', () => {
  const { apply } = loaded.factory(makeFakeRequire())
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
  const { apply } = loaded.factory(makeFakeRequire())
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
  const { apply } = loaded.factory(makeFakeRequire())
  assert.doesNotThrow(() => apply({ get: () => undefined }))
  assert.doesNotThrow(() => apply({ get: () => { throw new Error('hostile') } }))
})

test('initialSelection names the option for each of the three session states', () => {
  const { initialSelection } = loaded.factory(makeFakeRequire())
  const cards = { defaultCard: 'terse', cards: [] }

  // Global mode only ever picks a card, so it shows the current default.
  assert.equal(initialSelection('global', cards, undefined), 'card:terse')

  // Session mode has three answers. Pinned and "no card" are distinct, and so
  // is following the default - which reports the default as the effective card
  // and therefore cannot be told from "no card" by cardId alone.
  assert.equal(initialSelection('session', cards, { override: 'teacher', cardId: 'teacher' }), 'card:teacher')
  assert.equal(initialSelection('session', cards, { override: null, cardId: null }), 'none')
  assert.equal(initialSelection('session', cards, { cardId: 'terse', source: 'default pointer' }), 'default')

  // A host with no default set must not select an option that does not exist.
  assert.equal(initialSelection('global', { defaultCard: null, cards: [] }, undefined), '')
  assert.equal(initialSelection('global', undefined, undefined), '')

  // The `card:` prefix is what keeps a card actually named "none" addressable.
  assert.equal(initialSelection('global', { defaultCard: 'none', cards: [] }, undefined), 'card:none')
})

test('switcherEntries offers the two session answers first, then every card', () => {
  const { switcherEntries } = loaded.factory(makeFakeRequire())
  const cards = { defaultCard: 'terse', cards: [{ id: 'terse', name: '简短审阅者' }, { id: 'teacher' }] }

  assert.deepEqual(switcherEntries('session', cards), [
    { id: 'none', label: '不使用角色卡' },
    { id: 'default', label: '跟随默认' },
    { id: 'card:terse', label: '简短审阅者' },
    { id: 'card:teacher', label: 'teacher' },
  ])

  // Global mode only ever picks a card: there is no default to follow and no
  // session to opt out of.
  assert.deepEqual(switcherEntries('global', cards), [
    { id: 'card:terse', label: '简短审阅者' },
    { id: 'card:teacher', label: 'teacher' },
  ])

  // An empty library still leaves a usable control rather than an empty menu.
  assert.deepEqual(switcherEntries('session', undefined), [
    { id: 'none', label: '不使用角色卡' },
    { id: 'default', label: '跟随默认' },
  ])
})

test('fieldOf reads a nested path without throwing on a missing parent', () => {
  const { fieldOf } = loaded.factory(makeFakeRequire())
  const card = { identity: { role: '审阅者' }, workflow: { ask_when_unclear: true } }
  assert.equal(fieldOf(card, 'identity.role'), '审阅者')
  assert.equal(fieldOf(card, 'workflow.ask_when_unclear'), true)
  assert.equal(fieldOf(card, 'voice.tone'), undefined)
  assert.equal(fieldOf(card, 'missing.deep.path'), undefined)
  assert.equal(fieldOf(undefined, 'a.b'), undefined)
})

test('withField replaces one nested value and leaves the rest byte-identical', () => {
  const { withField } = loaded.factory(makeFakeRequire())
  const original = { dshcd: 1, id: 'x', identity: { role: 'old' }, budget: { maxTokens: 400 } }
  const next = withField(original, 'identity.role', 'new')

  assert.deepEqual(next.identity, { role: 'new' })
  // Unknown fields survive a field edit - the editor's whole preservation story
  // depends on this.
  assert.deepEqual(next.budget, { maxTokens: 400 })
  // The input object is not mutated.
  assert.equal(original.identity.role, 'old')
  assert.notEqual(next, original)
})

test('withField creates the parent object when the group is absent', () => {
  const { withField } = loaded.factory(makeFakeRequire())
  const next = withField({ dshcd: 1, id: 'x' }, 'voice.tone', 'direct')
  assert.deepEqual(next.voice, { tone: 'direct' })
})

test('editorGroups carries the five groups with their D2 badges', () => {
  const { editorGroups } = loaded.factory(makeFakeRequire())
  const groups = editorGroups()
  assert.deepEqual(groups.map(group => group.key), ['identity', 'voice', 'code', 'workflow', 'constraints'])
  assert.equal(groups[1].badge, '安全 · 只影响表达，不影响正确性')
  assert.equal(groups[2].badge, '会改变代码 · 影响产出质量与风格')
  assert.equal(groups[3].badge, '高风险 · 影响行为决策')
  assert.equal(groups[0].fields.some(field => field.path === 'identity.role'), true)
})

test('isDirty compares structurally, not by key order', () => {
  const { isDirty } = loaded.factory(makeFakeRequire())
  assert.equal(isDirty({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } }), false)
  assert.equal(isDirty({ b: { c: 2 }, a: 1 }, { a: 1, b: { c: 2 } }), false)
  assert.equal(isDirty({ a: 1 }, { a: 2 }), true)
  // A brand-new card is always dirty against "no original".
  assert.equal(isDirty({ a: 1 }, null), true)
})

test('nextSelection keeps a still-offered value across a refresh', () => {
  const { nextSelection } = loaded.factory(makeFakeRequire())
  const entries = [{ id: 'card:a' }, { id: 'card:b' }, { id: 'none' }]
  assert.equal(nextSelection(entries, 'card:b', 'card:a'), 'card:b')
  // A value the host no longer offers falls back to the computed one.
  assert.equal(nextSelection(entries, 'card:gone', 'card:a'), 'card:a')
})

