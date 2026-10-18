# P2 运行时切卡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 dsh 的一个 session 内点一下卡片选择器，下一轮回答就用新卡的语气和代码风格。

**Architecture:** 宿主半新增三个 loopback-only HTTP 路由与一个重绑函数；客户端半是一个自适应组件——slot 给它 `sessionId` 就按 session 切，没给就切全局默认。卡片格式逻辑抽进 `src/cards.js`（纯函数，目录作为显式参数），`src/index.js` 只留 Cordis 接线。

**Tech Stack:** 纯 JavaScript（无构建步骤）、Node 22 内建 `node --test`、Cordis 插件契约、React（客户端半，通过 `window.__ModuleLoader__`）。

## Global Constraints

- 纯 JS，无 TS / JSX / 打包器；客户端 React 只能用 `React.createElement`
- 客户端模块内 `inject` 为空；`package.json` 的 `dsh.client.inject` 才写包名（GOAL D7）
- 客户端半 `apply()` 全程 try/catch，依赖用前判空，失败静默降级
- 卡片路由**不依赖 Origin / Referer**；Origin 仅在存在时才校验（GOAL D8，桌面版不发）
- 所有新路由走 host/port 均为 loopback 的 `guard()`
- section 名固定为 `dshcd:identity`，**不得**使用 `PERSONA_SECTION`
- section order 必须由 `ORDER_CANDIDATES` 探测得出，不得写死枚举名
- 卡片解析顺序：`sessions.json[<sessionId>]` → `default` 指针 → 不绑
- 预算超限**必须告警**，不得静默截断
- 只对**已验证存在**的 slot key 调 `slots.register`（`docs/subsystems/slots.md:13`：未声明的 slot 会让注册失败）
- 提交信息描述 why 而非 what；工作区只做本地提交，不碰远程

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/cards.js` | **新建。** `.dshcd` 格式的全部逻辑：校验、渲染、预算、卡片库、解析顺序、覆盖持久化。纯函数，目录作为显式参数——所以测试直接造临时目录，不碰模块级常量 |
| `src/index.js` | **改。** 只留 Cordis 接线：guard、路由、`agent/created` 绑定、重绑、诊断状态 |
| `src/client.js` | **改。** 自适应切卡组件 |
| `test/cards.test.js` | **新建。** 卡片格式的单元测试 |
| `test/routes.test.js` | **新建。** 路由与重绑的测试（临时 `DSH_HOME` + 假 ctx） |
| `test/client.test.js` | **新建。** 客户端半的结构与模式判定测试 |
| `scripts/dryrun.mjs` | **改。** 加"绑 A → 重绑 B"的离线序列 |
| `package.json` | **改。** 加 `test` 脚本 |

拆分理由：`src/index.js` 现在约 500 行，混着纯格式逻辑和 Cordis 接线。P2 要给两者都写测试，而纯逻辑需要**目录作为参数**才能脱离模块级 `DSH_HOME` 测试。

---

### Task 1: 测试脚手架 + 抽出纯渲染与预算

**Files:**
- Create: `src/cards.js`
- Create: `test/cards.test.js`
- Modify: `package.json`（加 `test` 脚本）
- Modify: `src/index.js`（改为从 `cards.js` 导入）

**Interfaces:**
- Consumes: 无
- Produces:
  - `CARD_VERSION = 1`、`CHARS_PER_TOKEN = 3`、`DEFAULT_MAX_TOKENS = 400`、`CARD_EXTENSION = '.dshcd'`
  - `renderCard(card: object): string`
  - `applyBudget(rendered: string, card: object, cardId: string, logger: Logger): { text: string, tokens: number, maxTokens: number, truncated: boolean }`
  - `validateCard(value: unknown, label: string, logger: Logger): object | undefined`
  - `Logger = { warn?: (message: string) => void }`

- [ ] **Step 1: 加 test 脚本**

`package.json` 的 `scripts` 块（目前只有 `files`/`keywords` 等，无 `scripts`）加：

```json
  "scripts": {
    "test": "node --test"
  },
```

- [ ] **Step 2: 写失败的测试**

`test/cards.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyBudget, renderCard, validateCard } from '../src/cards.js'

/** Silences the warnings a test expects, and records them. */
function collector() {
  const warnings = []
  return { warnings, warn: (message) => warnings.push(message) }
}

test('renderCard turns every populated group into a titled bullet block', () => {
  const text = renderCard({
    identity: { role: '资深审阅者', expertise: ['后端'], background: '做过生产系统。' },
    voice: { tone: '直白', avoid: ['emoji'] },
    code: { naming: '描述性' },
    constraints: ['先说结论'],
  })
  assert.match(text, /^你是资深审阅者。专长：后端。做过生产系统。/)
  assert.match(text, /【表达要求｜必须遵守】\n- 语气：直白\n- 禁止：emoji/)
  assert.match(text, /【代码风格｜必须遵守】\n- 命名：描述性/)
  assert.match(text, /【硬性约束｜最高优先级，逐条遵守】\n- 先说结论/)
})

test('renderCard drops empty groups entirely and omits the workflow block when unset', () => {
  const text = renderCard({ identity: { role: 'x' } })
  assert.doesNotMatch(text, /【表达要求/)
  assert.doesNotMatch(text, /【代码风格/)
  assert.doesNotMatch(text, /【工作方式/)
  assert.doesNotMatch(text, /【硬性约束/)
})

test('renderCard always ends with the precedence line', () => {
  assert.match(renderCard({}), /优先级高于任何默认人设/)
})

test('applyBudget passes a card within budget through untouched', () => {
  const logger = collector()
  const result = applyBudget('short', { budget: { maxTokens: 400 } }, 'c', logger)
  assert.equal(result.text, 'short')
  assert.equal(result.truncated, false)
  assert.equal(result.maxTokens, 400)
  assert.deepEqual(logger.warnings, [])
})

test('applyBudget truncates at a line boundary and warns rather than staying silent', () => {
  const logger = collector()
  const rendered = `${'x'.repeat(20)}\n${'y'.repeat(20)}\n${'z'.repeat(20)}`
  const result = applyBudget(rendered, { budget: { maxTokens: 10 } }, 'big', logger)
  assert.equal(result.truncated, true)
  assert.equal(result.text, 'x'.repeat(20))
  assert.equal(logger.warnings.length, 1)
  assert.match(logger.warnings[0], /card "big" renders to ~\d+ tokens, over its budget of 10/)
})

