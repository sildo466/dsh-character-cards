/**
 * The .dshcd card format: validating, rendering, and measuring a card.
 *
 * Every function takes the library directory it operates on rather than reading
 * a module-level constant, so tests drive real files in a temp directory while
 * the host passes its own resolved path.
 * @module dsh-character-cards/cards
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** @typedef {{ warn?: (message: string) => void }} Logger */

/** Card format version this build understands. */
export const CARD_VERSION = 1

/** Extension of a card definition file. */
export const CARD_EXTENSION = '.dshcd'

/** Characters a card id may contain. It becomes a filename, so this is also
 * what keeps a card from being written outside the library directory. */
const CARD_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** Longest accepted card id. */
const MAX_CARD_ID_LENGTH = 64

/**
 * Characters per token used for the size estimate.
 *
 * A rough stand-in, not a tokenizer. Measured against the example cards: 454
 * chars read as roughly 152 tokens and 551 as 184, i.e. a ratio near 3 for this
 * mostly-CJK text. The figure a card author sees is therefore an estimate.
 */
export const CHARS_PER_TOKEN = 3

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
 * Measure a rendered card.
 *
 * This reports and never trims. The old budget truncated from the tail, and
 * rendering puts constraints and the precedence line there - so exceeding a
 * budget removed the part of a card most likely to change behaviour. The
 * figure is characters divided by CHARS_PER_TOKEN, an estimate rather than a
 * tokenizer, and it is shown as information rather than enforced (GOAL D11).
 * @param {string} rendered - the rendered section text.
 * @returns {{ chars: number, tokens: number }} the estimate.
 */
export function measure(rendered) {
  return { chars: rendered.length, tokens: Math.ceil(rendered.length / CHARS_PER_TOKEN) }
}

/** Rules beyond this many start getting ignored under task pressure (GOAL D5). */
const MAX_RULE_COUNT = 12

/** A rule longer than this stops being a single checkable line (GOAL D5). */
const MAX_RULE_LENGTH = 60

/**
 * D5 advisories for one card. They are advice, never a refusal.
 * @param {Record<string, unknown>} card - the card.
 * @returns {Array<{ code: string, message: string }>} the warnings, in a stable order.
 */
export function cardWarnings(card) {
  const rules = Array.isArray(card.constraints)
    ? card.constraints.filter(rule => typeof rule === 'string' && rule.trim().length > 0)
    : []
  const warnings = []
  if (rules.length > MAX_RULE_COUNT) {
    warnings.push({
      code: 'too-many-rules',
      message: `硬性约束 ${rules.length} 条，建议 ≤ ${MAX_RULE_COUNT}。规则一多，模型在任务压力下会开始忽略。`,
    })
  }
  const longest = rules.reduce((worst, rule) => (rule.length > worst.length ? rule : worst), '')
  if (longest.length > MAX_RULE_LENGTH) {
    warnings.push({
      code: 'rule-too-long',
      message: `有一条约束 ${longest.length} 字，建议单行 ≤ ${MAX_RULE_LENGTH} 字。`,
    })
  }
  return warnings
}

/**
 * Check one parsed card and hand back the reason when it is not usable.
 * @param {unknown} value - parsed JSON.
 * @returns {{ card: Record<string, unknown> } | { error: string }} the card, or why not.
 */
export function inspectCard(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'a card must be a JSON object' }
  }
  if (value.dshcd !== CARD_VERSION) {
    return { error: `declares dshcd ${JSON.stringify(value.dshcd)}; this build reads version ${CARD_VERSION}` }
  }
  return { card: value }
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
  const inspected = inspectCard(value)
  if ('error' in inspected) {
    logger.warn?.(`${label}: ${inspected.error}`)
    return undefined
  }
  return inspected.card
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
 * Whether a value is usable as a card id, and therefore as a filename.
 * @param {unknown} value - candidate id.
 * @returns {boolean} true when safe.
 */
export function isValidCardId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_CARD_ID_LENGTH
    && CARD_ID_PATTERN.test(value)
}

/**
 * Path of one card file.
 * @param {string} dir - library directory.
 * @param {string} id - a valid card id.
 * @returns {string} the path.
 */
function cardPath(dir, id) {
  return join(dir, `${id}${CARD_EXTENSION}`)
}

/**
 * Whether one card file is present.
 * @param {string} dir - library directory.
 * @param {string} id - card id.
 * @returns {boolean} true when the file exists.
 */
