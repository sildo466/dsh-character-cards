// dsh-character-cards - host half.
//
// Cordis wiring only: the loopback-only HTTP surface, the agent/created bind,
// and the diagnostic state behind /status. The .dshcd format itself - parsing,
// rendering, budgeting, the card library, and the resolution order - lives in
// ./cards.js, which takes its directory as a parameter so it can be exercised
// without a Cordis context.
//
// Mount point note. GOAL D3 proposed writing the card into `deployment:persona`
// itself. That cannot work: every shipped preset (standard, minimal, ptc,
// cordis) mounts `@deepseek-ai/dsh-persona`, which registers that exact section
// name in the agent's scope before the agent is published. A second registration
// of the same name in the same layer throws. `dsh-tool-agent-team` faces the
// same constraint and solves it the same way - its own section name at its own
// order (`team:policy`). This row is `dshcd:identity`, one order after the
// persona slot.

import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  cardExists,
  cardWarnings,
  clearSessionOverride,
  inspectCard,
  isValidCardId,
  listCardSummaries,
  loadCardLibrary,
  measure,
  readCardFile,
  readDefaultCardId,
  readSessionOverrides,
  renderCard,
  renderCardById,
  resolveCardId,
  setDefaultCardId,
  setSessionOverride,
  text,
  writeCardFile,
} from './cards.js'

export const name = 'dsh-character-cards'

/** Route namespace owned by this plugin. */
const ROUTE_PREFIX = '/dsh-character-cards'

/**
 * Section name owned by this plugin. Not `PERSONA_SECTION` - see the mount
 * point note above.
 */
const SECTION_NAME = 'dshcd:identity'

/**
 * Section-placement names to try, in preference order.
 *
 * `getSectionOrder` returns `undefined` for a name the running build does not
 * declare rather than throwing, so an unknown name becomes `NaN` and surfaces
 * only as `order must be a finite number` at `section()`. That is exactly what
 * happened against the installed 0.2.x runtime: the checkout this was written
 * from declares `DEPLOYMENT_PERSONA`, the installed build does not, and its
 * assembled prompt carries `deployment:persona-prefix` / `-suffix` instead.
 * Probing a list keeps the placement "just after the persona" without pinning
 * the build.
 */
const ORDER_CANDIDATES = ['DEPLOYMENT_PERSONA', 'DEPLOYMENT_PERSONA_PREFIX', 'PERSONA', 'PLAN_POLICY']

/** Card library directory, honoring DSH_HOME. */
const CARDS_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'character-cards')

/** File whose trimmed contents name the global default card. */
const DEFAULT_POINTER = join(CARDS_DIR, 'default')

/** File holding per-session overrides: `{ "<sessionId>": "<cardId>" }`. */
const SESSION_OVERRIDES = join(CARDS_DIR, 'sessions.json')

/**
 * Spike diagnostic state.
 *
 * `boundCount: 0` after a session answered is ambiguous on its own: it looks
 * identical whether the listener never ran, the registration threw, or the text
 * arrived and the model ignored it. Reading the transcript cannot separate
 * those, so every stage records itself here and /status reports it. None of this
 * is part of the design being validated.
 */
const diag = {
  /** How `agents` resolved when apply() ran. */
  agentsAtLoad: 'unknown',
  /** Whether the agent/created listener was registered. */
  subscribed: false,
  /** How many times the agent/created listener ran. */
  listenerCalls: 0,
  /** Failures recorded while binding, newest first (bounded). */
  bindErrors: [],
  /** How many times the systemPrompt injection callback actually ran. */
  injectCallbacks: 0,
  /** How many section() calls succeeded. */
  sectionsRegistered: 0,
  /** Which order-name candidate resolved, and to what. */
  orderResolved: null,
  /** Successfully bound agents, keyed by agent id. */
  bound: new Map(),
  /**
   * Each agent's current registration, keyed by agent id.
   *
   * One entry holds both halves of one registration: the inject fiber that owns
   * the deferred callback, and the section disposer that callback produced.
   * Rebinding needs the section disposer, because calling it is what frees the
   * `dshcd:identity` name synchronously; the fiber itself has nothing left to
   * do by then and is disposed for tidiness.
   */
  registrations: new Map(),
  /**
   * The last few assembled prompts, newest first.
   *
   * `bound` proves section() was called; it does NOT prove the text reached the
   * model. A `complete: true` section in the same scope silently replaces every
   * other section at the end of assembly, so the two are genuinely different
   * facts and only this records the second one.
   */
  assembles: [],
}