test('applyBudget falls back to the default budget when the card declares none', () => {
  const result = applyBudget('short', {}, 'c', collector())
  assert.equal(result.maxTokens, 400)
})

test('validateCard rejects a non-object, a wrong version, and accepts a v1 card', () => {
  const logger = collector()
  assert.equal(validateCard('nope', 'a.dshcd', logger), undefined)
  assert.equal(validateCard(null, 'b.dshcd', logger), undefined)
  assert.equal(validateCard([], 'c.dshcd', logger), undefined)
  assert.equal(validateCard({ dshcd: 2 }, 'd.dshcd', logger), undefined)
  assert.equal(logger.warnings.length, 4)
  const card = { dshcd: 1, id: 'ok' }
  assert.equal(validateCard(card, 'e.dshcd', logger), card)
})

test('validateCard keeps unknown fields on the object it returns', () => {
  const card = { dshcd: 1, id: 'ok', futureField: { nested: true } }
  assert.equal(validateCard(card, 'f.dshcd', collector())?.futureField.nested, true)
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../src/cards.js'`

- [ ] **Step 4: 建 `src/cards.js`**

把 `src/index.js` 里现有的 `text`、`strings`、`joinParts`、`bullet`、`block`、`renderCard`、`estimateTokens`、`applyBudget`、`validateCard` 原样搬过来，改成 export，并把 `CARD_VERSION` / `CHARS_PER_TOKEN` / `DEFAULT_MAX_TOKENS` / `CARD_EXTENSION` 也 export。

```js
/**
 * The .dshcd card format: validating, rendering, and budgeting a card.
 *
 * Every function takes the library directory it operates on rather than reading
 * a module-level constant, so tests drive real files in a temp directory while
 * the host passes its own resolved path.
 * @module dsh-character-cards/cards
 */

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

// ... text(), strings(), joinParts(), bullet(), block(), renderCard(),
//     estimateTokens(), applyBudget(), validateCard() moved here verbatim,
//     each exported instead of module-private.
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS（8 个测试）

- [ ] **Step 6: `src/index.js` 改为导入**

删掉 `src/index.js` 里已经搬走的那些函数，改为：

```js
import { applyBudget, renderCard, validateCard, CARD_VERSION, CARD_EXTENSION, CHARS_PER_TOKEN, DEFAULT_MAX_TOKENS } from './cards.js'
```

保留 `CARDS_DIR`、`DEFAULT_POINTER`、`SESSION_OVERRIDES`、`SECTION_NAME`、`ORDER_CANDIDATES` 等宿主侧常量。

- [ ] **Step 7: 确认离线 dry-run 仍通过**

Run: `node scripts/dryrun.mjs`
Expected: 输出三行 `bound`，且 `session-truncated` 仍带截断告警

- [ ] **Step 8: Commit**

```bash
git add package.json src/cards.js src/index.js test/cards.test.js
git commit -m "refactor: split the card format out of the Cordis wiring

The format logic and the plugin wiring were sharing one 500-line file, and
only the wiring needs a Cordis context. Separating them lets the format be
tested against a temp directory instead of reaching for DSH_HOME, which is
what the P2 routes and the rebind path both need."
```

---

### Task 2: 卡片库、解析顺序、覆盖持久化

**Files:**
- Modify: `src/cards.js`
- Modify: `test/cards.test.js`

**Interfaces:**
- Consumes: `validateCard`、`renderCard`、`applyBudget`、`CARD_EXTENSION`（Task 1）
- Produces:
  - `DEFAULT_POINTER_NAME = 'default'`、`SESSION_OVERRIDES_NAME = 'sessions.json'`
  - `loadCardLibrary(dir: string, logger: Logger): Map<string, object>`
  - `readDefaultCardId(dir: string): string | undefined`
  - `readSessionOverrides(dir: string, logger: Logger): Record<string, string>`
  - `setSessionOverride(dir: string, sessionId: string, cardId: string | null, logger: Logger): boolean`
  - `resolveCardId(dir: string, sessionId: string, logger: Logger): { cardId: string, source: 'session override' | 'default pointer' } | undefined`
  - `renderCardById(dir: string, cardId: string, logger: Logger): { id: string, name: string, text: string, tokens: number, maxTokens: number, truncated: boolean } | undefined`
  - `listCardSummaries(dir: string, logger: Logger): Array<{ id: string, name: string | null, description: string | null, tokens: number, maxTokens: number, truncated: boolean }>`

- [ ] **Step 1: 写失败的测试**

追加到 `test/cards.test.js`：

```js
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listCardSummaries, loadCardLibrary, readDefaultCardId, readSessionOverrides,
  renderCardById, resolveCardId, setSessionOverride,
} from '../src/cards.js'

/** A temp library directory holding the given cards, keyed by filename. */
function library(files) {
  const dir = mkdtempSync(join(tmpdir(), 'dshcd-'))
  for (const [name, card] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof card === 'string' ? card : JSON.stringify(card))
  }
  return dir
}

const TERSE = { dshcd: 1, id: 'terse', name: '简短审阅者', identity: { role: '审阅者' }, budget: { maxTokens: 400 } }
const TEACHER = { dshcd: 1, id: 'teacher', name: '教学者', identity: { role: '导师' }, budget: { maxTokens: 400 } }

test('loadCardLibrary keys cards by their own id and falls back to the filename', () => {
  const dir = library({ 'a.dshcd': TERSE, 'no-id.dshcd': { dshcd: 1, identity: { role: 'x' } } })
  const cards = loadCardLibrary(dir, collector())
  assert.equal(cards.get('terse').name, '简短审阅者')
  assert.equal(cards.get('no-id').identity.role, 'x')
})

test('loadCardLibrary keeps the first of two cards sharing an id and warns', () => {
  const logger = collector()
  const dir = library({ 'a.dshcd': TERSE, 'z.dshcd': { ...TERSE, name: 'shadow' } })
  assert.equal(loadCardLibrary(dir, logger).get('terse').name, '简短审阅者')
  assert.equal(logger.warnings.length, 1)
  assert.match(logger.warnings[0], /card id "terse" is already taken/)
})