export function cardExists(dir, id) {
  return isValidCardId(id) && existsSync(cardPath(dir, id))
}

/**
 * Read one card by id, returning the parsed object exactly as stored.
 *
 * The editor needs the whole object, not the summary: it clones this and edits
 * only the fields it understands, so anything this build does not know survives
 * a save (GOAL D6).
 * @param {string} dir - library directory.
 * @param {string} id - card id.
 * @param {Logger} logger - logger for failures.
 * @returns {Record<string, unknown> | undefined} the card, or undefined.
 */
export function readCardFile(dir, id, logger) {
  if (!isValidCardId(id)) return undefined
  const parsed = readJsonFile(cardPath(dir, id), logger)
  // An absent or unreadable file has already reported itself where that was
  // worth doing. Handing its undefined to validateCard would warn a second
  // time, and about something that is not a format problem at all - the same
  // double-warning loadCardLibrary steps over for the same reason.
  if (parsed === undefined) return undefined
  return validateCard(parsed, id, logger)
}

/**
 * Write one card atomically.
 *
 * The id is checked first because it is the filename. The write lands in a
 * temporary neighbour and is renamed into place, so a crash mid-write cannot
 * leave half a card where a whole one used to be.
 * @param {string} dir - library directory.
 * @param {unknown} card - the card to write.
 * @param {Logger} logger - logger for failures.
 * @returns {{ ok: true, id: string } | { ok: false, code: string, error: string }} the outcome.
 */
