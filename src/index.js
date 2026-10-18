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
import { applyBudget, renderCard, text, loadCardLibrary, readDefaultCardId, readSessionOverrides, resolveCardId, renderCardById } from './cards.js'

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
  /** The fiber owning each agent's section registration, for disposal. */
  fibers: new Map(),
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
function bindCard(agent, logger) {
  const resolved = resolveCardId(CARDS_DIR, agent.id, logger)
  if (resolved === undefined) return
  const rendered = renderCardById(CARDS_DIR, resolved.cardId, logger)
  if (rendered === undefined) return
  const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
    // Recorded HERE, not after inject() returns. inject() may fire its callback
    // later or never, so a flag set outside would claim a registration that did
    // not happen - exactly the conflation this diagnostic exists to avoid.
    diag.injectCallbacks += 1
    try {
      scope.systemPrompt.section({
        name: SECTION_NAME,
        order: resolveOrder(scope.systemPrompt),
        text: rendered.text,
      })
      diag.sectionsRegistered += 1
      diag.bound.set(agent.id, {
        card: rendered.id,
        name: rendered.name,
        source: resolved.source,
        chars: rendered.text.length,
        tokens: rendered.tokens,
        maxTokens: rendered.maxTokens,
        truncated: rendered.truncated,
      })
    } catch (error) {
      recordError(error)
      logger.warn?.(`section() failed for agent ${agent.id}: ${String(error)}`)
    }
  })
  diag.fibers.set(agent.id, fiber)
}

/**
 * Register this plugin's HTTP routes on a Web surface.
 * @param {{ register: (route: object) => () => void }} webServer - the Web server service.
 * @param {import('@deepseek-ai/cordis').Context} fiber - context owning the registration's lifetime.
 */
function registerRoutes(webServer, fiber) {
  fiber.effect(() => webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/ping`,
    handler: (req, res) => {
      if (!guard(req, res)) return
      sendJson(res, 200, { ok: true, plugin: name, version: '0.0.1' })
    },
  }))

  // Spike diagnostic. Distinguishes "the binding code never ran" from "it ran
  // but the card's text did not reach the model", which no amount of reading
  // the transcript can settle.
  fiber.effect(() => webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/status`,
    handler: (req, res) => {
      if (!guard(req, res)) return
      const cards = [...loadCardLibrary(CARDS_DIR, {})].map(([id, card]) => {
        const budgeted = applyBudget(renderCard(card), card, id, {})
        return {
          id,
          name: text(card.name) ?? null,
          chars: budgeted.text.length,
          tokens: budgeted.tokens,
          maxTokens: budgeted.maxTokens,
          truncated: budgeted.truncated,
        }
      })
      sendJson(res, 200, {
        ok: true,
        cardsDir: CARDS_DIR,
        defaultCard: readDefaultCardId(CARDS_DIR) ?? null,
        sessionOverrides: readSessionOverrides(CARDS_DIR, {}),
        cards,
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
    const fiber = diag.fibers.get(agent.id)
    diag.fibers.delete(agent.id)
    try {
      void fiber?.dispose?.()
    } catch (error) {
      recordError(error)
    }
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
