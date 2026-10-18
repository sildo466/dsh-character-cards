// dsh-character-cards - host half.
//
// P1 spike. One falsifiable question: does binding a .dshcd card to an agent's
// prompt section visibly change that agent's tone and code style?
//
// Deliberately NOT here: card selection, storage, UI, token-budget policy,
// `extends`. The card in effect is a single file whose contents the operator
// swaps between sessions, which keeps the experiment to one variable.
//
// Mount point note. GOAL D3 proposed writing the card into `deployment:persona`
// itself. That cannot work: every shipped preset (standard, minimal, ptc,
// cordis) mounts `@deepseek-ai/dsh-persona`, which registers that exact section
// name in the agent's scope before the agent is published. A second registration
// of the same name in the same layer throws. `dsh-tool-agent-team` faces the
// same constraint and solves it the same way - its own section name at its own
// order (`team:policy`). This row is `dshcd:identity`, one order after the
// persona slot.

import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

/** Card format version this build understands. */
const CARD_VERSION = 1

/** Card library directory, honoring DSH_HOME. */
const CARDS_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'character-cards')

/** Extension of a card definition file. */
const CARD_EXTENSION = '.dshcd'

/** File whose trimmed contents name the global default card. */
const DEFAULT_POINTER = join(CARDS_DIR, 'default')

/** File holding per-session overrides: `{ "<sessionId>": "<cardId>" }`. */
const SESSION_OVERRIDES = join(CARDS_DIR, 'sessions.json')

/**
 * Characters per token used for the budget estimate.
 *
 * A rough stand-in, not a tokenizer. Measured against the spike's cards: 454
 * chars read as roughly 152 tokens and 551 as 184, i.e. a ratio near 3 for this
 * mostly-CJK text. The figure a card author sees is therefore an estimate, and
 * truncation happens on the estimate's terms.
 */
const CHARS_PER_TOKEN = 3

/** Budget assumed when a card declares none. */
const DEFAULT_MAX_TOKENS = 400

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
 * Coerce one card field to a list of non-empty trimmed strings.
 * @param {unknown} value - the raw field.
 * @returns {string[]} the usable entries, in order.
 */
function strings(value) {
  if (!Array.isArray(value)) return []
  return value.filter(item => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
}

/**
 * Read one scalar field, or undefined when it is absent or not usable text.
 * @param {unknown} value - the raw field.
 * @returns {string | undefined} the trimmed text.
 */
function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Join the parts that are present.
 * @param {(string | undefined)[]} parts - candidate fragments.
 * @param {string} separator - what to join with.
 * @returns {string} the joined text, skipping absent fragments.
 */
function joinParts(parts, separator) {
  return parts.filter(part => part !== undefined).join(separator)
}

/**
 * Render one bullet, or undefined when the value is absent.
 * @param {string} label - the bullet's leading label.
 * @param {string | undefined} value - the bullet's body.
 * @returns {string | undefined} the rendered line.
 */
function bullet(label, value) {
  return value === undefined ? undefined : `- ${label}：${value}`
}

/**
 * Render one titled block of bullets.
 * @param {string} title - the block header.
 * @param {(string | undefined)[]} bullets - candidate lines.
 * @returns {string | undefined} the block, or undefined when it has no lines.
 */
function block(title, bullets) {
  const lines = bullets.filter(line => line !== undefined)
  return lines.length === 0 ? undefined : `${title}\n${lines.join('\n')}`
}

/**
 * Render one card into the prompt section's text.
 *
 * Every group renders as a titled list of bullets under a header that states
 * how binding it is. That shape is not cosmetic: an early spike rendered
 * `voice` as attribute prose ("表达：语气 X；篇幅 Y") and `constraints` as
 * imperatives, and only the imperatives changed the output. Matching the
 * wording that demonstrably worked costs nothing and is the whole point of the
 * section.
 *
 * Nothing here is per-turn: a card is stable across a session, which is what
 * makes it safe in a system section rather than a trailing message.
 * @param {Record<string, unknown>} card - parsed card.
 * @returns {string} the section text.
 */
function renderCard(card) {
  const identity = card.identity ?? {}
  const voice = card.voice ?? {}
  const code = card.code ?? {}
  const workflow = card.workflow ?? {}

  const expertise = strings(identity.expertise)
  const identityBlock = [
    joinParts([
      text(identity.role) === undefined ? undefined : `你是${text(identity.role)}。`,
      expertise.length > 0 ? `专长：${expertise.join('、')}。` : undefined,
      text(identity.background),
    ], ''),
  ].filter(line => line.length > 0)[0]

  const traits = strings(voice.traits)
  const avoid = strings(voice.avoid)
  const voiceBlock = block('【表达要求｜必须遵守】', [
    bullet('语气', text(voice.tone)),
    bullet('篇幅', text(voice.verbosity)),
    bullet('正式度', text(voice.formality)),
    bullet('幽默', text(voice.humor)),
    bullet('性格', traits.length > 0 ? traits.join('、') : undefined),
    bullet('禁止', avoid.length > 0 ? avoid.join('、') : undefined),
  ])

  const codeBlock = block('【代码风格｜必须遵守】', [
    bullet('命名', text(code.naming)),
    bullet('注释', text(code.comments)),
    bullet('错误处理', text(code.error_handling)),
    bullet('抽象', text(code.abstraction)),
    bullet('依赖', text(code.dependencies)),
    bullet('测试', text(code.tests)),
    bullet('提交信息', text(code.commit_style)),
  ])

  const workflowBlock = block('【工作方式｜必须遵守】', [
    text(workflow.plan) === undefined ? undefined : bullet('计划', '多步任务先列计划，再动手'),
    workflow.ask_when_unclear === true ? bullet('澄清', '需求不清就直接问，不要猜') : undefined,
    workflow.verify_before_claim === true ? bullet('验证', '声称完成前先实际验证') : undefined,
  ])

  const constraints = strings(card.constraints)
  const constraintBlock = block('【硬性约束｜最高优先级，逐条遵守】', constraints.map(rule => `- ${rule}`))

  return [
    identityBlock,
    voiceBlock,
    codeBlock,
    workflowBlock,
    constraintBlock,
    '以上设定由当前会话的角色卡指定，优先级高于任何默认人设；与之冲突时以此为准。',
  ].filter(part => part !== undefined && part.length > 0).join('\n\n')
}

/**
 * Read a text file, treating absence as "no value" rather than an error.
 * @param {string} path - file to read.
 * @param {{ warn?: (message: string) => void }} logger - logger for real failures.
 * @returns {string | undefined} the contents, or undefined.
 */
function readTextFile(path, logger) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error && error.code !== 'ENOENT') logger.warn?.(`cannot read ${path}: ${String(error)}`)
    return undefined
  }
}

