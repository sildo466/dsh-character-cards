import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readDefaultCardId, readSessionOverrides } from '../src/cards.js'

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

test('GET /session/<id> reports the effective card and whether it is an override', async () => {
  writeFileSync(join(cardsDir, 'sessions.json'), `${JSON.stringify({ 'session-b': 'teacher' }, null, 2)}\n`)

  const overridden = await harness().call('/dsh-character-cards/session/session-b')
  assert.deepEqual(
    { cardId: overridden.body.cardId, source: overridden.body.source, override: overridden.body.override },
    { cardId: 'teacher', source: 'session override', override: 'teacher' },
  )

  // A session following the default still reports that default as effective -
  // only `override` separates the two cases.
  const inherited = await harness().call('/dsh-character-cards/session/session-z')
  assert.deepEqual(
    { cardId: inherited.body.cardId, source: inherited.body.source, override: inherited.body.override },
    { cardId: 'terse', source: 'default pointer', override: null },
  )
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

test('POST cardId null clears the override and returns the session to the default', async () => {
  writeFileSync(join(cardsDir, 'sessions.json'), `${JSON.stringify({ 'session-c': 'teacher' }, null, 2)}\n`)
  const res = await harness().call('/dsh-character-cards/session/session-c/card', {
    method: 'POST',
    body: { cardId: null },
  })
  assert.equal(res.body.override, null)
  assert.equal(res.body.cardId, 'terse')
  assert.equal(res.body.source, 'default pointer')
  assert.equal(Object.hasOwn(readSessionOverrides(cardsDir, {}), 'session-c'), false)
})

test('POST rejects an unknown card and a malformed cardId', async () => {
  const routes = harness()
  const unknown = await routes.call('/dsh-character-cards/session/s/card', { method: 'POST', body: { cardId: 'ghost' } })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.code, 'unknown-card')

  const missing = await routes.call('/dsh-character-cards/session/s/card', { method: 'POST', body: {} })
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'invalid')
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