/** Record one binding failure without letting it escape. */
function recordError(error) {
  diag.bindErrors.unshift(String(error))
  if (diag.bindErrors.length > 5) diag.bindErrors.length = 5
}

/**
 * Whether a socket address belongs to this machine.
 * @param {unknown} address - `req.socket.remoteAddress`.
 * @returns {boolean} true for IPv4/IPv6 loopback forms.
 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

/**
 * Whether a Host header names this machine.
 * @param {unknown} host - `req.headers.host`.
 * @returns {boolean} true for localhost and loopback literals.
 */
function isLocalHostHeader(host) {
  if (typeof host !== 'string' || host.length === 0) return false
  const name = host.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase()
  return name === 'localhost' || name === '127.0.0.1' || name === '::1'
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - response to complete.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - JSON-serializable payload.
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Read a request body as text, refusing anything implausibly large.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @returns {Promise<string>} the body text.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

/**
 * The request's pathname, ignoring any query string.
 *
 * The Web server matches routes on this same value and hands the original
 * request through, so a prefix handler has to re-derive it.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @returns {string} the pathname.
 */
function pathnameOf(req) {
  return new URL(req.url ?? '/', 'http://x').pathname
}

/**
 * Reject anything that is not a loopback request from this machine.
 *
 * The Origin check is conditional on purpose: the Electron desktop shell
 * serves the app from `dsh-app://app/`, so its requests carry neither Origin
 * nor Sec-Fetch-Site. Requiring either header would 403 every desktop client.
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @param {import('node:http').ServerResponse} res - response, completed on rejection.
 * @returns {boolean} true when the request may proceed.
 */
function guard(req, res) {
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'loopback only' })
    return false
  }
  const host = req.headers.host
  if (!isLocalHostHeader(host)) {
    sendJson(res, 403, { ok: false, code: 'forbidden', error: 'unexpected host' })
    return false
  }
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    let originHost = null
    try {
      originHost = new URL(origin).host
    } catch {
      originHost = null
    }
    if (originHost !== host) {
      sendJson(res, 403, { ok: false, code: 'forbidden', error: 'cross-origin request' })
      return false
    }
  }
  return true
}

/**
 * Resolve the order this section should sit at, tolerating placement-name drift.
 * @param {{ getSectionOrder: (name: string) => number }} systemPrompt - the prompt registry.
 * @returns {number} a finite order, one past the resolved anchor.
 */
function resolveOrder(systemPrompt) {
  for (const name of ORDER_CANDIDATES) {
    const value = systemPrompt.getSectionOrder(name)
    if (Number.isFinite(value)) {
      diag.orderResolved = { name, anchor: value, order: value + 1 }
      return value + 1
    }
  }
  diag.orderResolved = { name: null, anchor: null, order: 1, fallback: true }
  return 1
}

/**
 * Bind the active card to one agent's prompt section.
 *
 * Registration goes through `agent.ctx.inject(['systemPrompt'], …)` rather than
 * naming `agent.ctx.systemPrompt` directly. That is the idiom
 * `@deepseek-ai/dsh-file-reference-local` uses for the identical job, and the
 * difference is load-bearing: the services an agent scope exposes are not all
 * resolvable at the instant the agent is created, so a direct access can throw
 * where an injection waits.
 *
 * A card that is absent or unreadable leaves the agent on the host composition
 * rather than failing its creation.
 * @param {{ id: string, ctx: import('@deepseek-ai/cordis').Context }} agent - the created agent.
 * @param {{ warn?: (message: string) => void }} logger - logger for diagnostics.
 */
/**
 * Resolve and render the card one session should carry right now.
 * @param {string} sessionId - the shared agent/session id.
 * @param {{ warn?: (message: string) => void }} logger - logger for failures.
 * @returns {object | undefined} the rendered card plus its `source`, or undefined
 *   when the session carries no card - whether because nothing is configured or
 *   because it was explicitly told to take none.
 */