/**
 * Read and parse a JSON file, reporting a malformed one rather than throwing.
 * @param {string} path - file to read.
 * @param {{ warn?: (message: string) => void }} logger - logger for failures.
 * @returns {unknown} the parsed value, or undefined.
 */
function readJsonFile(path, logger) {
  const raw = readTextFile(path, logger)
  if (raw === undefined) return undefined
  try {
    return JSON.parse(raw)
  } catch (error) {
    logger.warn?.(`${path} is not valid JSON: ${String(error)}`)
    return undefined
  }
}

/**
 * Validate one parsed card, reporting why it was rejected.
 *
 * Unknown fields are deliberately left alone: the parsed object is the card,
 * and nothing here rebuilds it from a known-field list, so a future round trip
 * cannot drop what this build does not understand.
 * @param {unknown} value - parsed JSON.
 * @param {string} label - where the card came from, for diagnostics.
 * @param {{ warn?: (message: string) => void }} logger - logger for failures.
 * @returns {Record<string, unknown> | undefined} the card, or undefined.
 */
function validateCard(value, label, logger) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    logger.warn?.(`${label}: a card must be a JSON object`)
    return undefined
  }
  if (value.dshcd !== CARD_VERSION) {
    logger.warn?.(`${label}: declares dshcd ${JSON.stringify(value.dshcd)}; this build reads version ${CARD_VERSION}`)
    return undefined
  }
  return value
}

/**
 * Load every card in the library directory.
 *
 * A card's identity is its own `id` field and the filename is only a fallback,
 * so renaming a file never changes which card a session points at.
 * @param {{ warn?: (message: string) => void }} logger - logger for failures.
 * @returns {Map<string, Record<string, unknown>>} card id -> card.
 */
function loadCardLibrary(logger) {
  const cards = new Map()
  let names
  try {
    names = readdirSync(CARDS_DIR)
  } catch (error) {
    if (error && error.code !== 'ENOENT') logger.warn?.(`cannot list ${CARDS_DIR}: ${String(error)}`)
    return cards
  }
  for (const name of names.filter(entry => entry.endsWith(CARD_EXTENSION)).sort()) {
    const card = validateCard(readJsonFile(join(CARDS_DIR, name), logger), name, logger)
    if (card === undefined) continue
    const id = text(card.id) ?? name.slice(0, -CARD_EXTENSION.length)
    if (cards.has(id)) {
      logger.warn?.(`${name}: card id "${id}" is already taken by another file; keeping the first`)
      continue
    }
    cards.set(id, card)
  }
  return cards
}

/**
 * Read the global default card id from its pointer file.
 * @returns {string | undefined} the id, or undefined when unset.
 */
