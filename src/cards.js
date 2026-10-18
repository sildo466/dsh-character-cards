/**
 * The .dshcd card format: validating, rendering, and budgeting a card.
 *
 * Every function takes the library directory it operates on rather than reading
 * a module-level constant, so tests drive real files in a temp directory while
 * the host passes its own resolved path.
 * @module dsh-character-cards/cards
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** @typedef {{ warn?: (message: string) => void }} Logger */

/** Card format version this build understands. */
export const CARD_VERSION = 1

/** Extension of a card definition file. */
export const CARD_EXTENSION = '.dshcd'

/**
 * Characters per token used for the budget estimate.
 *
 * A rough stand-in, not a tokenizer. Measured against the example cards: 454
 * chars read as roughly 152 tokens and 551 as 184, i.e. a ratio near 3 for this
 * mostly-CJK text. The figure a card author sees is therefore an estimate, and
 * truncation happens on the estimate's terms.
 */
export const CHARS_PER_TOKEN = 3

/** Budget assumed when a card declares none. */
export const DEFAULT_MAX_TOKENS = 400

/**
 * Read one scalar field, or undefined when it is absent or not usable text.
 * @param {unknown} value - the raw field.
 * @returns {string | undefined} the trimmed text.
 */
export function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
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
export function renderCard(card) {
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
export function validateCard(value, label, logger) {
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
export function applyBudget(rendered, card, cardId, logger) {
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

/** Filename of the global default card pointer. */
export const DEFAULT_POINTER_NAME = 'default'

/** Filename of the per-session override table. */
export const SESSION_OVERRIDES_NAME = 'sessions.json'

/**
 * Read a text file, treating absence as "no value" rather than an error.
 * @param {string} path - file to read.
 * @param {Logger} logger - logger for real failures.
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
 * @param {Logger} logger - logger for failures.
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
 * Load every card in a library directory.
 *
 * A card's identity is its own `id` field and the filename is only a fallback,
 * so renaming a file never changes which card a session points at.
 * @param {string} dir - library directory.
 * @param {Logger} logger - logger for failures.
 * @returns {Map<string, Record<string, unknown>>} card id -> card, in filename order.
 */
export function loadCardLibrary(dir, logger) {
  const cards = new Map()
  let names
  try {
    names = readdirSync(dir)
  } catch (error) {
    if (error && error.code !== 'ENOENT') logger.warn?.(`cannot list ${dir}: ${String(error)}`)
    return cards
  }
  for (const name of names.filter(entry => entry.endsWith(CARD_EXTENSION)).sort()) {
    const parsed = readJsonFile(join(dir, name), logger)
    // A file that could not be read or parsed was already reported once by
    // readJsonFile; re-validating the undefined it returned would warn twice
    // for one bad file, so step over it the way readSessionOverrides does.
    if (parsed === undefined) continue
    const card = validateCard(parsed, name, logger)
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
 * @param {string} dir - library directory.
 * @returns {string | undefined} the id, or undefined when unset.
 */
export function readDefaultCardId(dir) {
  const raw = readTextFile(join(dir, DEFAULT_POINTER_NAME), {})
  const id = raw === undefined ? undefined : raw.trim()
  return id === undefined || id.length === 0 ? undefined : id
}

/**
 * Point the global default at one card.
 * @param {string} dir - library directory.
 * @param {string} cardId - the card to default to.
 * @param {Logger} logger - logger for failures.
 * @returns {boolean} whether the pointer was written.
 */
export function setDefaultCardId(dir, cardId, logger) {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, DEFAULT_POINTER_NAME), `${cardId}\n`)
    return true
  } catch (error) {
    logger.warn?.(`cannot write ${join(dir, DEFAULT_POINTER_NAME)}: ${String(error)}`)
    return false
  }
}

/**
 * Read the per-session override table.
 * @param {string} dir - library directory.
 * @param {Logger} logger - logger for failures.
 * @returns {Record<string, string>} session id -> card id.
 */
export function readSessionOverrides(dir, logger) {
  const value = readJsonFile(join(dir, SESSION_OVERRIDES_NAME), logger)
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    logger.warn?.(`${join(dir, SESSION_OVERRIDES_NAME)}: expected an object mapping session id to card id`)
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
 * Write or clear one session's override, preserving the others.
 * @param {string} dir - library directory.
 * @param {string} sessionId - the agent's shared agent/session id.
 * @param {string | null} cardId - the card to pin, or null to clear the override.
 * @param {Logger} logger - logger for failures.
 * @returns {boolean} whether the table was written.
 */
export function setSessionOverride(dir, sessionId, cardId, logger) {
  const overrides = readSessionOverrides(dir, logger)
  if (cardId === null) delete overrides[sessionId]
  else overrides[sessionId] = cardId
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, SESSION_OVERRIDES_NAME), `${JSON.stringify(overrides, null, 2)}\n`)
    return true
  } catch (error) {
    logger.warn?.(`cannot write ${join(dir, SESSION_OVERRIDES_NAME)}: ${String(error)}`)
    return false
  }
}

/**
 * Choose the card for one session: its override, else the global default.
 *
 * A pointer that names a card the library does not contain is reported and
 * stepped over rather than silently unbinding the session.
 * @param {string} dir - library directory.
 * @param {string} sessionId - the agent's shared agent/session id.
 * @param {Logger} logger - logger for failures.
 * @returns {{ cardId: string, source: string } | undefined} the chosen id and
 *   where it came from, or undefined when unset.
 */
export function resolveCardId(dir, sessionId, logger) {
  const library = loadCardLibrary(dir, logger)
  const overrides = readSessionOverrides(dir, logger)
  const candidates = [
    [overrides[sessionId], 'session override'],
    [readDefaultCardId(dir), 'default pointer'],
  ]
  for (const [id, source] of candidates) {
    if (id === undefined) continue
    if (!library.has(id)) {
      logger.warn?.(`${source} names card "${id}", which is not in ${dir}`)
      continue
    }
    return { cardId: id, source }
  }
  return undefined
}

/**
 * Render one library card by id, with its budget applied.
 * @param {string} dir - library directory.
 * @param {string} cardId - card to render.
 * @param {Logger} logger - logger for failures.
 * @returns {{ id: string, name: string, text: string, tokens: number, maxTokens: number, truncated: boolean } | undefined}
 *   the rendered card, or undefined when the library lacks it.
 */
export function renderCardById(dir, cardId, logger) {
  const card = loadCardLibrary(dir, logger).get(cardId)
  if (card === undefined) {
    logger.warn?.(`card "${cardId}" is not in ${dir}`)
    return undefined
  }
  const budgeted = applyBudget(renderCard(card), card, cardId, logger)
  return { id: cardId, name: text(card.name) ?? cardId, ...budgeted }
}

/**
 * Summarize every card for a picker UI.
 * @param {string} dir - library directory.
 * @param {Logger} logger - logger for failures.
 * @returns {Array<{ id: string, name: string | null, description: string | null, tokens: number, maxTokens: number, truncated: boolean }>}
 *   one entry per card, in filename order.
 */
export function listCardSummaries(dir, logger) {
  return [...loadCardLibrary(dir, logger)].map(([id, card]) => {
    const budgeted = applyBudget(renderCard(card), card, id, logger)
    return {
      id,
      name: text(card.name) ?? null,
      description: text(card.description) ?? null,
      chars: budgeted.text.length,
      tokens: budgeted.tokens,
      maxTokens: budgeted.maxTokens,
      truncated: budgeted.truncated,
    }
  })
}