function renderedFor(sessionId, logger) {
  const resolved = resolveCardId(CARDS_DIR, sessionId, logger)
  if (resolved === undefined || resolved.cardId === null) return undefined
  const card = renderCardById(CARDS_DIR, resolved.cardId, logger)
  return card === undefined ? undefined : { ...card, source: resolved.source }
}

/**
 * Bind the active card to one agent's prompt section.
 * @param {{ id: string, ctx: object }} agent - the created agent.
 * @param {{ warn?: (message: string) => void }} logger - logger for diagnostics.
 */
function bindCard(agent, logger) {
  registerSection(agent, renderedFor(agent.id, logger), logger)
}

/**
 * Register a rendered card on one live agent, replacing any previous one.
 *
 * The previous section disposer is called SYNCHRONOUSLY, so the
 * `dshcd:identity` name is free before the replacement can land. The
 * replacement itself must go through `ctx.inject`, whose callback Cordis
 * always defers by at least a microtask even when systemPrompt is already
 * resolvable (vendor/cordis/src/fiber.ts:650), and reaching
 * `agent.ctx.systemPrompt` directly is refused by the dependency guard. That
 * leaves a one-microtask window in which an assembly would find no card; the
 * spec's section 4.2 records why that is accepted rather than worked around.
 * @param {{ id: string, ctx: object }} agent - the live agent.
 * @param {object | undefined} rendered - rendered card (plus `source`), or undefined to leave the agent unbound.
 * @param {{ warn?: (message: string) => void }} logger - logger for failures.
 * @returns {object | undefined} the registration holder, once inject() has been called.
 */
function registerSection(agent, rendered, logger) {
  const previous = diag.registrations.get(agent.id)
  diag.registrations.delete(agent.id)
  diag.bound.delete(agent.id)
  if (previous !== undefined) {
    try { previous.disposeSection?.() } catch (error) { recordError(error) }
    try { void previous.fiber?.dispose?.() } catch (error) { recordError(error) }
  }
  if (rendered === undefined) return undefined

  // The inject callback runs after this function returns, so it publishes into
  // the holder rather than through a return value.
  const registration = {}
  registration.fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
    // Recorded HERE, not after inject() returns. inject() may fire its callback
    // later or never, so a flag set outside would claim a registration that did
    // not happen - exactly the conflation this diagnostic exists to avoid.
    diag.injectCallbacks += 1
    try {
      registration.disposeSection = scope.systemPrompt.section({
        name: SECTION_NAME,
        order: resolveOrder(scope.systemPrompt),
        text: rendered.text,
      })
      diag.sectionsRegistered += 1
      diag.bound.set(agent.id, {
        card: rendered.id,
        name: rendered.name,
        source: rendered.source ?? null,
        chars: rendered.text.length,
        tokens: rendered.tokens,
      })
    } catch (error) {
      recordError(error)
      logger.warn?.(`section() failed for agent ${agent.id}: ${String(error)}`)
    }
  })
  diag.registrations.set(agent.id, registration)
  return registration
}

/**
 * The card library as a picker sees it.
 * @returns {{ defaultCard: string | null, cards: object[] }} the snapshot.
 */
function librarySnapshot() {
  return {
    defaultCard: readDefaultCardId(CARDS_DIR) ?? null,
    cards: listCardSummaries(CARDS_DIR, {}),
  }
}

/**
 * How one session resolves its card right now.
 *
 * `override` is omitted rather than nulled when the session has no entry of its
 * own, because the two are different answers: absent means "follow the
 * default", an explicit null means "take no card". A picker needs all three
 * states to render its selection.
 * @param {string} sessionId - the shared agent/session id.
 * @returns {{ sessionId: string, cardId: string | null, source: string | null, override?: string | null }} the session view.
 */
function sessionView(sessionId) {
  const overrides = readSessionOverrides(CARDS_DIR, {})
  const resolved = resolveCardId(CARDS_DIR, sessionId, {})
  return {
    sessionId,
    cardId: resolved === undefined ? null : resolved.cardId,
    source: resolved === undefined ? null : resolved.source,
    ...(Object.hasOwn(overrides, sessionId) ? { override: overrides[sessionId] } : {}),
  }
}