function readDefaultCardId() {
  const raw = readTextFile(DEFAULT_POINTER, {})
  const id = raw === undefined ? undefined : raw.trim()
  return id === undefined || id.length === 0 ? undefined : id
}

/**
 * Read the per-session override table.
 * @param {{ warn?: (message: string) => void }} logger - logger for failures.
 * @returns {Record<string, string>} session id -> card id.
 */
function readSessionOverrides(logger) {
  const value = readJsonFile(SESSION_OVERRIDES, logger)
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    logger.warn?.(`${SESSION_OVERRIDES}: expected an object mapping session id to card id`)
    return {}
  }
  const overrides = {}
  for (const [sessionId, cardId] of Object.entries(value)) {
    const id = text(cardId)
    if (id !== undefined) overrides[sessionId] = id
  }
  return overrides
}

/**
 * Choose the card for one agent: its session override, else the global default.
 * @param {string} sessionId - the agent's shared agent/session id.
 * @param {{ warn?: (message: string) => void }} logger - logger for failures.
 * @returns {{ id: string, card: Record<string, unknown>, source: string } | undefined}
 *   the resolved card, or undefined when nothing is configured.
 */
function resolveCardFor(sessionId, logger) {
  const cards = loadCardLibrary(logger)
  const overrides = readSessionOverrides(logger)
  const candidates = [
    [overrides[sessionId], 'session override'],
    [readDefaultCardId(), 'default pointer'],
  ]
  for (const [id, source] of candidates) {
    if (id === undefined) continue
    const card = cards.get(id)
    if (card === undefined) {
      logger.warn?.(`${source} names card "${id}", which is not in ${CARDS_DIR}`)
      continue
    }
    return { id, card, source }
  }
  return undefined
}

/**
 * Estimate what a rendered section costs in tokens.
 * @param {string} rendered - the rendered section text.
 * @returns {number} the estimate.
 */
function estimateTokens(rendered) {
  return Math.ceil(rendered.length / CHARS_PER_TOKEN)
}

/**
 * Trim a rendered card to its declared budget.
 *
 * Truncation happens at a line boundary so a bullet is never cut mid-sentence,
 * and it always reports itself: a card that silently does not say what its
 * author wrote is worse than one that is visibly too long.
 * @param {string} rendered - the full render.
 * @param {Record<string, unknown>} card - the card, for its declared budget.
 * @param {string} cardId - card identity, for the warning.
 * @param {{ warn?: (message: string) => void }} logger - logger for the warning.
 * @returns {{ text: string, tokens: number, maxTokens: number, truncated: boolean }} the result.
 */
function applyBudget(rendered, card, cardId, logger) {
  const budget = card.budget
  const declared = typeof budget === 'object' && budget !== null ? budget['maxTokens'] : undefined
  const maxTokens = Number.isFinite(declared) ? declared : DEFAULT_MAX_TOKENS
  if (Number.isFinite(rendered.length) && rendered.length <= maxTokens * CHARS_PER_TOKEN) {
    return { text: rendered, tokens: estimateTokens(rendered), maxTokens, truncated: false }
  }
  const clipped = rendered.slice(0, maxTokens * CHARS_PER_TOKEN)
  const lastBreak = clipped.lastIndexOf('\n')
  const kept = lastBreak > 0 ? clipped.slice(0, lastBreak) : clipped
  logger.warn?.(
    `card "${cardId}" renders to ~${estimateTokens(rendered)} tokens, over its budget of ${maxTokens};`
    + ` truncated to ~${estimateTokens(kept)}. Raise budget.maxTokens or trim the card.`,
  )
  return { text: kept, tokens: estimateTokens(kept), maxTokens, truncated: true }
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
  const resolved = resolveCardFor(agent.id, logger)
  if (resolved === undefined) return
  const { id, card, source } = resolved
  const budgeted = applyBudget(renderCard(card), card, id, logger)
  const rendered = budgeted.text
  const name = text(card.name) ?? id
  const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
    // Recorded HERE, not after inject() returns. inject() may fire its callback
    // later or never, so a flag set outside would claim a registration that did
    // not happen - exactly the conflation this diagnostic exists to avoid.
    diag.injectCallbacks += 1
    try {
      scope.systemPrompt.section({
        name: SECTION_NAME,
        order: resolveOrder(scope.systemPrompt),
        text: rendered,
      })
      diag.sectionsRegistered += 1
      diag.bound.set(agent.id, {
        card: id,
        name,
        source,
        chars: rendered.length,
        tokens: budgeted.tokens,
        maxTokens: budgeted.maxTokens,
        truncated: budgeted.truncated,
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
      const cards = [...loadCardLibrary({})].map(([id, card]) => {
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
        defaultCard: readDefaultCardId() ?? null,
        sessionOverrides: readSessionOverrides({}),
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