export function writeCardFile(dir, card, logger) {
  const inspected = inspectCard(card)
  if ('error' in inspected) return { ok: false, code: 'invalid', error: inspected.error }

  const id = text(inspected.card.id)
  if (id === undefined || !isValidCardId(id)) {
    return { ok: false, code: 'invalid-id', error: 'id must match ^[a-z0-9][a-z0-9-]*$ and be at most 64 characters' }
  }

  const target = cardPath(dir, id)
  const temporary = `${target}.tmp`
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(inspected.card, null, 2)}\n`)
    renameSync(temporary, target)
    return { ok: true, id }
  } catch (error) {
    logger.warn?.(`cannot write ${target}: ${String(error)}`)
    return { ok: false, code: 'write-failed', error: String(error) }
  }
}

/**
 * Delete one card file.
 * @param {string} dir - library directory.
 * @param {string} id - card id.
 * @param {Logger} logger - logger for failures.
 * @returns {{ ok: true } | { ok: false, code: string, error: string }} the outcome.
 */
export function deleteCardFile(dir, id, logger) {
  if (!isValidCardId(id)) {
    return { ok: false, code: 'invalid-id', error: 'id must match ^[a-z0-9][a-z0-9-]*$' }
  }
  try {
    unlinkSync(cardPath(dir, id))
    return { ok: true }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, code: 'not-found', error: `no card "${id}"` }
    logger.warn?.(`cannot delete ${cardPath(dir, id)}: ${String(error)}`)
    return { ok: false, code: 'delete-failed', error: String(error) }
  }
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
 * Remove the global default pointer.
 * @param {string} dir - library directory.
 * @param {Logger} logger - logger for failures.
 * @returns {boolean} whether the pointer is gone (absent counts as success).
 */
export function clearDefaultCardId(dir, logger) {
  try {
    unlinkSync(join(dir, DEFAULT_POINTER_NAME))
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    logger.warn?.(`cannot clear ${join(dir, DEFAULT_POINTER_NAME)}: ${String(error)}`)
    return false
  }
}

/**
 * Read the per-session override table.
 *
 * A value is a card id, or null for a session that explicitly takes no card.
 * That null is not the same as an absent entry: absent means "follow the global
 * default", which is what a session does until someone says otherwise. Dropping
 * nulls here would collapse the two states into one.
 * @param {string} dir - library directory.
 * @param {Logger} logger - logger for failures.
 * @returns {Record<string, string | null>} session id -> card id, or null for none.
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
    if (cardId === null) {
      overrides[sessionId] = null
      continue
    }
    const id = text(cardId)
    if (id !== undefined) overrides[sessionId] = id
  }
  return overrides
}

/**
 * Write the override table back to disk.
 * @param {string} dir - library directory.
 * @param {Record<string, string | null>} overrides - the table to persist.
 * @param {Logger} logger - logger for failures.
 * @returns {boolean} whether the table was written.
 */
function writeOverrides(dir, overrides, logger) {
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
 * Pin one session to a card, or to no card at all, preserving every other entry.
 * @param {string} dir - library directory.
 * @param {string} sessionId - the agent's shared agent/session id.
 * @param {string | null} cardId - a card to pin, or null to take no card.
 * @param {Logger} logger - logger for failures.
 * @returns {boolean} whether the table was written.
 */
export function setSessionOverride(dir, sessionId, cardId, logger) {
  const overrides = readSessionOverrides(dir, logger)
  overrides[sessionId] = cardId
  return writeOverrides(dir, overrides, logger)
}

/**
 * Drop one session's entry so it follows the global default again.
 * @param {string} dir - library directory.
 * @param {string} sessionId - the agent's shared agent/session id.
 * @param {Logger} logger - logger for failures.
 * @returns {boolean} whether the table was written.
 */
export function clearSessionOverride(dir, sessionId, logger) {
  const overrides = readSessionOverrides(dir, logger)
  delete overrides[sessionId]
  return writeOverrides(dir, overrides, logger)
}

/**
 * Turn every pin naming one card into an explicit "no card".
 *
 * The explicit null matters: dropping the entry would make those sessions
 * follow the default again, which is not what deleting their card means.
 * @param {string} dir - library directory.
 * @param {string} cardId - the card being deleted.
 * @param {Logger} logger - logger for failures.
 * @returns {{ ok: boolean, detached: number }} whether the write landed and how many entries changed.
 */
export function detachOverridesForCard(dir, cardId, logger) {
  const overrides = readSessionOverrides(dir, logger)
  let detached = 0
  for (const [sessionId, value] of Object.entries(overrides)) {
    if (value === cardId) {
      overrides[sessionId] = null
      detached += 1
    }
  }
  if (detached === 0) return { ok: true, detached: 0 }
  return { ok: writeOverrides(dir, overrides, logger), detached }
}

/**
 * Choose the card for one session: its own entry, else the global default.
 *
 * Three outcomes, and a null cardId is not the same as `undefined`: null says
 * this session takes no card even though a default exists, while `undefined`
 * says nothing is configured at all.
 * @param {string} dir - library directory.
 * @param {string} sessionId - the agent's shared agent/session id.
 * @param {Logger} logger - logger for failures.
 * @returns {{ cardId: string | null, source: string } | undefined} the choice, or
 *   undefined when unset.
 */
export function resolveCardId(dir, sessionId, logger) {
  const library = loadCardLibrary(dir, logger)
  const overrides = readSessionOverrides(dir, logger)

  if (Object.hasOwn(overrides, sessionId)) {
    const pinned = overrides[sessionId]
    if (pinned === null) return { cardId: null, source: 'session override' }
    if (library.has(pinned)) return { cardId: pinned, source: 'session override' }
    // A pin that names a card the library no longer holds is reported, and the
    // session falls back to the default the same way an unpinned one would.
    logger.warn?.(`session override names card "${pinned}", which is not in ${dir}`)
  }

  const fallback = readDefaultCardId(dir)
  if (fallback === undefined) return undefined
  if (!library.has(fallback)) {
    logger.warn?.(`default pointer names card "${fallback}", which is not in ${dir}`)
    return undefined
  }
  return { cardId: fallback, source: 'default pointer' }
}

/**
 * Render one library card by id.
 * @param {string} dir - library directory.
 * @param {string} cardId - card to render.
 * @param {Logger} logger - logger for failures.
 * @returns {{ id: string, name: string, text: string, chars: number, tokens: number } | undefined}
 *   the rendered card, or undefined when the library lacks it.
 */
export function renderCardById(dir, cardId, logger) {
  const card = loadCardLibrary(dir, logger).get(cardId)
  if (card === undefined) {
    logger.warn?.(`card "${cardId}" is not in ${dir}`)
    return undefined
  }
  const rendered = renderCard(card)
  return { id: cardId, name: text(card.name) ?? cardId, text: rendered, ...measure(rendered) }
}

/**
 * Summarize every card for a picker UI.
 * @param {string} dir - library directory.
 * @param {Logger} logger - logger for failures.
 * @returns {Array<{ id: string, name: string | null, description: string | null, chars: number, tokens: number }>}
 *   one entry per card, in filename order.
 */
export function listCardSummaries(dir, logger) {
  return [...loadCardLibrary(dir, logger)].map(([id, card]) => {
    const rendered = renderCard(card)
    return {
      id,
      name: text(card.name) ?? null,
      description: text(card.description) ?? null,
      ...measure(rendered),
    }
  })
}