/**
 * Re-resolve one live session's card and swap its prompt section in place.
 *
 * The new card is resolved and rendered BEFORE anything is disposed, so a
 * failure here leaves the previous card in place - a session must never be left
 * with no identity at all because a switch went wrong.
 * @param {{ id: string, ctx: object }} agent - the live agent.
 * @param {string} sessionId - the shared agent/session id.
 * @param {{ warn?: (message: string) => void }} logger - logger for failures.
 */
function rebind(agent, sessionId, logger) {
  let rendered
  try {
    rendered = renderedFor(sessionId, logger)
  } catch (error) {
    recordError(error)
    logger.warn?.(`resolving the new card for ${sessionId} failed; keeping the previous one: ${String(error)}`)
    return
  }
  registerSection(agent, rendered, logger)
}

/**
 * Register this plugin's HTTP routes on a Web surface.
 * @param {{ register: (route: object) => () => void }} webServer - the Web server service.
 * @param {import('@deepseek-ai/cordis').Context} ctx - context owning the registrations and serving the agent lookup.
 */
function registerRoutes(webServer, ctx) {
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/ping`,
    handler: (req, res) => {
      if (!guard(req, res)) return
      sendJson(res, 200, { ok: true, plugin: name, version: '0.0.1' })
    },
  }))

  // What a picker needs to render itself, and the create that adds to it. One
  // registration serves both verbs: the route table rejects a duplicate
  // (kind, path), so the list and the create could not be two rows.
  //
  // Create is separate from update so that an id collision is a 409 rather than
  // a silent overwrite.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/cards`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') {
        sendJson(res, 200, { ok: true, ...librarySnapshot() })
        return
      }
      let body = {}
      try {
        const raw = await readBody(req)
        if (raw) body = JSON.parse(raw)
      } catch {
        sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
        return
      }
      const inspected = inspectCard(body.card)
      if ('error' in inspected) {
        sendJson(res, 400, { ok: false, code: 'invalid', error: inspected.error })
        return
      }
      const id = text(inspected.card.id)
      if (id === undefined || !isValidCardId(id)) {
        sendJson(res, 400, { ok: false, code: 'invalid-id', error: 'id must match ^[a-z0-9][a-z0-9-]*$' })
        return
      }
      if (cardExists(CARDS_DIR, id)) {
        sendJson(res, 409, { ok: false, code: 'exists', error: `card "${id}" already exists` })
        return
      }
      const written = writeCardFile(CARDS_DIR, inspected.card, ctx.logger ?? {})
      if (!written.ok) {
        sendJson(res, 400, { ok: false, code: written.code, error: written.error })
        return
      }
      sendJson(res, 200, { ok: true, id })
    },
  }))

  // Draft validation. The client sends the card it has built; the host answers
  // with what this build thinks of it. Format rules live only here, so the
  // editor cannot drift from the renderer.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/cards/preview`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
        return
      }
      let body = {}
      try {
        const raw = await readBody(req)
        if (raw) body = JSON.parse(raw)
      } catch {
        sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
        return
      }
      const inspected = inspectCard(body.card)
      if ('error' in inspected) {
        sendJson(res, 200, { ok: true, valid: false, error: inspected.error, warnings: [] })
        return
      }
      const rendered = renderCard(inspected.card)
      sendJson(res, 200, {
        ok: true,
        valid: true,
        ...measure(rendered),
        warnings: cardWarnings(inspected.card),
      })
    },
  }))

  // One card by id, plus the write that changes it. A single prefix
  // registration serves GET and PUT because the route table rejects a duplicate
  // (kind, path), and the matcher takes a prefix only when it equals the path or
  // is followed by a slash - so this is registered without a trailing one.
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: `${ROUTE_PREFIX}/cards`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const id = decodeURIComponent(pathnameOf(req).slice(`${ROUTE_PREFIX}/cards`.length).replace(/^\//, ''))
      if (!isValidCardId(id)) {
        sendJson(res, 400, { ok: false, code: 'invalid-id', error: 'id must match ^[a-z0-9][a-z0-9-]*$' })
        return
      }

      if (req.method === 'GET') {
        const card = readCardFile(CARDS_DIR, id, ctx.logger ?? {})
        if (card === undefined) {
          sendJson(res, 404, { ok: false, code: 'not-found', error: `no card "${id}"` })
          return
        }
        sendJson(res, 200, { ok: true, id, card })
        return
      }

      if (req.method !== 'PUT') {
        sendJson(res, 405, { ok: false, code: 'method', error: 'GET or PUT only' })
        return
      }

      if (!cardExists(CARDS_DIR, id)) {
        sendJson(res, 404, { ok: false, code: 'not-found', error: `no card "${id}"` })
        return
      }
      let body = {}
      try {
        const raw = await readBody(req)
        if (raw) body = JSON.parse(raw)
      } catch {
        sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
        return
      }
      const inspected = inspectCard(body.card)
      if ('error' in inspected) {
        sendJson(res, 400, { ok: false, code: 'invalid', error: inspected.error })
        return
      }
      // The id is the filename, so a body whose id disagrees with the path is
      // refused rather than written - otherwise one request could name two
      // different files depending on which side you read.
      if (text(inspected.card.id) !== id) {
        sendJson(res, 400, { ok: false, code: 'id-mismatch', error: 'the card id does not match the path' })
        return
      }
      const written = writeCardFile(CARDS_DIR, inspected.card, ctx.logger ?? {})
      if (!written.ok) {
        sendJson(res, 400, { ok: false, code: written.code, error: written.error })
        return
      }
      sendJson(res, 200, { ok: true, id })
    },
  }))

  // One session's card, and the write that changes it. A single registration
  // serves both verbs because the route table rejects a duplicate (kind, path),
  // and the matcher takes a prefix only when it equals the path or is followed
  // by a slash - so this is registered without a trailing one.
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: `${ROUTE_PREFIX}/session`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const rest = pathnameOf(req).slice(`${ROUTE_PREFIX}/session`.length).replace(/^\//, '')
      const sessionId = decodeURIComponent(rest.endsWith('/card') ? rest.slice(0, -'/card'.length) : rest)
      if (sessionId.length === 0) {
        sendJson(res, 400, { ok: false, code: 'invalid', error: 'session id required' })
        return
      }

      if (req.method !== 'POST') {
        sendJson(res, 200, { ok: true, ...sessionView(sessionId) })
        return
      }

      const logger = ctx.logger ?? {}
      let body = {}
      try {
        const raw = await readBody(req)
        if (raw) body = JSON.parse(raw)
      } catch {
        sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
        return
      }
      // Three states, told apart by the body's shape rather than by a sentinel
      // value that a card id could collide with:
      //   { cardId: "id" }  pin that card
      //   { cardId: null }  take no card, even though a default exists
      //   { }               drop the entry, following the default again
      const hasCardId = Object.hasOwn(body, 'cardId')
      const cardId = hasCardId && body.cardId !== null ? text(body.cardId) : null
      if (hasCardId && cardId === undefined) {
        sendJson(res, 400, { ok: false, code: 'invalid', error: 'cardId must be a non-empty string or null' })
        return
      }
      if (typeof cardId === 'string' && !loadCardLibrary(CARDS_DIR, {}).has(cardId)) {
        sendJson(res, 400, { ok: false, code: 'unknown-card', error: `no card "${cardId}"` })
        return
      }

      const written = hasCardId
        ? setSessionOverride(CARDS_DIR, sessionId, cardId, logger)
        : clearSessionOverride(CARDS_DIR, sessionId, logger)
      // A session with no live agent is not an error: the override is already
      // on disk and takes effect when that session is next created or resumed.
      const agent = ctx.get('agents')?.get(sessionId)
      if (agent !== undefined) rebind(agent, sessionId, logger)
      sendJson(res, 200, { ok: true, ...sessionView(sessionId), written, rebound: agent !== undefined })
    },
  }))

  // The global default: the other half of what the switcher drives.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/default`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
        return
      }
      let body = {}
      try {
        const raw = await readBody(req)
        if (raw) body = JSON.parse(raw)
      } catch {
        sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
        return
      }
      const cardId = text(body.cardId)
      if (cardId === undefined) {
        sendJson(res, 400, { ok: false, code: 'invalid', error: 'cardId must be a non-empty string' })
        return
      }
      if (!loadCardLibrary(CARDS_DIR, {}).has(cardId)) {
        sendJson(res, 400, { ok: false, code: 'unknown-card', error: `no card "${cardId}"` })
        return
      }
      const written = setDefaultCardId(CARDS_DIR, cardId, ctx.logger ?? {})
      sendJson(res, 200, { ok: true, defaultCard: cardId, written })
    },
  }))

  // Diagnostic. Distinguishes "the binding code never ran" from "it ran but the
  // card's text did not reach the model", which no amount of reading the
  // transcript can settle.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/status`,
    handler: (req, res) => {
      if (!guard(req, res)) return
      sendJson(res, 200, {
        ok: true,
        cardsDir: CARDS_DIR,
        sessionOverrides: readSessionOverrides(CARDS_DIR, {}),
        ...librarySnapshot(),
        agentsAtLoad: diag.agentsAtLoad,
        subscribed: diag.subscribed,
        listenerCalls: diag.listenerCalls,
        injectCallbacks: diag.injectCallbacks,
        sectionsRegistered: diag.sectionsRegistered,
        orderResolved: diag.orderResolved,
        bindErrors: diag.bindErrors,
        boundCount: diag.bound.size,
        boundAgents: [...diag.bound].map(([agentId, bound]) => ({ agentId, ...bound })),
        assembles: diag.assembles,
      })
    },
  }))
}

