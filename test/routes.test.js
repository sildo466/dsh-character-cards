import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cardExists, readCardFile, readDefaultCardId, readSessionOverrides, setSessionOverride, writeCardFile } from '../src/cards.js'

// CARDS_DIR is resolved from DSH_HOME when index.js is evaluated, so the temp
// home must be built and exported before the dynamic import below.
const home = mkdtempSync(join(tmpdir(), 'dshcd-routes-'))
const cardsDir = join(home, 'character-cards')
mkdirSync(cardsDir, { recursive: true })
const card = (id, name, role) => JSON.stringify({ dshcd: 1, id, name, identity: { role } })
writeFileSync(join(cardsDir, 'terse.dshcd'), card('terse', '简短审阅者', '审阅者'))
writeFileSync(join(cardsDir, 'teacher.dshcd'), card('teacher', '教学者', '导师'))
writeFileSync(join(cardsDir, 'default'), 'terse\n')
writeFileSync(join(cardsDir, 'sessions.json'), '{}\n')

process.env.DSH_HOME = home
const { apply } = await import('../src/index.js')

/** A response stub that records what the handler produced. */
function recorder() {
  return {
    status: undefined,
    body: undefined,
    writeHead(status) { this.status = status },
    end(payload) { this.body = payload === undefined ? undefined : JSON.parse(payload) },
  }
}

/**
 * A request stub that delivers its body the way node:http would.
 *
 * readBody() subscribes synchronously from inside the handler, and the body is
 * queued here before the handler is invoked, so it lands only after every
 * listener is attached.
 */
function request({ method = 'GET', url = '/', host = '127.0.0.1:1', body } = {}) {
  const listeners = new Map()
  const req = {
    method,
    url,
    headers: { host },
    socket: { remoteAddress: '127.0.0.1' },
    on(event, listener) { listeners.set(event, listener); return req },
    destroy() {},
  }
  queueMicrotask(() => {
    if (body !== undefined) listeners.get('data')?.(JSON.stringify(body))
    listeners.get('end')?.()
  })
  return req
}

/** An agent stub whose systemPrompt records every registration and disposal. */
function agentStub(id) {
  const events = []
  const agent = { id, events }
  agent.ctx = {
    inject: (deps, callback) => {
      // The real inject defers by at least a microtask even for an already
      // satisfied dependency (vendor/cordis/src/fiber.ts:650), so the stub
      // defers the same way and the tests exercise the same ordering.
      queueMicrotask(() => callback({
        systemPrompt: {
          getSectionOrder: (name) => ({ DEPLOYMENT_PERSONA_PREFIX: 0, PLAN_POLICY: 500 })[name],
          section: (section) => {
            events.push(`register:${section.name}:${section.text.includes('导师') ? 'teacher' : 'terse'}`)
            return () => events.push('dispose')
          },
        },
      }))
      return { dispose: () => events.push('fiber-dispose') }
    },
  }
  return agent
}

/** Registers the plugin against a stub host and exposes its routes. */
function harness(agents = { get: () => undefined, list: () => [] }) {
  const routes = []
  const ctx = {
    get: (name) => (name === 'webServer'
      ? { register: (route) => { routes.push(route); return () => {} } }
      : name === 'agents' ? agents : undefined),
    inject: () => {},
    on: () => {},
    effect: (effect) => effect(),
    logger: { warn: () => {}, info: () => {} },
  }
  apply(ctx)
  return {
    /** Invoke the route whose path matches, and return the recorded response. */
    async call(path, options = {}) {
      const url = options.url ?? path
      // Longest match wins, mirroring the Web server's prefix rule: a prefix
      // matches its own path or a path that continues after a slash.
      const route = routes
        .filter(entry => entry.kind === 'exact' ? entry.path === url : (url === entry.path || url.startsWith(`${entry.path}/`)))
        .sort((a, b) => b.path.length - a.path.length)[0]
      assert.ok(route, `no route matched ${url}`)
      const res = recorder()
      await route.handler(request({ ...options, url }), res)
      return res
    },
  }
}

test('GET /cards lists the library and the default pointer', async () => {
  const res = await harness().call('/dsh-character-cards/cards')
  assert.equal(res.status, 200)
  assert.equal(res.body.defaultCard, 'terse')
  assert.deepEqual(res.body.cards.map(entry => entry.id), ['teacher', 'terse'])
  assert.ok(res.body.cards[0].tokens > 0)
  assert.ok(res.body.cards[0].chars > 0)
})