test('loadCardLibrary skips a malformed card instead of throwing', () => {
  const logger = collector()
  const dir = library({ 'a.dshcd': TERSE, 'broken.dshcd': '{ not json' })
  assert.deepEqual([...loadCardLibrary(dir, logger).keys()], ['terse'])
  assert.equal(logger.warnings.length, 1)
})

test('loadCardLibrary returns an empty map for a missing directory', () => {
  assert.equal(loadCardLibrary(join(tmpdir(), 'dshcd-does-not-exist'), collector()).size, 0)
})

test('resolveCardId prefers a session override, then the default pointer, then nothing', () => {
  const dir = library({ 'terse.dshcd': TERSE, 'teacher.dshcd': TEACHER })
  assert.equal(resolveCardId(dir, 's1', collector()), undefined)

  writeFileSync(join(dir, 'default'), 'terse\n')
  assert.deepEqual(resolveCardId(dir, 's1', collector()), { cardId: 'terse', source: 'default pointer' })

  setSessionOverride(dir, 's1', 'teacher', collector())
  assert.deepEqual(resolveCardId(dir, 's1', collector()), { cardId: 'teacher', source: 'session override' })
  assert.deepEqual(resolveCardId(dir, 's2', collector()), { cardId: 'terse', source: 'default pointer' })
})

test('resolveCardId warns and falls through when a pointer names a missing card', () => {
  const logger = collector()
  const dir = library({ 'terse.dshcd': TERSE })
  writeFileSync(join(dir, 'default'), 'terse\n')
  setSessionOverride(dir, 's1', 'ghost', logger)
  assert.deepEqual(resolveCardId(dir, 's1', logger), { cardId: 'terse', source: 'default pointer' })
  assert.match(logger.warnings[0], /session override names card "ghost"/)
})

test('setSessionOverride writes and clears one entry without touching the others', () => {
  const dir = library({})
  const logger = collector()
  assert.equal(setSessionOverride(dir, 's1', 'terse', logger), true)
  assert.equal(setSessionOverride(dir, 's2', 'teacher', logger), true)
  assert.equal(setSessionOverride(dir, 's1', null, logger), true)

  assert.deepEqual(readSessionOverrides(dir, logger), { s2: 'teacher' })
  assert.equal(readFileSync(join(dir, 'sessions.json'), 'utf8').endsWith('\n'), true)
})

test('readSessionOverrides returns an empty object for a missing or malformed file', () => {
  const dir = library({})
  assert.deepEqual(readSessionOverrides(dir, collector()), {})

  writeFileSync(join(dir, 'sessions.json'), 'nonsense')
  const logger = collector()
  assert.deepEqual(readSessionOverrides(dir, logger), {})
  assert.equal(logger.warnings.length, 1)
})

test('renderCardById renders a card by id and reports when one is missing', () => {
  const dir = library({ 'terse.dshcd': TERSE })
  const rendered = renderCardById(dir, 'terse', collector())
  assert.equal(rendered.name, '简短审阅者')
  assert.match(rendered.text, /你是审阅者/)

  const logger = collector()
  assert.equal(renderCardById(dir, 'ghost', logger), undefined)
  assert.equal(logger.warnings.length, 1)
})