/**
 * Subscribe to agent lifecycle and bind the active card to each new agent.
 * @param {import('@deepseek-ai/cordis').Context} ctx - context owning the subscription.
 */
function subscribe(ctx) {
  diag.subscribed = true
  ctx.on('agent/created', ({ agent }) => {
    diag.listenerCalls += 1
    try {
      bindCard(agent, ctx.logger ?? {})
    } catch (error) {
      // A card must never veto agent creation. agent/created listeners are
      // already isolated by the registry, but binding has its own failure modes.
      recordError(error)
      ctx.logger?.warn?.(`could not bind card: ${String(error)}`)
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    diag.bound.delete(agent.id)
    const registration = diag.registrations.get(agent.id)
    diag.registrations.delete(agent.id)
    if (registration === undefined) return
    try { registration.disposeSection?.() } catch (error) { recordError(error) }
    try { void registration.fiber?.dispose?.() } catch (error) { recordError(error) }
  })

  // Waterfall: observe the prompt actually assembled for one model step. This
  // is the only place that can distinguish "our section is in the prompt" from
  // "our section was registered and then dropped".
  ctx.on('system-prompt/assemble', (assembly, _context, next) => {
    try {
      const index = assembly.sections.findIndex(section => section.name === SECTION_NAME)
      diag.assembles.unshift({
        totalSections: assembly.sections.length,
        sectionNames: assembly.sections.map(section => section.name),
        ourIndex: index,
        ourChars: index === -1 ? 0 : assembly.sections[index].text.length,
      })
      if (diag.assembles.length > 3) diag.assembles.length = 3
    } catch (error) {
      recordError(error)
    }
    return next()
  })
}

/**
 * Activate the host half.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 */
export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    registerRoutes(webServer, ctx)
  } else {
    // A terminal-only profile never provides a Web surface; register once one
    // appears instead of waiting on a service that will never arrive.
    ctx.inject(['webServer'], (sub) => registerRoutes(sub.webServer, sub))
  }

  const logger = ctx.logger ?? {}
  const bindExisting = (agents) => {
    try {
      for (const agent of agents.list()) bindCard(agent, logger)
    } catch (error) {
      recordError(error)
    }
  }

  const agents = ctx.get('agents')
  if (agents === undefined) {
    diag.agentsAtLoad = 'absent'
    ctx.inject(['agents'], (sub) => {
      diag.agentsAtLoad = 'injected'
      bindExisting(sub.agents)
    })
  } else {
    diag.agentsAtLoad = 'present'
    bindExisting(agents)
  }

  subscribe(ctx)
}