test('GET /session/<id> reports the effective card and how it was chosen', async () => {
  writeFileSync(join(cardsDir, 'sessions.json'),
    `${JSON.stringify({ 'session-b': 'teacher', 'session-n': null }, null, 2)}\n`)

  const pinned = await harness().call('/dsh-character-cards/session/session-b')
  assert.deepEqual(pinned.body, {
    ok: true, sessionId: 'session-b', cardId: 'teacher', source: 'session override', override: 'teacher',
  })

  // Following the default still reports that default as the effective card, and
  // omits `override` outright - which is the whole of what separates it from
  // the next case.
  const inherited = await harness().call('/dsh-character-cards/session/session-z')
  assert.deepEqual(inherited.body, {
    ok: true, sessionId: 'session-z', cardId: 'terse', source: 'default pointer',
  })

  // Explicitly no card: an override that happens to be null, and no effective
  // card even though a default exists.
  const none = await harness().call('/dsh-character-cards/session/session-n')
  assert.deepEqual(none.body, {
    ok: true, sessionId: 'session-n', cardId: null, source: 'session override', override: null,
  })
})

test('GET /session rejects a missing session id', async () => {
  const res = await harness().call('/dsh-character-cards/session')
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'invalid')
})

test('POST /session/<id>/card writes the override and rebinds the live agent', async () => {
  const agent = agentStub('session-live')
  const routes = harness({ get: (id) => (id === 'session-live' ? agent : undefined), list: () => [] })

  const res = await routes.call('/dsh-character-cards/session/session-live/card', {
    method: 'POST',
    body: { cardId: 'teacher' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.rebound, true)
  assert.equal(res.body.cardId, 'teacher')
  assert.equal(res.body.override, 'teacher')

  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(agent.events, ['register:dshcd:identity:teacher'])
})

test('POST writes the override even when no agent is live', async () => {
  const res = await harness().call('/dsh-character-cards/session/session-cold/card', {
    method: 'POST',
    body: { cardId: 'teacher' },
  })
  assert.equal(res.body.written, true)
  assert.equal(res.body.rebound, false)
  assert.equal(readSessionOverrides(cardsDir, {})['session-cold'], 'teacher')
})

test('POST cardId null takes no card, and an empty body drops the entry again', async () => {
  writeFileSync(join(cardsDir, 'sessions.json'), `${JSON.stringify({ 'session-c': 'teacher' }, null, 2)}\n`)
  const routes = harness()

  const none = await routes.call('/dsh-character-cards/session/session-c/card', {
    method: 'POST',
    body: { cardId: null },
  })
  assert.equal(none.body.cardId, null)
  assert.equal(none.body.source, 'session override')
  assert.equal(none.body.override, null)
  assert.equal(readSessionOverrides(cardsDir, {})['session-c'], null)

  const cleared = await routes.call('/dsh-character-cards/session/session-c/card', {
    method: 'POST',
    body: {},
  })
  assert.equal(cleared.body.cardId, 'terse')
  assert.equal(cleared.body.source, 'default pointer')
  assert.equal(Object.hasOwn(cleared.body, 'override'), false)
  assert.equal(Object.hasOwn(readSessionOverrides(cardsDir, {}), 'session-c'), false)
})

test('taking no card disposes the section rather than leaving the old one up', async () => {
  const agent = agentStub('session-none')
  const routes = harness({ get: () => agent, list: () => [] })

  await routes.call('/dsh-character-cards/session/session-none/card', { method: 'POST', body: { cardId: 'terse' } })
  await new Promise(resolve => setTimeout(resolve, 0))
  await routes.call('/dsh-character-cards/session/session-none/card', { method: 'POST', body: { cardId: null } })
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.deepEqual(agent.events, ['register:dshcd:identity:terse', 'dispose', 'fiber-dispose'])
})

test('POST rejects an unknown card and a malformed cardId', async () => {
  const routes = harness()
  const unknown = await routes.call('/dsh-character-cards/session/s/card', { method: 'POST', body: { cardId: 'ghost' } })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.code, 'unknown-card')

  // An empty body is a valid request that drops the entry, so the rejection
  // cases have to be a cardId that is present but unusable.
  const malformed = await routes.call('/dsh-character-cards/session/s/card', { method: 'POST', body: { cardId: 7 } })
  assert.equal(malformed.status, 400)
  assert.equal(malformed.body.code, 'invalid')

  const blank = await routes.call('/dsh-character-cards/session/s/card', { method: 'POST', body: { cardId: '' } })
  assert.equal(blank.status, 400)
  assert.equal(blank.body.code, 'invalid')
})

test('switching twice disposes the previous registration before registering the new one', async () => {
  const agent = agentStub('session-twice')
  const routes = harness({ get: () => agent, list: () => [] })

  await routes.call('/dsh-character-cards/session/session-twice/card', { method: 'POST', body: { cardId: 'terse' } })
  await new Promise(resolve => setTimeout(resolve, 0))
  await routes.call('/dsh-character-cards/session/session-twice/card', { method: 'POST', body: { cardId: 'teacher' } })
  await new Promise(resolve => setTimeout(resolve, 0))

  // The dispose must land before the replacement registers, or the second
  // registration would collide with the name the first one still holds.
  assert.deepEqual(agent.events, [
    'register:dshcd:identity:terse',
    'dispose',
    'fiber-dispose',
    'register:dshcd:identity:teacher',
  ])
})

test('POST /default repoints the global default', async () => {
  const res = await harness().call('/dsh-character-cards/default', { method: 'POST', body: { cardId: 'teacher' } })
  assert.equal(res.status, 200)
  assert.equal(res.body.defaultCard, 'teacher')
  assert.equal(readDefaultCardId(cardsDir), 'teacher')

  // Put it back so the assertions above stay order-independent.
  await harness().call('/dsh-character-cards/default', { method: 'POST', body: { cardId: 'terse' } })
})

test('POST /default rejects an unknown card and a GET', async () => {
  const routes = harness()
  const unknown = await routes.call('/dsh-character-cards/default', { method: 'POST', body: { cardId: 'ghost' } })
  assert.equal(unknown.status, 400)

  const wrongMethod = await routes.call('/dsh-character-cards/default', { method: 'GET' })
  assert.equal(wrongMethod.status, 405)
})

test('every route refuses a request that is not from this machine', async () => {
  for (const path of ['/dsh-character-cards/cards', '/dsh-character-cards/status', '/dsh-character-cards/session/s']) {
    const res = await harness().call(path, { host: 'evil.example.com' })
    assert.equal(res.status, 403, `${path} should refuse a foreign Host header`)
  }
})

test('POST /cards/preview reports validity, size, and D5 advisories', async () => {
  const routes = harness()

  const valid = await routes.call('/dsh-character-cards/cards/preview', {
    method: 'POST',
    body: { card: { dshcd: 1, id: 'p', identity: { role: '审阅者' } } },
  })
  assert.equal(valid.body.valid, true)
  assert.ok(valid.body.chars > 0)
  assert.equal(valid.body.tokens, Math.ceil(valid.body.chars / 3))
  assert.deepEqual(valid.body.warnings, [])

  const invalid = await routes.call('/dsh-character-cards/cards/preview', {
    method: 'POST',
    body: { card: { dshcd: 2 } },
  })
  assert.equal(invalid.body.valid, false)
  assert.match(invalid.body.error, /declares dshcd 2/)
})

test('POST /cards/preview warns past 12 rules and past 60 characters', async () => {
  const rules = Array.from({ length: 13 }, (_, index) => `rule ${index}`)
  rules[0] = 'x'.repeat(61)
  const res = await harness().call('/dsh-character-cards/cards/preview', {
    method: 'POST',
    body: { card: { dshcd: 1, id: 'p', constraints: rules } },
  })
  const codes = res.body.warnings.map(warning => warning.code).sort()
  assert.deepEqual(codes, ['rule-too-long', 'too-many-rules'])
})

test('POST /cards creates a card and refuses to overwrite an existing one', async () => {
  const card = { dshcd: 1, id: 'brand-new', name: '新卡' }
  const created = await harness().call('/dsh-character-cards/cards', { method: 'POST', body: { card } })
  assert.equal(created.status, 200)
  assert.equal(created.body.id, 'brand-new')
  assert.equal(cardExists(cardsDir, 'brand-new'), true)

  const again = await harness().call('/dsh-character-cards/cards', { method: 'POST', body: { card } })
  assert.equal(again.status, 409)
  assert.equal(again.body.code, 'exists')
})

test('POST /cards refuses an unsafe id', async () => {
  const res = await harness().call('/dsh-character-cards/cards', {
    method: 'POST',
    body: { card: { dshcd: 1, id: '../escape' } },
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'invalid-id')
})

test('PUT /cards/<id> updates in place and rejects a mismatched id', async () => {
  const card = { dshcd: 1, id: 'editable', name: '第一版', futureField: { keep: true } }
  writeCardFile(cardsDir, card, {})

  const updated = { ...card, name: '第二版' }
  const res = await harness().call('/dsh-character-cards/cards/editable', {
    method: 'PUT',
    body: { card: updated },
  })
  assert.equal(res.status, 200)
  const read = readCardFile(cardsDir, 'editable', {})
  assert.equal(read.name, '第二版')
  assert.deepEqual(read.futureField, { keep: true })

  const mismatch = await harness().call('/dsh-character-cards/cards/editable', {
    method: 'PUT',
    body: { card: { ...card, id: 'something-else' } },
  })
  assert.equal(mismatch.status, 400)
  assert.equal(mismatch.body.code, 'id-mismatch')
})

test('PUT /cards/<id> returns 404 when the file is gone', async () => {
  const res = await harness().call('/dsh-character-cards/cards/never-existed', {
    method: 'PUT',
    body: { card: { dshcd: 1, id: 'never-existed' } },
  })
  assert.equal(res.status, 404)
  assert.equal(res.body.code, 'not-found')
})

test('GET /cards/<id> returns the raw card', async () => {
  writeCardFile(cardsDir, { dshcd: 1, id: 'raw', name: '原始', futureField: [1, 2] }, {})
  const res = await harness().call('/dsh-character-cards/cards/raw')
  assert.deepEqual(res.body.card, { dshcd: 1, id: 'raw', name: '原始', futureField: [1, 2] })

  const missing = await harness().call('/dsh-character-cards/cards/nope')
  assert.equal(missing.status, 404)
})

test('POST /cards/<id>/apply rebinds only the sessions using that card', async () => {
  const using = agentStub('session-using')
  const other = agentStub('session-other')
  writeCardFile(cardsDir, { dshcd: 1, id: 'apply-me', identity: { role: '审阅者' } }, {})
  setSessionOverride(cardsDir, 'session-using', 'apply-me', {})

  const routes = harness({
    get: (id) => ({ 'session-using': using, 'session-other': other })[id],
    list: () => [using, other],
  })

  // Mounting the plugin binds every live agent, so clear what that produced:
  // this assertion is about what the apply route adds, not about boot.
  await new Promise(resolve => setTimeout(resolve, 0))
  using.events.length = 0
  other.events.length = 0

  const res = await routes.call('/dsh-character-cards/cards/apply-me/apply', { method: 'POST', body: {} })
  assert.equal(res.status, 200)
  assert.equal(res.body.applied, 1)

  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(using.events.some(event => event.startsWith('register:')), true)
  assert.deepEqual(other.events, [])
})

test('GET /cards/<id> counts the sessions using it', async () => {
  const using = agentStub('session-counted')
  writeCardFile(cardsDir, { dshcd: 1, id: 'counted', identity: { role: 'x' } }, {})
  setSessionOverride(cardsDir, 'session-counted', 'counted', {})

  const routes = harness({
    get: (id) => (id === 'session-counted' ? using : undefined),
    list: () => [using],
  })
  const res = await routes.call('/dsh-character-cards/cards/counted')
  assert.deepEqual(res.body.sessionsUsing, ['session-counted'])
})

test('GET /cards carries the per-card usage count', async () => {
  const using = agentStub('session-list')
  writeCardFile(cardsDir, { dshcd: 1, id: 'listed', identity: { role: 'x' } }, {})
  setSessionOverride(cardsDir, 'session-list', 'listed', {})

  const routes = harness({ get: () => using, list: () => [using] })
  const res = await routes.call('/dsh-character-cards/cards')
  const listed = res.body.cards.find(card => card.id === 'listed')
  assert.equal(listed.sessionsUsing, 1)
})

test('a malformed percent-escape answers 400 instead of throwing out of the handler', async () => {
  // `/%` reaches the handler - the prefix still matches - and decodeURIComponent
  // would throw on it. A throw from inside an async route handler rejects its
  // promise rather than answering the request, which on this runtime can take
  // the host process down, so the response has to come from the handler's own
  // unusable-id path.
  const cards = await harness().call('/dsh-character-cards/cards/%')
  assert.equal(cards.status, 400)
  assert.equal(cards.body.code, 'invalid-id')

  const session = await harness().call('/dsh-character-cards/session/%')
  assert.equal(session.status, 400)
  assert.equal(session.body.code, 'invalid')
  assert.equal(session.body.error, 'session id required')
})

test('POST /cards refuses an id the route table already owns', async () => {
  const res = await harness().call('/dsh-character-cards/cards', {
    method: 'POST',
    body: { card: { dshcd: 1, id: 'preview' } },
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.code, 'reserved-id')
  assert.equal(cardExists(cardsDir, 'preview'), false)
})