test('listCardSummaries reports every card with its estimated cost', () => {
  const dir = library({ 'terse.dshcd': TERSE, 'teacher.dshcd': TEACHER })
  const summaries = listCardSummaries(dir, collector())
  assert.deepEqual(summaries.map(entry => entry.id).sort(), ['teacher', 'terse'])
  assert.equal(summaries[0].maxTokens, 400)
  assert.equal(summaries[0].truncated, false)
  assert.ok(summaries[0].tokens > 0)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test`
Expected: FAIL —— `listCardSummaries is not a function` 之类的导入错误

- [ ] **Step 3: 实现**

在 `src/cards.js` 里加（`readTextFile` / `readJsonFile` 从 `src/index.js` 搬过来）：

```js
/** Filename of the global default card pointer. */
export const DEFAULT_POINTER_NAME = 'default'

/** Filename of the per-session override table. */
export const SESSION_OVERRIDES_NAME = 'sessions.json'

/**
 * Read a text file, treating absence as "no value" rather than an error.
 * @param path - file to read.
 * @param logger - logger for real failures.
 * @returns the contents, or undefined.
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
 * @param path - file to read.
 * @param logger - logger for failures.
 * @returns the parsed value, or undefined.
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
 * @param dir - library directory.
 * @param logger - logger for failures.
 * @returns card id -> card, in filename order.
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
    const card = validateCard(readJsonFile(join(dir, name), logger), name, logger)
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
 * @param dir - library directory.
 * @returns the id, or undefined when unset.
 */
export function readDefaultCardId(dir) {
  const raw = readTextFile(join(dir, DEFAULT_POINTER_NAME), {})
  const id = raw === undefined ? undefined : raw.trim()
  return id === undefined || id.length === 0 ? undefined : id
}

/**
 * Read the per-session override table.
 * @param dir - library directory.
 * @param logger - logger for failures.
 * @returns session id -> card id.
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
 * @param dir - library directory.
 * @param sessionId - the agent's shared agent/session id.
 * @param cardId - the card to pin, or null to clear the override.
 * @param logger - logger for failures.
 * @returns whether the table was written.
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
 * @param dir - library directory.
 * @param sessionId - the agent's shared agent/session id.
 * @param logger - logger for failures.
 * @returns the chosen id and where it came from, or undefined when unset.
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
 * @param dir - library directory.
 * @param cardId - card to render.
 * @param logger - logger for failures.
 * @returns the rendered card, or undefined when the library lacks it.
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
 * @param dir - library directory.
 * @param logger - logger for failures.
 * @returns one entry per card, in filename order.
 */
export function listCardSummaries(dir, logger) {
  return [...loadCardLibrary(dir, logger)].map(([id, card]) => {
    const budgeted = applyBudget(renderCard(card), card, id, logger)
    return {
      id,
      name: text(card.name) ?? null,
      description: text(card.description) ?? null,
      tokens: budgeted.tokens,
      maxTokens: budgeted.maxTokens,
      truncated: budgeted.truncated,
    }
  })
}
```

同时把 `src/index.js` 里被搬走的 `readTextFile` / `readJsonFile` / `loadCardLibrary` /
`readDefaultCardId` / `readSessionOverrides` / `resolveCardFor` / `renderCardById`
删掉，改为从 `./cards.js` 导入，并给调用点补上 `CARDS_DIR` 参数。

`src/index.js` 里 `resolveCardFor` 的旧调用点（`bindCard`）改为：

```js
  const resolved = resolveCardId(CARDS_DIR, agent.id, logger)
  if (resolved === undefined) return
  const rendered = renderCardById(CARDS_DIR, resolved.cardId, logger)
  if (rendered === undefined) return
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS（18 个测试）

- [ ] **Step 5: 确认 dry-run 与语法**

Run: `node --check src/index.js && node scripts/dryrun.mjs`
Expected: dry-run 三行 `bound` 照旧

- [ ] **Step 6: Commit**

```bash
git add src/cards.js src/index.js test/cards.test.js
git commit -m "refactor: move library, resolution, and override persistence into cards.js

The resolution order and the override table are format concerns, not Cordis
concerns, and P2 needs to write overrides from a route handler as well as read
them at agent creation. One home for both keeps the read and write paths
describing the same file the same way."
```

---

### Task 3: 宿主读路由

**Files:**
- Modify: `src/index.js`
- Create: `test/routes.test.js`

**Interfaces:**
- Consumes: `listCardSummaries`、`resolveCardId`、`readSessionOverrides`、`readDefaultCardId`（Task 2）
- Produces:
  - `GET /dsh-character-cards/cards` → `{ ok, defaultCard, cards }`
  - `GET /dsh-character-cards/session/<id>` → `{ ok, sessionId, cardId, source, override }`
  - `applyHost(ctx: object): void`（`apply` 内部使用，测试也直接调）

**说明：** 现在 `apply(ctx)` 里 `ctx.get('webServer')` 若不存在就走 `ctx.inject` 等——测试要能同步驱动，所以把路由注册抽成 `registerRoutes(webServer, ctx)` 并让 `apply` 直接调它。测试用一个假的 `webServer.register` 收集 handler。

- [ ] **Step 1: 写失败的测试**

`test/routes.test.js`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// CARDS_DIR is resolved from DSH_HOME when index.js is evaluated, so the fake
// home must exist and be exported before the dynamic import below.
const home = mkdtempSync(join(tmpdir(), 'dshcd-routes-'))
const cardsDir = join(home, 'character-cards')
mkdirSync(cardsDir, { recursive: true })
writeFileSync(join(cardsDir, 'terse.dshcd'), JSON.stringify(
  { dshcd: 1, id: 'terse', name: '简短审阅者', identity: { role: '审阅者' } }))
writeFileSync(join(cardsDir, 'teacher.dshcd'), JSON.stringify(
  { dshcd: 1, id: 'teacher', name: '教学者', identity: { role: '导师' } }))
writeFileSync(join(cardsDir, 'default'), 'terse\n')
writeFileSync(join(cardsDir, 'sessions.json'), JSON.stringify({ 'session-b': 'teacher' }))

process.env.DSH_HOME = home
const { apply } = await import('../src/index.js')

/** A Response-like recorder. */
function recorder() {
  const res = {
    status: undefined,
    headers: undefined,
    body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(payload) { this.body = JSON.parse(payload) },
  }
  return res
}

/** Captures every route `apply` registers and the JSON one returns. */
function harness(agents = { get: () => undefined }) {
  const routes = new Map()
  const ctx = {
    get: (name) => (name === 'webServer' ? { register: (route) => { routes.set(route.path, route.handler); return () => {} } }
      : name === 'agents' ? agents
        : undefined),
    inject: () => {},
    on: () => {},
    effect: (fn) => fn(),
    logger: { warn: () => {}, info: () => {} },
  }
  apply(ctx)
  return {
    async call(path) {
      const handler = routes.get(path)
      assert.ok(handler, `no route registered for ${path}`)
      const res = recorder()
      await handler({ method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:1' } }, res)
      return res
    },
  }
}

test('GET /cards lists the library and the default pointer', async () => {
  const res = await harness().call('/dsh-character-cards/cards')
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.defaultCard, 'terse')
  assert.deepEqual(res.body.cards.map(card => card.id).sort(), ['teacher', 'terse'])
  assert.ok(res.body.cards[0].tokens > 0)
})

test('GET /session/<id> reports the effective card and whether it is an override', async () => {
  const overridden = await harness().call('/dsh-character-cards/session/session-b')
  assert.deepEqual(
    { cardId: overridden.body.cardId, source: overridden.body.source, override: overridden.body.override },
    { cardId: 'teacher', source: 'session override', override: 'teacher' },
  )

  const inherited = await harness().call('/dsh-character-cards/session/session-z')
  assert.deepEqual(
    { cardId: inherited.body.cardId, source: inherited.body.source, override: inherited.body.override },
    { cardId: 'terse', source: 'default pointer', override: null },
  )
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/routes.test.js`
Expected: FAIL —— `no route registered for /dsh-character-cards/cards`

- [ ] **Step 3: 实现路由**

`src/index.js` 的 `registerRoutes(webServer, fiber)` 改为 `registerRoutes(webServer, ctx)`，并在 `ping` / `status` 之外加：

```js
  fiber.effect(() => webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/cards`,
    handler: (req, res) => {
      if (!guard(req, res)) return
      sendJson(res, 200, {
        ok: true,
        defaultCard: readDefaultCardId(CARDS_DIR) ?? null,
        cards: listCardSummaries(CARDS_DIR, {}),
      })
    },
  }))
```

`session/<id>` 要匹配前缀而非精确路径。已注册路由是 `kind: 'exact'`，所以改成两条精确路由不可行——用 `kind: 'prefix'`（若 webServer 不支持则见下方兜底）。

```js
  fiber.effect(() => webServer.register({
    kind: 'prefix',
    path: `${ROUTE_PREFIX}/session/`,
    handler: (req, res) => {
      if (!guard(req, res)) return
      const sessionId = decodeURIComponent(req.url.slice(`${ROUTE_PREFIX}/session/`.length).split('?')[0])
      if (sessionId.length === 0) {
        sendJson(res, 400, { ok: false, code: 'invalid', error: 'session id required' })
        return
      }
      const overrides = readSessionOverrides(CARDS_DIR, {})
      const resolved = resolveCardId(CARDS_DIR, sessionId, {})
      sendJson(res, 200, {
        ok: true,
        sessionId,
        cardId: resolved === undefined ? null : resolved.cardId,
        source: resolved === undefined ? null : resolved.source,
        override: Object.hasOwn(overrides, sessionId) ? overrides[sessionId] : null,
      })
    },
  }))
```

**先验证 `kind` 支持哪些值**：读 `~/.dsh/profiles/desktop/node_modules/dsh-delete-session/src/index.js:424`，那里用的是 `kind: 'exact'`，并在同目录的 `webServer` 定义处（用 `/status` 路由已注册成功这一事实反推）确认前缀形式。若 `webServer.register` 只支持 `exact`，则改为注册固定路径 + 查询串形式：

```js
    path: `${ROUTE_PREFIX}/session`,
    // 读 req.url 的 ?id=… 部分
```

两种都可接受，**以实际支持的为准**；把选中的那种写进注释说明原因。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/routes.test.js`
Expected: PASS

- [ ] **Step 5: 全量测试 + 活体验证**

Run: `npm test`
Expected: PASS

重启 dsh 后：

```bash
for p in $(netstat -ano | grep -i listening | grep 127.0.0.1: | sed 's/.*127.0.0.1:\([0-9]*\).*/\1/' | sort -un); do
  curl -s -m 2 "http://127.0.0.1:$p/dsh-character-cards/cards" | grep -q '"cards"' && echo "PORT $p"
done
```

Expected: 打印一个端口；`curl -s http://127.0.0.1:<port>/dsh-character-cards/cards` 返回三张卡

- [ ] **Step 6: Commit**

```bash
git add src/index.js test/routes.test.js
git commit -m "feat: expose the card library and a session's effective card over HTTP

The client half needs both to render a picker and to show what is currently in
effect. Read-only for now; the switch lands next."
```

---

### Task 4: 重绑 + 写路由

**Files:**
- Modify: `src/index.js`
- Modify: `test/routes.test.js`

**Interfaces:**
- Consumes: Task 3 的路由骨架、`setSessionOverride`、`renderCardById`、`resolveCardId`
- Produces:
  - `POST /dsh-character-cards/session/<id>/card` 体 `{ cardId: string | null }` → `{ ok, sessionId, cardId, written, rebound }`
  - `diag.registrations: Map<string, { fiber?: object, disposeSection?: () => void }>`（取代 `diag.fibers`）

- [ ] **Step 1: 写失败的测试**

追加到 `test/routes.test.js`：

```js
/** An agent stub whose systemPrompt records every registration and disposal. */
function agentStub(id) {
  const events = []
  const agent = { id, events }
  agent.ctx = {
    inject: (deps, callback) => {
      // The real inject defers by a microtask (fiber.ts:650); the stub defers
      // the same way so the test exercises the same ordering.
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

test('POST /session/<id>/card writes the override and rebinds a live agent', async () => {
  const agent = agentStub('session-live')
  const routes = harnessRw({ get: (id) => (id === 'session-live' ? agent : undefined) })
  const res = await routes.call('/dsh-character-cards/session/session-live/card', {
    method: 'POST',
    body: { cardId: 'teacher' },
  })
  assert.equal(res.status, 200)
  assert.equal(res.body.rebound, true)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(agent.events, ['register:dshcd:identity:teacher'])
})

test('POST writes the override even when no agent is live', async () => {
  const res = await harnessRw({ get: () => undefined }).call(
    '/dsh-character-cards/session/session-cold/card', { method: 'POST', body: { cardId: 'teacher' } })
  assert.equal(res.body.written, true)
  assert.equal(res.body.rebound, false)
  assert.equal(readSessionOverrides(cardsDir, {}).['session-cold'], 'teacher')
})

test('POST with cardId null clears the override', async () => {
  const res = await harnessRw({ get: () => undefined }).call(
    '/dsh-character-cards/session/session-b/card', { method: 'POST', body: { cardId: null } })
  assert.equal(res.body.cardId, null)
  assert.equal(Object.hasOwn(readSessionOverrides(cardsDir, {}), 'session-b'), false)
})

test('POST rejects an unknown card id and a missing cardId', async () => {
  const routes = harnessRw({ get: () => undefined })
  const unknown = await routes.call('/dsh-character-cards/session/s/card', { method: 'POST', body: { cardId: 'ghost' } })
  assert.equal(unknown.status, 400)

  const missing = await routes.call('/dsh-character-cards/session/s/card', { method: 'POST', body: {} })
  assert.equal(missing.status, 400)
})

test('rebinding disposes the previous registration before registering the new one', async () => {
  const agent = agentStub('session-twice')
  const routes = harnessRw({ get: () => agent })
  await routes.call('/dsh-character-cards/session/session-twice/card', { method: 'POST', body: { cardId: 'terse' } })
  await new Promise(resolve => setTimeout(resolve, 0))
  await routes.call('/dsh-character-cards/session/session-twice/card', { method: 'POST', body: { cardId: 'teacher' } })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(agent.events, [
    'register:dshcd:identity:terse',
    'dispose',
    'fiber-dispose',
    'register:dshcd:identity:teacher',
  ])
})
```

`harnessRw` 是 `harness` 的扩展版：额外接受 `{ method, body }`，并把 `req.url` 设为路由路径。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/routes.test.js`
Expected: FAIL —— `no route registered for .../card`

- [ ] **Step 3: 实现重绑**

`src/index.js`：

1. `diag.fibers` 改为 `diag.registrations`；`agent/disposed` 处理器相应改为：

```js
  ctx.on('agent/disposed', ({ agent }) => {
    diag.bound.delete(agent.id)
    const registration = diag.registrations.get(agent.id)
    diag.registrations.delete(agent.id)
    if (registration === undefined) return
    try { registration.disposeSection?.() } catch (error) { recordError(error) }
    try { void registration.fiber?.dispose?.() } catch (error) { recordError(error) }
  })
```

2. 新增 `registerSection`，取代 `bindCard` 里那段注册逻辑：

```js
/**
 * Register the card section on one live agent, replacing any previous one.
 *
 * The previous section disposer is called SYNCHRONOUSLY so the `dshcd:identity`
 * name is free before the new registration lands - the new one goes through
 * `ctx.inject`, whose callback Cordis always defers by at least a microtask
 * (vendor/cordis/src/fiber.ts:650). That leaves a one-microtask window in which
 * an assembly would find no card; see the spec's §4.2 for why that is accepted
 * rather than worked around.
 * @param agent - the live agent.
 * @param rendered - the rendered card text, or undefined to leave the agent unbound.
 * @param logger - logger for failures.
 * @returns the registration holder, or undefined when nothing was registered.
 */
function registerSection(agent, rendered, logger) {
  const previous = diag.registrations.get(agent.id)
  diag.registrations.delete(agent.id)
  if (previous !== undefined) {
    try { previous.disposeSection?.() } catch (error) { recordError(error) }
    try { void previous.fiber?.dispose?.() } catch (error) { recordError(error) }
  }
  if (rendered === undefined) return undefined

  // The inject callback runs after this function returns, so it publishes the
  // disposer through the holder rather than a return value.
  const registration = {}
  registration.fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
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
  diag.registrations.set(agent.id, registration)
  return registration
}
```

3. `bindCard` 缩成：

```js
function bindCard(agent, logger) {
  const resolved = resolveCardId(CARDS_DIR, agent.id, logger)
  const rendered = resolved === undefined
    ? undefined
    : renderCardById(CARDS_DIR, resolved.cardId, logger)
  const registration = registerSection(agent, rendered, logger)
  if (registration !== undefined && resolved !== undefined) {
    registration.source = resolved.source
  }
}
```

`diag.bound` 里原来记的 `source` 由 `registerSection` 之后的赋值补上（如上一行）。

4. 新增写路由（与读路由同一 `registerRoutes`）：

```js
  fiber.effect(() => webServer.register({
    kind: 'prefix',
    path: `${ROUTE_PREFIX}/session/`,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const rest = decodeURIComponent(req.url.slice(`${ROUTE_PREFIX}/session/`.length).split('?')[0])
      const sessionId = rest.endsWith('/card') ? rest.slice(0, -'/card'.length) : rest
      if (sessionId.length === 0) {
        sendJson(res, 400, { ok: false, code: 'invalid', error: 'session id required' })
        return
      }
      if (req.method === 'POST') {
        let body = {}
        try {
          const raw = await readBody(req)
          if (raw) body = JSON.parse(raw)
        } catch {
          sendJson(res, 400, { ok: false, code: 'invalid', error: 'malformed JSON body' })
          return
        }
        const cardId = body.cardId === null ? null : text(body.cardId)
        if (cardId === undefined) {
          sendJson(res, 400, { ok: false, code: 'invalid', error: 'cardId must be a string or null' })
          return
        }
        if (cardId !== null && !loadCardLibrary(CARDS_DIR, {}).has(cardId)) {
          sendJson(res, 400, { ok: false, code: 'unknown-card', error: `no card "${cardId}"` })
          return
        }
        const written = setSessionOverride(CARDS_DIR, sessionId, cardId, ctx.logger ?? {})
        const agent = ctx.get('agents')?.get(sessionId)
        if (agent !== undefined) {
          const effective = resolveCardId(CARDS_DIR, sessionId, ctx.logger ?? {})
          const rendered = effective === undefined
            ? undefined
            : renderCardById(CARDS_DIR, effective.cardId, ctx.logger ?? {})
          registerSection(agent, rendered, ctx.logger ?? {})
        }
        sendJson(res, 200, { ok: true, sessionId, cardId, written, rebound: agent !== undefined })
        return
      }
      // GET: the read side, as in Task 3.
      const overrides = readSessionOverrides(CARDS_DIR, {})
      const resolved = resolveCardId(CARDS_DIR, sessionId, {})
      sendJson(res, 200, {
        ok: true,
        sessionId,
        cardId: resolved === undefined ? null : resolved.cardId,
        source: resolved === undefined ? null : resolved.source,
        override: Object.hasOwn(overrides, sessionId) ? overrides[sessionId] : null,
      })
    },
  }))
```

5. 加 `readBody`（从 `dsh-delete-session/src/index.js:378` 抄）：

```js
/**
 * Read a request body as text, refusing anything implausibly large.
 * @param req - incoming request.
 * @returns the body text.
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
```

**注意：** 测试里 `harnessRw` 的假 `req` 需要有 `on()`——用 `EventEmitter` 或手工桩在 `end` 时喂入 `JSON.stringify(body)`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/routes.test.js`
Expected: PASS

- [ ] **Step 5: 全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 6: 活体验证（**这是 P2 的硬证据**）**

重启 dsh，打开一个 session（标准模式），先记下：

```bash
curl -s http://127.0.0.1:<PORT>/dsh-character-cards/status | grep -o '"ourChars":[0-9]*'
```

Expected: `"ourChars":454`（简短审阅者的字符数；它是 **chars 不是 tokens** —— token 数是 152）

```bash
curl -s -X POST http://127.0.0.1:<PORT>/dsh-character-cards/session/<session-id>/card \
  -H 'content-type: application/json' -d '{"cardId":"patient-teacher"}'
curl -s http://127.0.0.1:<PORT>/dsh-character-cards/status | grep -o '"ourChars":[0-9]*'
```

Expected: `"ourChars":551`（耐心的教学者）。**`ourChars` 从 454 变 551 就是重绑成功的硬证据**，
不需要读回答判断风格。

清回默认：

```bash
curl -s -X POST http://127.0.0.1:<PORT>/dsh-character-cards/session/<session-id>/card \
  -H 'content-type: application/json' -d '{"cardId":null}'
```

Expected: `ourChars` 变回 `454`

- [ ] **Step 7: Commit**

```bash
git add src/index.js test/routes.test.js
git commit -m "feat: rebind a live agent's card through the host route

Registration now goes through one function shared by first bind and rebind.
The previous section disposer is called synchronously so the section name is
free before the replacement lands; the replacement itself must go through
ctx.inject, whose callback Cordis always defers, so a one-microtask window
with no card is possible and accepted - the failure is a single turn without
a card, not a corrupt state."
```

---

### Task 5: 自适应客户端组件

**Files:**
- Modify: `src/client.js`
- Create: `test/client.test.js`

**Interfaces:**
- Consumes: Task 3/4 的路由
- Produces: `switcherMode(props: { sessionId?: unknown }): 'session' | 'global'`

- [ ] **Step 1: 写失败的测试**

`test/client.test.js`：

```js
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

test('apply claims the verified slot key and survives a ctx with no slots', () => {
  const { apply } = loaded.factory(() => fakeReact)
  const registered = []
  const slots = {
    inject: (key, callback) => { assert.equal(key, 'plugins.row.config'); callback() },
    register: (options, component) => { registered.push({ options, component }); return () => {} },
  }
  apply({ get: (name) => (name === 'slots' ? slots : undefined) })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.name, 'plugins.row.config')
  assert.equal(registered[0].options.key, 'dsh-character-cards#dsh-character-cards')

  assert.doesNotThrow(() => apply({ get: () => undefined }))
  assert.doesNotThrow(() => apply({ get: () => { throw new Error('hostile') } }))
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/client.test.js`
Expected: FAIL —— `switcherMode is not a function`

- [ ] **Step 3: 实现**

`src/client.js` 改为（保留文件头的说明注释，替换 factory 内实现）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-character-cards',
  factory: (require) => {
    const react = require('react')

    const ROUTE = '/dsh-character-cards'

    /**
     * Which surface a switcher instance is: a slot that hands over a sessionId
     * switches that session, a slot that does not switches the global default.
     * @param props - the slot's props.
     * @returns the mode.
     */
    function switcherMode(props) {
      return typeof props?.sessionId === 'string' && props.sessionId.length > 0 ? 'session' : 'global'
    }

    /** GET JSON, returning undefined instead of throwing. */
    async function getJson(path) {
      try {
        const res = await fetch(`${ROUTE}${path}`)
        if (!res.ok) return undefined
        return await res.json()
      } catch {
        return undefined
      }
    }

    /** POST JSON, returning undefined instead of throwing. */
    async function postJson(path, body) {
      try {
        const res = await fetch(`${ROUTE}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) return undefined
        return await res.json()
      } catch {
        return undefined
      }
    }

    /**
     * Card picker. Degrades to a plain static label whenever the host is
     * unreachable, so a broken fetch can never take the composer down.
     * @param props - slot props; `sessionId` selects the mode.
     */
    function CardSwitcher(props) {
      const mode = switcherMode(props)
      const sessionId = mode === 'session' ? props.sessionId : undefined
      const [state, setState] = react.useState({ ready: false, cards: [], value: '', hasOverride: false })

      react.useEffect(() => {
        let cancelled = false
        const load = async () => {
          const cards = await getJson('/cards')
          if (cancelled || cards === undefined) return
          const current = sessionId === undefined
            ? { cardId: cards.defaultCard, override: null }
            : await getJson(`/session/${encodeURIComponent(sessionId)}`)
          if (cancelled) return
          setState({
            ready: true,
            cards: cards.cards ?? [],
            value: current?.override ?? '',
            currentId: current?.cardId ?? null,
          })
        }
        void load()
        return () => { cancelled = true }
      }, [sessionId])

      if (!state.ready) return react.createElement('span', null, '角色卡')

      const choose = (next) => {
        setState(previous => ({ ...previous, value: next }))
        void postJson(
          sessionId === undefined ? '/default' : `/session/${encodeURIComponent(sessionId)}/card`,
          sessionId === undefined ? { cardId: next } : { cardId: next === '' ? null : next },
        )
      }

      const options = state.cards.map(card =>
        react.createElement('option', { key: card.id, value: card.id }, card.name ?? card.id))
      if (sessionId !== undefined) {
        options.unshift(react.createElement('option', { key: '__default', value: '' }, '跟随默认'))
      }

      return react.createElement(
        'select',
        { value: state.value, onChange: (event) => choose(event.target.value), title: '角色卡' },
        options,
      )
    }

    function apply(ctx) {
      try {
        const slots = ctx.get('slots')
        if (slots === undefined || typeof slots.inject !== 'function') return
        slots.inject('plugins.row.config', () => slots.register(
          { name: 'plugins.row.config', key: 'dsh-character-cards#dsh-character-cards' },
          CardSwitcher,
        ))
      } catch {
        // A missing or reshaped slot must degrade to "no card pane", never to a
        // broken client.
      }
    }

    return { apply, switcherMode }
  },
})
```

**注意：** 全局模式下选择后会 POST `/default`——那是 **Task 6 要加的路由**，本任务先让组件存在并可测。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/client.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/client.js test/client.test.js
git commit -m "feat: adaptive card switcher component

One component, two behaviours: a slot that supplies a sessionId switches that
session, a slot that does not switches the global default. Every host call is
wrapped so an unreachable or failing route leaves a static label rather than
throwing out of apply()."
```

---

### Task 6: 全局默认写路由 + 挂载

**Files:**
- Modify: `src/index.js`
- Modify: `test/routes.test.js`

**Interfaces:**
- Consumes: Task 5 的组件、Task 2 的 `readDefaultCardId` / `setSessionOverride`
- Produces: `POST /dsh-character-cards/default` 体 `{ cardId: string }` → `{ ok, defaultCard }`

- [ ] **Step 1: 写失败的测试**

追加到 `test/routes.test.js`：

```js
test('POST /default repoints the global default', async () => {
  const routes = harnessRw({ get: () => undefined })
  const res = await routes.call('/dsh-character-cards/default', { method: 'POST', body: { cardId: 'teacher' } })
  assert.equal(res.status, 200)
  assert.equal(res.body.defaultCard, 'teacher')
  assert.equal(readDefaultCardId(cardsDir), 'teacher')
})

test('POST /default rejects an unknown card', async () => {
  const res = await harnessRw({ get: () => undefined }).call(
    '/dsh-character-cards/default', { method: 'POST', body: { cardId: 'ghost' } })
  assert.equal(res.status, 400)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/routes.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/cards.js` 加：

```js
/**
 * Point the global default at one card.
 * @param dir - library directory.
 * @param cardId - the card to default to.
 * @param logger - logger for failures.
 * @returns whether the pointer was written.
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
```

`src/index.js` 加路由（沿用 Task 4 的 `readBody`）：

```js
  fiber.effect(() => webServer.register({
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
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 离线端到端（扩展 dry-run）**

`scripts/dryrun.mjs` 加一段"绑 A → 重绑 B"的序列：对同一个 agent 连续调两次注入，
断言第二次之前有一次 `dispose`，且最终注册的文本长度等于 B 的长度。

Run: `node scripts/dryrun.mjs`
Expected: 新增一节打印 `rebind: terse(152) -> teacher(184)`（数字是 **token** 估算，因为 dry-run 读的是仓库里那两张真卡），且无告警

- [ ] **Step 6: 活体验证**

重启 dsh → 打开插件设置页 → 应看到下拉框列出三张卡 → 换一张 → **再开一个新 session** → 新 session 用新默认。

- [ ] **Step 7: Commit**

```bash
git add src/cards.js src/index.js scripts/dryrun.mjs test/routes.test.js
git commit -m "feat: global default switching from the verified slot

Mounts the switcher on plugins.row.config, the one slot key verified live in
this profile, so the global half of the component is demonstrable now. The
per-session half waits on slot discovery - see the spec's section 6."
```

---

### Task 7: slot 发现后挂到 composer 一行

**前置：用户在创造模式 session 里执行 spec §6 的发现指令，把结果贴回来。**

**Files:**
- Modify: `src/client.js`

**Interfaces:**
- Consumes: Task 5 的 `CardSwitcher`（无需改动——它按 `sessionId` 自适应）
- Produces: 无新接口

- [ ] **Step 1: 根据发现结果确认目标 key**

判据：该 slot 的 `scope` 必须是 `session`，`kind` 必须是 `list` 或 `keyed`。
若发现结果显示 scope 是 `root`，控制不会拿到 `sessionId`，**回到 Task 6 的兜底**：
改用 `settings.section` 做只读面板 + 全局切换。

- [ ] **Step 2: 加注册**

在 `apply` 里**追加**（保留 `plugins.row.config` 的注册）：

```js
        // Discovered from the live client tree: session-scoped, list cardinality,
        // so a fresh id is purely additive and cannot displace an occupant.
        slots.inject('<DISCOVERED_KEY>', () => slots.register(
          { name: '<DISCOVERED_KEY>', id: 'dsh-character-cards', order: <DISCOVERED_ORDER> },
          CardSwitcher,
        ))
```

`<DISCOVERED_KEY>` / `<DISCOVERED_ORDER>` 用发现结果替换，`order` 取"分支"控件相邻的位置。

- [ ] **Step 3: 更新测试**

`test/client.test.js` 里 `apply` 的断言改为检查**两个** slot 都被注册，且第二个用了发现出来的 key：

```js
  assert.deepEqual(registered.map(entry => entry.options.name),
    ['plugins.row.config', '<DISCOVERED_KEY>'])
```

Run: `node --test test/client.test.js`
Expected: PASS

- [ ] **Step 4: 活体验证**

重启 dsh → 打开任意 session → 输入框上方出现卡片下拉 → 换一张 → **不重开 session**，
直接问一句 → stratus 的 `ourChars` 变，且回答风格变。

```bash
curl -s http://127.0.0.1:<PORT>/dsh-character-cards/status | grep -o '"ourChars":[0-9]*'
```

Expected: 切换后数值变为新卡的长度

- [ ] **Step 5: 验收清单（GOAL §5 逐条）**

- [ ] 一个 session 内切卡，下一轮回答明显不同
- [ ] 切「跟随默认」后回到默认卡的效果
- [ ] 插件设置页切全局默认，新建 session 用新默认
- [ ] 切卡过程中侧边栏、会话列表、其他插件入口全部正常（D7）

- [ ] **Step 6: Commit**

```bash
git add src/client.js test/client.test.js
git commit -m "feat: mount the session card switcher beside the branch control

The slot was confirmed against the live client tree rather than guessed: an
undeclared key makes slots.register fail during activation, which is the same
shape as the incident that produced the client-plugin safety rules. Registering
into a list slot under a fresh id is additive, so it cannot displace whatever
already occupies the row."
```

---

## Self-Review

**Spec coverage**

| spec 节 | 落在哪个任务 |
|---|---|
| §4.1 三个路由 | Task 3（读）、Task 4（写 session）、Task 6（写 default） |
| §4.2 重绑机制 | Task 4 Step 3 `registerSection` |
| §4.3 无 live agent | Task 4 Step 1 第二个测试 |
| §4.4 重绑失败保持旧卡 | Task 4 的 try/catch + `recordError`；活体验证在 Task 4 Step 6 |
| §5.1 自适应契约 | Task 5 `switcherMode` + 测试 |
| §5.2 交互（含「跟随默认」） | Task 5 `choose`；`{cardId:null}` 在 Task 4 Step 1 第三个测试 |
| §5.2 全局模式只读列表 | Task 6 Step 5 活体验证 |
| §5.3 D7 错误处理 | Task 5 `apply` 的 try/catch + `getJson`/`postJson` 不抛 |
| §6 第一步挂载 | Task 6 |
| §6 第二步挂载 | Task 7 |
| §6 兜底 | Task 7 Step 1 |
| §7.1 离线 | Task 1/2（单元）、Task 6 Step 5（序列） |
| §7.2 `ourChars` 硬证据 | Task 4 Step 6 |
| §7.3 交互 | Task 7 Step 4 |
| §8 风险 5 条 | 各任务的实现与验证步骤已覆盖 |

**Placeholder 扫描**：Task 7 的 `<DISCOVERED_KEY>` / `<DISCOVERED_ORDER>` 是**该任务的前置产物**，
不是遗留占位符——发现步骤本身产出这两个值，Task 7 Step 1 明确要求先确认再填。其余步骤无占位符。

**类型一致性**：`renderCardById` 返回 `{ id, name, text, tokens, maxTokens, truncated }`，
在 Task 4 的 `registerSection` 里按 `rendered.text` / `rendered.id` / `rendered.name` /
`rendered.tokens` / `rendered.maxTokens` / `rendered.truncated` 使用，与 Task 2 的 Interfaces 一致。
`resolveCardId` 返回 `{ cardId, source }`，两处调用点都用这两个字段名。
`diag.registrations` 的条目形状 `{ fiber?, disposeSection? }` 在 Task 4 的注册、重绑、
`agent/disposed` 三处一致。

**已修正的一处**：spec §4.2 原先写"同一 tick 内换完不会有轮次掉卡"——经查
`vendor/cordis/src/fiber.ts:650`，`_reload()` 首句即 `await Promise.resolve()`，
所以 inject 回调**必定**延后至少一个 microtask，该保证不成立。spec 已改写为
"接受一个 microtask 窗口"，本计划的 Task 4 按修正后的方案实现。
