# P3 卡片编辑器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 dsh 设置页里新建、编辑、保存 `.dshcd` 卡片，不用离开 UI、不用手写 JSON。

**Architecture:** 格式规则继续只存在于宿主 `src/cards.js`；编辑器是它的一个视图。每次字段变化把草稿 POST 给 `/cards/preview`，拿回校验结果、token 估算和 D5 告警。保存只落盘，是否重绑正在使用的 session 由用户显式点「重新应用」决定。

**Tech Stack:** 纯 JavaScript（无构建步骤）、Node 22 内建 `node --test`、Cordis 插件契约、React（`React.createElement`，无 JSX）、`@deepseek-ai/dsh-client-ui-primitives`（`Input` / `Button` / `DisclosureRow` / `Pill`）。

## Global Constraints

- 纯 JS，无 TS / JSX / 打包器；客户端 React 只用 `React.createElement`
- 客户端半的 `apply()` 全程 try/catch；依赖用前判空；失败降级，绝不抛穿
- 所有卡片路由走既有 `guard()`（loopback + Host；Origin 仅在存在时校验）
- 格式版本恒为 `dshcd: 1`
- 卡片 `id` 必须匹配 `^[a-z0-9][a-z0-9-]*$` 且长度 ≤ 64；它同时是文件名
- **渲染绝不截断卡片**；token 数只是信息（GOAL D11）
- **未知字段必须原样保留**：编辑器只在 `structuredClone(original)` 上改已知字段，绝不从字段清单重建对象（GOAL D6）
- 编辑器**只用 dsh 原语**，不出现原生 `<select>` / `<textarea>` / 默认样式的 `<input>`
- `Input` 是单行原子控件（`ui-primitives/src/Input.tsx` 注释明说多行属于 conversation 包），所以所有标量字段都是单行
- 提交信息描述 why；只做本地提交，不碰远程

---

## File Structure

| 文件 | 变化 |
|---|---|
| `src/cards.js` | 移除预算/截断（D11）；`validateCard` 拆出可返回原因的 `inspectCard`；新增 id 白名单、读原始卡、原子写入、D5 告警 |
| `src/index.js` | 新增预览 / 新建 / 更新 / 读取 / 应用五条路由；`sessionsUsing`；`/cards` 列表带上使用数 |
| `src/client.js` | 设置页变成列表↔编辑器两个视图；编辑器用原语渲染五组折叠字段 |
| `test/cards.test.js` | 预算测试改成 `measure`；新增 id / 原子写 / 告警测试 |
| `test/routes.test.js` | 新增预览、新建、更新、读取、应用 |
| `test/client.test.js` | 新增字段路径、脏检测、分组描述测试 |

**客户端为什么仍是单文件**：`window.__ModuleLoader__.load({ factory })` 是经典脚本协议，factory 内部没有可用的模块导入机制。`src/client.js` 会增长到约 700 行；用清晰的小函数和分组描述控制可读性，不拆文件。

---

### Task 1: 移除预算概念（GOAL D11）

**Files:**
- Modify: `src/cards.js`
- Modify: `src/index.js`
- Modify: `src/client.js`
- Test: `test/cards.test.js`

**Interfaces:**
- Consumes: 现有 `renderCard(card) → string`
- Produces:
  - `measure(rendered: string): { chars: number, tokens: number }`
  - `inspectCard(value: unknown): { card: object } | { error: string }`
  - `renderCardById(dir, cardId, logger) → { id, name, text, chars, tokens } | undefined`
  - `listCardSummaries(dir, logger) → Array<{ id, name, description, chars, tokens }>`
  - 删除：`DEFAULT_MAX_TOKENS`、`applyBudget`

- [ ] **Step 1: 改测试**

在 `test/cards.test.js` 里，把三个 `applyBudget` 测试整体替换为 `measure` 测试，并更新导入：

```js
import {
  clearSessionOverride,
  inspectCard, listCardSummaries, loadCardLibrary, measure, readDefaultCardId, readSessionOverrides,
  renderCardById, resolveCardId, setSessionOverride,
  validateCard,
} from '../src/cards.js'
```

```js
test('measure reports size without ever trimming', () => {
  const short = measure('short')
  assert.deepEqual(short, { chars: 5, tokens: 2 })

  // The old budget truncated from the tail, which is exactly where constraints
  // live. Measuring must never change the text.
  const long = 'x'.repeat(5000)
  assert.deepEqual(measure(long), { chars: 5000, tokens: 1667 })
})

test('inspectCard returns the reason instead of logging it', () => {
  assert.deepEqual(inspectCard('nope'), { error: 'a card must be a JSON object' })
  assert.deepEqual(inspectCard({ dshcd: 2 }), {
    error: 'declares dshcd 2; this build reads version 1',
  })
  const card = { dshcd: 1, id: 'ok' }
  assert.equal(inspectCard(card).card, card)
})
```

同时把 `renderCardById` 的断言改成不含 `maxTokens` / `truncated`：

```js
test('renderCardById renders a card by id and reports when one is missing', () => {
  const dir = library({ 'terse.dshcd': TERSE })
  const rendered = renderCardById(dir, 'terse', collector())
  assert.equal(rendered.name, '简短审阅者')
  assert.match(rendered.text, /你是审阅者/)
  assert.equal(rendered.chars, rendered.text.length)
  assert.equal(rendered.tokens, Math.ceil(rendered.chars / 3))

  const logger = collector()
  assert.equal(renderCardById(dir, 'ghost', logger), undefined)
  assert.equal(logger.warnings.length, 1)
})
```

`listCardSummaries` 的断言：

```js
test('listCardSummaries reports every card with its estimated cost', () => {
  const dir = library({ 'terse.dshcd': TERSE, 'teacher.dshcd': TEACHER })
  const summaries = listCardSummaries(dir, collector())
  assert.deepEqual(summaries.map(entry => entry.id).sort(), ['teacher', 'terse'])
  assert.ok(summaries[0].tokens > 0)
  assert.equal(summaries[0].chars > 0, true)
  assert.deepEqual(Object.keys(summaries[0]).sort(), ['chars', 'description', 'id', 'name', 'tokens'])
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/cards.test.js`
Expected: FAIL —— `measure is not a function` / `inspectCard is not a function`

- [ ] **Step 3: 改 `src/cards.js`**

删除 `DEFAULT_MAX_TOKENS`、`estimateTokens`、`applyBudget`（第 32、177–213 行附近）。

插入：

```js
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
```

把 `validateCard` 改成基于 `inspectCard`：

```js
export function validateCard(value, label, logger) {
  const inspected = inspectCard(value)
  if ('error' in inspected) {
    logger.warn?.(`${label}: ${inspected.error}`)
    return undefined
  }
  return inspected.card
}
```

把 `renderCardById` 与 `listCardSummaries` 改成：

```js
export function renderCardById(dir, cardId, logger) {
  const card = loadCardLibrary(dir, logger).get(cardId)
  if (card === undefined) {
    logger.warn?.(`card "${cardId}" is not in ${dir}`)
    return undefined
  }
  const rendered = renderCard(card)
  return { id: cardId, name: text(card.name) ?? cardId, text: rendered, ...measure(rendered) }
}

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
```

- [ ] **Step 4: 运行确认 `cards.test.js` 通过**

Run: `node --test test/cards.test.js`
Expected: PASS

- [ ] **Step 5: 改 `src/index.js` 与 `src/client.js`**

`src/index.js` 的 `registerSection` 里，`diag.bound.set(...)` 删掉两行：

```js
        chars: rendered.text.length,
        tokens: rendered.tokens,
```

（即删除 `maxTokens` 与 `truncated` 两行，保留 `card` / `name` / `source` / `chars` / `tokens`。）

`src/client.js` 的 `CardSettingsSection` 里，行内价格与截断标记改成：

```js
        react.createElement('span', { style: { opacity: 0.7, whiteSpace: 'nowrap' } },
          `${entry.tokens} token`),
```

（删除 `entry.truncated ? … : null` 那一行。）

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: PASS（39 个）

- [ ] **Step 7: Commit**

```bash
git add src/cards.js src/index.js src/client.js test/cards.test.js
git commit -m "refactor: drop the card budget and never truncate a render

The budget truncated from the tail, which is where constraints and the
precedence line are rendered - so exceeding it removed the part of a card most
likely to change behaviour. The number behind it was characters divided by
three, not a tokenizer, so enforcing it was precision the measurement never
had. It becomes a plain measurement (GOAL D11).

Old cards keep their budget key as an unknown field, which the editor will now
have to preserve."
```

---

### Task 2: `id` 白名单、读原始卡、原子写入

**Files:**
- Modify: `src/cards.js`
- Test: `test/cards.test.js`

**Interfaces:**
- Consumes: `inspectCard`、`validateCard`、`text`、`readJsonFile`（Task 1）
- Produces:
  - `isValidCardId(value: unknown): boolean`
  - `cardExists(dir: string, id: string): boolean`
  - `readCardFile(dir, id, logger) → object | undefined`
  - `writeCardFile(dir, card, logger) → { ok: true, id } | { ok: false, code, error }`

- [ ] **Step 1: 写失败的测试**

追加到 `test/cards.test.js`：

```js
import {
  cardExists, isValidCardId, readCardFile, writeCardFile,
} from '../src/cards.js'

test('isValidCardId accepts safe ids and rejects anything that could escape the directory', () => {
  assert.equal(isValidCardId('terse-reviewer'), true)
  assert.equal(isValidCardId('a'), true)
  assert.equal(isValidCardId('9lives'), true)

  assert.equal(isValidCardId(''), false)
  assert.equal(isValidCardId('Upper'), false)
  assert.equal(isValidCardId('has space'), false)
  assert.equal(isValidCardId('has_underscore'), false)
  assert.equal(isValidCardId('../evil'), false)
  assert.equal(isValidCardId('a/b'), false)
  assert.equal(isValidCardId('a'.repeat(65)), false)
  assert.equal(isValidCardId(42), false)
  assert.equal(isValidCardId(null), false)
})

test('writeCardFile writes a card under its id and readCardFile returns it verbatim', () => {
  const dir = library({})
  const card = { dshcd: 1, id: 'roundtrip', name: '往返', futureField: { keep: true } }
  assert.deepEqual(writeCardFile(dir, card, collector()), { ok: true, id: 'roundtrip' })
  assert.equal(cardExists(dir, 'roundtrip'), true)

  const read = readCardFile(dir, 'roundtrip', collector())
  assert.deepEqual(read, card)
  // Unknown fields survive, which is what the editor relies on.
  assert.deepEqual(read.futureField, { keep: true })
})

test('writeCardFile refuses an unsafe id and writes nothing', () => {
  const dir = library({})
  const logger = collector()
  const result = writeCardFile(dir, { dshcd: 1, id: '../escape' }, logger)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid-id')
  assert.equal(cardExists(dir, '../escape'), false)
})

test('writeCardFile refuses a card that fails inspection', () => {
  const result = writeCardFile(library({}), { dshcd: 7, id: 'ok' }, collector())
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid')
})

test('writeCardFile leaves no temporary file behind', () => {
  const dir = library({})
  writeCardFile(dir, { dshcd: 1, id: 'clean' }, collector())
  assert.deepEqual(readdirSync(dir).sort(), ['clean.dshcd'])
})
```

文件顶部补 `readdirSync` 的导入：

```js
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/cards.test.js`
Expected: FAIL —— `isValidCardId is not a function`

- [ ] **Step 3: 实现**

`src/cards.js` 顶部导入补上 `existsSync, renameSync`：

```js
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
```

在 `CARD_EXTENSION` 下方加：

```js
/** Characters a card id may contain. It becomes a filename, so this is also
 * what keeps a card from being written outside the library directory. */
const CARD_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** Longest accepted card id. */
const MAX_CARD_ID_LENGTH = 64
```

在 `readDefaultCardId` 之前插入：

```js
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
  return validateCard(readJsonFile(cardPath(dir, id), logger), id, logger)
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
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/cards.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cards.js test/cards.test.js
git commit -m "feat: safe card ids, raw reads, and atomic writes

A card's id is its filename, so it is also the boundary between the library
directory and everywhere else. An id that takes the whitelist is the only one
that reads or writes, which makes path traversal unrepresentable rather than
merely rejected at the route.

Writes go through a temporary neighbour and a rename: a process that dies
mid-write must not leave half a card where a whole one used to be."
```

---

### Task 3: 预览 / 新建 / 更新 / 读取路由

**Files:**
- Modify: `src/index.js`
- Test: `test/routes.test.js`

**Interfaces:**
- Consumes: `inspectCard`、`measure`、`renderCard`（Task 1）、`isValidCardId`、`cardExists`、`readCardFile`、`writeCardFile`（Task 2）
- Produces:
  - `cardWarnings(card): Array<{ code, message }>`（`src/cards.js`）
  - `POST /dsh-character-cards/cards/preview` → `{ ok, valid, error?, chars?, tokens?, warnings }`
  - `POST /dsh-character-cards/cards` → `{ ok, id }`；已存在 409
  - `PUT /dsh-character-cards/cards/<id>` → `{ ok, id }`；不存在 404
  - `GET /dsh-character-cards/cards/<id>` → `{ ok, id, card }`

**路由形状说明**：`/cards/preview` 注册为 `exact`，`/cards/<id>` 注册为 `prefix`（`path: `${ROUTE_PREFIX}/cards``，不带尾斜杠——宿主匹配规则是 `p` 或 `p/<anything>`）。宿主的 `match()` 先查精确表，所以 `/cards`（列表）和 `/cards/preview` 都会赢过前缀路由。

- [ ] **Step 1: 写失败的测试**

追加到 `test/routes.test.js`：

```js
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
```

顶部导入补：

```js
import { cardExists, readCardFile, writeCardFile } from '../src/cards.js'
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/routes.test.js`
Expected: FAIL —— `no route matched /dsh-character-cards/cards/preview`

- [ ] **Step 3: 在 `src/cards.js` 加 `cardWarnings`**

```js
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
```

- [ ] **Step 4: 在 `src/index.js` 加三条路由**

导入补上新用到的名字：

```js
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
```

在 `registerRoutes` 里、`/cards` 列表路由之后插入（前缀路由注册**不带尾斜杠**）：

```js
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

  // One card by id, plus the two writes that change it. A single prefix
  // registration serves GET, PUT, and (in the next task) apply, because the
  // route table rejects a duplicate (kind, path).
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

  // Create. A separate exact route so that "the id is taken" is a 409 rather
  // than a silent overwrite.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/cards`,
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
```

- [ ] **Step 5: 运行确认通过**

Run: `node --test test/routes.test.js`
Expected: PASS

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/cards.js src/index.js test/routes.test.js
git commit -m "feat: preview, create, update, and read routes for cards

The preview route is the whole reason the editor does not carry a copy of the
format rules: it sends a draft and gets back validity, size, and the D5
advisories, so the form and the renderer cannot disagree about what a card
means.

Create is separate from update so that an id collision is a 409 instead of a
silent overwrite, and update refuses a body whose id disagrees with the path -
otherwise one request could write two different files depending on which side
you read."
```

---

### Task 4: 使用计数与「重新应用」

**Files:**
- Modify: `src/index.js`
- Test: `test/routes.test.js`

**Interfaces:**
- Consumes: `resolveCardId`、`rebind`（P2）、`ctx.get('agents')`
- Produces:
  - `sessionsUsing(ctx, cardId) → string[]`
  - `GET /cards/<id>` 增加 `sessionsUsing`
  - `GET /cards` 每条摘要增加 `sessionsUsing`
  - `POST /cards/<id>/apply` → `{ ok, applied }`

- [ ] **Step 1: 写失败的测试**

追加到 `test/routes.test.js`：

```js
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
```

顶部导入补 `setSessionOverride`：

```js
import { cardExists, readCardFile, setSessionOverride, writeCardFile } from '../src/cards.js'
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/routes.test.js`
Expected: FAIL —— `apply` 命中 PUT/GET 分支后返回 405

- [ ] **Step 3: 实现 `sessionsUsing`**

在 `src/index.js` 的 `rebind` 之后加：

```js
/**
 * Live sessions currently resolving to one card.
 *
 * Computed from the same resolution the binder uses, so the count can never
 * disagree with what a session would actually get.
 * @param {object} ctx - plugin context carrying the agent registry.
 * @param {string} cardId - the card to look for.
 * @returns {string[]} their session ids.
 */
function sessionsUsing(ctx, cardId) {
  const agents = ctx.get('agents')
  if (agents === undefined) return []
  try {
    return agents.list()
      .filter(agent => {
        const resolved = resolveCardId(CARDS_DIR, agent.id, {})
        return resolved !== undefined && resolved.cardId === cardId
      })
      .map(agent => agent.id)
  } catch (error) {
    recordError(error)
    return []
  }
}
```

`librarySnapshot` 改成接收 ctx 并带上计数：

```js
function librarySnapshot(ctx) {
  return {
    defaultCard: readDefaultCardId(CARDS_DIR) ?? null,
    cards: listCardSummaries(CARDS_DIR, {}).map(summary => ({
      ...summary,
      sessionsUsing: sessionsUsing(ctx, summary.id).length,
    })),
  }
}
```

把 `/cards` 路由里的 `...librarySnapshot()` 改成 `...librarySnapshot(ctx)`；`/status` 里同样改。

- [ ] **Step 4: 在 `/cards` 前缀路由里加上 `apply` 与计数**

把该 handler 的开头改成先切掉 `/apply` 后缀：

```js
      const rest = decodeURIComponent(pathnameOf(req).slice(`${ROUTE_PREFIX}/cards`.length).replace(/^\//, ''))
      const wantsApply = rest.endsWith('/apply')
      const id = wantsApply ? rest.slice(0, -'/apply'.length) : rest
      if (!isValidCardId(id)) {
        sendJson(res, 400, { ok: false, code: 'invalid-id', error: 'id must match ^[a-z0-9][a-z0-9-]*$' })
        return
      }

      if (wantsApply) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, code: 'method', error: 'POST only' })
          return
        }
        const ids = sessionsUsing(ctx, id)
        for (const sessionId of ids) {
          const agent = ctx.get('agents')?.get(sessionId)
          if (agent !== undefined) rebind(agent, sessionId, ctx.logger ?? {})
        }
        sendJson(res, 200, { ok: true, applied: ids.length })
        return
      }
```

并把 `GET` 分支的返回值改成带计数：

```js
        sendJson(res, 200, { ok: true, id, card, sessionsUsing: sessionsUsing(ctx, id) })
```

- [ ] **Step 5: 运行确认通过**

Run: `node --test test/routes.test.js`
Expected: PASS

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/index.js test/routes.test.js
git commit -m "feat: count the sessions using a card, and apply an edit on demand

The count is computed with the same resolution the binder uses, so it cannot
disagree with what a session would actually get, and the apply route reuses the
rebind path P2 already proved rather than growing a second one.

Saving still does not rebind: a card edit rewriting a live session's identity
without being asked is a surprise, and the count plus one button makes the
choice explicit."
```

---

### Task 5: 客户端 · 列表与编辑器骨架

**Files:**
- Modify: `src/client.js`
- Test: `test/client.test.js`

**Interfaces:**
- Consumes: `Input` / `Button` / `DisclosureRow` / `Pill` from primitives；`GET /cards`、`GET /cards/<id>`（Task 3）
- Produces（factory 返回值新增，供测试）：
  - `fieldOf(card, path): unknown`
  - `withField(card, path, value): object`
  - `editorGroups(): Array<{ key, title, badge, fields: Array<{ path, label, kind }> }>`
  - `isDirty(draft, original): boolean`

- [ ] **Step 1: 写失败的测试**

追加到 `test/client.test.js`：

```js
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
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/client.test.js`
Expected: FAIL —— `fieldOf is not a function`

- [ ] **Step 3: 实现纯函数与分组描述**

在 `src/client.js` 的 factory 内、`ROUTE` 之后加。

先把编辑器要用的原语一并取出来（现有的 factory 顶部只取了 `Menu` / `Pill` / `Chevron`）：

```js
    const Input = primitives?.Input
    const Button = primitives?.Button
    const DisclosureRow = primitives?.DisclosureRow
```

然后加纯函数：

```js
    /**
     * Read a nested field without throwing on a missing parent.
     * @param card - the card.
     * @param path - dot-separated field path.
     * @returns the value, or undefined.
     */
    function fieldOf(card, path) {
      let cursor = card
      for (const part of path.split('.')) {
        if (cursor === null || typeof cursor !== 'object') return undefined
        cursor = cursor[part]
      }
      return cursor
    }

    /**
     * Return a copy of a card with one nested field replaced.
     *
     * The copy comes from structuredClone and only the named path is assigned,
     * so every field this build does not know survives (GOAL D6). Rebuilding
     * the card from a field list would silently delete them on the first save.
     * @param card - the card to copy.
     * @param path - dot-separated field path.
     * @param value - the replacement value.
     * @returns a new card.
     */
    function withField(card, path, value) {
      const parts = path.split('.')
      const copy = structuredClone(card)
      let cursor = copy
      for (const part of parts.slice(0, -1)) {
        if (cursor[part] === null || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
          cursor[part] = {}
        }
        cursor = cursor[part]
      }
      cursor[parts[parts.length - 1]] = value
      return copy
    }

    /**
     * The five editable groups, in render order, with their D2 impact badges.
     *
     * `kind` decides the control: `text` is one Input, `list` is a row per
     * entry, `bool` is a Pill toggle.
     * @returns the group descriptors.
     */
    function editorGroups() {
      return [
        {
          key: 'identity',
          title: '身份',
          badge: '低风险 · 影响视角与用词',
          fields: [
            { path: 'identity.role', label: '角色', kind: 'text' },
            { path: 'identity.expertise', label: '专长', kind: 'list' },
            { path: 'identity.background', label: '背景', kind: 'text' },
          ],
        },
        {
          key: 'voice',
          title: '表达',
          badge: '安全 · 只影响表达，不影响正确性',
          fields: [
            { path: 'voice.tone', label: '语气', kind: 'text' },
            { path: 'voice.verbosity', label: '篇幅', kind: 'text' },
            { path: 'voice.formality', label: '正式度', kind: 'text' },
            { path: 'voice.humor', label: '幽默', kind: 'text' },
            { path: 'voice.traits', label: '性格', kind: 'list' },
            { path: 'voice.avoid', label: '禁止', kind: 'list' },
          ],
        },
        {
          key: 'code',
          title: '代码风格',
          badge: '会改变代码 · 影响产出质量与风格',
          fields: [
            { path: 'code.naming', label: '命名', kind: 'text' },
            { path: 'code.comments', label: '注释', kind: 'text' },
            { path: 'code.error_handling', label: '错误处理', kind: 'text' },
            { path: 'code.abstraction', label: '抽象', kind: 'text' },
            { path: 'code.dependencies', label: '依赖', kind: 'text' },
            { path: 'code.tests', label: '测试', kind: 'text' },
            { path: 'code.commit_style', label: '提交信息', kind: 'text' },
          ],
        },
        {
          key: 'workflow',
          title: '工作方式',
          badge: '高风险 · 影响行为决策',
          fields: [
            { path: 'workflow.plan', label: '计划', kind: 'text' },
            { path: 'workflow.ask_when_unclear', label: '需求不清就问', kind: 'bool' },
            { path: 'workflow.verify_before_claim', label: '完成前先验证', kind: 'bool' },
          ],
        },
        {
          key: 'constraints',
          title: '硬性约束',
          badge: '最高优先级 · 逐条遵守',
          fields: [
            { path: 'constraints', label: '约束', kind: 'list' },
          ],
        },
      ]
    }

    /** Recursively sort object keys so two structurally equal cards compare equal. */
    function canonical(value) {
      if (Array.isArray(value)) return value.map(canonical)
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
      }
      return value
    }

    /**
     * Whether a draft differs from what was loaded.
     * @param draft - the edited card.
     * @param original - the loaded card, or null for a new one.
     * @returns true when saving would change something.
     */
    function isDirty(draft, original) {
      if (original === null) return draft !== null
      return JSON.stringify(canonical(draft)) !== JSON.stringify(canonical(original))
    }
```

- [ ] **Step 4: 运行确认纯函数测试通过**

Run: `node --test test/client.test.js`
Expected: PASS（纯函数部分）

- [ ] **Step 5: 加编辑器骨架组件**

在 `CardSettingsSection` 之后插入（**只用原语，不用原生控件**）：

```js
    /**
     * One editable field.
     * @param props.draft - the card.
     * @param props.field - `{ path, label, kind }` from editorGroups().
     * @param props.onChange - called with the next card.
     */
    function EditorField({ draft, field, onChange }) {
      const value = fieldOf(draft, field.path)

      if (field.kind === 'bool') {
        return react.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' } },
          react.createElement(Pill, {
            active: value === true,
            onClick: () => onChange(withField(draft, field.path, value !== true)),
          }, value === true ? '已开启' : '已关闭'),
          react.createElement('span', { style: { opacity: 0.75 } }, field.label),
        )
      }

      if (field.kind === 'list') {
        const entries = Array.isArray(value) ? value : []
        const replace = (index, next) => {
          const copy = entries.slice()
          if (next === undefined) copy.splice(index, 1)
          else copy[index] = next
          onChange(withField(draft, field.path, copy))
        }
        return react.createElement(
          'div',
          { style: { margin: '8px 0' } },
          react.createElement('div', { style: { opacity: 0.75, marginBottom: '4px' } }, field.label),
          entries.map((entry, index) => react.createElement(
            'div',
            { key: String(index), style: { display: 'flex', gap: '6px', marginBottom: '4px' } },
            // Input renders its own wrapper span around the <input>, and puts
            // any style it is handed on the <input> itself. The flex has to be
            // on a span we own, or the field will not stretch.
            react.createElement('span', { style: { flex: 1, display: 'flex', minWidth: 0 } },
              react.createElement(Input, {
                value: String(entry),
                onChange: (event) => replace(index, event.target.value),
                style: { width: '100%' },
              }),
            ),
            react.createElement(Button, { size: 'sm', onClick: () => replace(index, undefined) }, '删除'),
          )),
          react.createElement(Button, {
            size: 'sm',
            onClick: () => onChange(withField(draft, field.path, [...entries, ''])),
          }, `添加${field.label}`),
        )
      }

      return react.createElement(
        'div',
        { style: { margin: '8px 0' } },
        react.createElement('div', { style: { opacity: 0.75, marginBottom: '4px' } }, field.label),
        react.createElement(Input, {
          value: typeof value === 'string' ? value : '',
          onChange: (event) => onChange(withField(draft, field.path, event.target.value)),
        }),
      )
    }

    /**
     * One collapsible group of fields.
     * @param props.group - from editorGroups().
     * @param props.draft - the card.
     * @param props.open - whether the group is expanded.
     * @param props.onToggle - expand/collapse.
     * @param props.onChange - called with the next card.
     */
    function EditorGroup({ group, draft, open, onToggle, onChange }) {
      return react.createElement(
        DisclosureRow,
        {
          icon: react.createElement('span', { 'aria-hidden': true }, '•'),
          title: `${group.title}  ·  ${group.badge}`,
          open,
          expandable: true,
          onToggle,
        },
        group.fields.map(field => react.createElement(EditorField, {
          key: field.path,
          draft,
          field,
          onChange,
        })),
      )
    }
```

**注意**：`DisclosureRow` 的 `icon` 是必填 prop（见 `ui-primitives/src/DisclosureRow.tsx`），上面传的是占位字符。

- [ ] **Step 6: 把 `CardSettingsSection` 改成两视图**

替换整个 `CardSettingsSection`：

```js
    /**
     * The settings page: a card list, and an editor for one card.
     *
     * Only two views exist, so there is no routing, no modal, and no scroll
     * management - the two states are mutually exclusive.
     * @returns {unknown} the section element.
     */
    function CardSettingsSection() {
      const [state, setState] = react.useState({ status: 'loading', cards: [], defaultCard: null })
      const [view, setView] = react.useState({ kind: 'list' })
      const [defaultOpen, setDefaultOpen] = react.useState(false)

      const reload = async () => {
        const payload = await getJson('/cards')
        setState(payload === undefined
          ? { status: 'error', cards: [], defaultCard: null }
          : { status: 'ready', cards: payload.cards ?? [], defaultCard: payload.defaultCard ?? null })
      }

      react.useEffect(() => { void reload() }, [])

      const openEditor = async (cardId) => {
        const payload = cardId === undefined ? undefined : await getJson(`/cards/${encodeURIComponent(cardId)}`)
        if (cardId !== undefined && payload === undefined) return
        const original = payload === undefined ? null : payload.card
        setView({
          kind: 'editor',
          original,
          draft: original === null ? { dshcd: 1, id: '', name: '', description: '' } : structuredClone(original),
        })
      }

      // The editor is built entirely from the primitives package. When a build
      // does not export them, say so - rendering an undefined component throws,
      // and a client component that throws can take the whole client
      // composition with it.
      const missingPrimitives = [Menu, Pill, Input, Button, DisclosureRow]
        .some(component => typeof component !== 'function')

      if (state.status === 'loading') return react.createElement('p', null, '读取卡片库…')
      if (state.status === 'error') return react.createElement('p', null, '无法读取卡片库。')
      if (missingPrimitives) return react.createElement('p', null, '角色卡控件不可用：客户端 UI 原语缺失。')

      if (view.kind === 'editor') {
        return react.createElement(CardEditor, {
          view,
          onChange: (draft) => setView(previous => ({ ...previous, draft })),
          onClose: () => { void reload(); setView({ kind: 'list' }) },
        })
      }

      const chooseDefault = (next) => {
        setState(previous => ({ ...previous, defaultCard: next }))
        void postJson('/default', { cardId: next })
      }

      const rows = state.cards.map(entry => react.createElement(
        'li',
        { key: entry.id, style: { display: 'flex', gap: '12px', padding: '4px 0', alignItems: 'center' } },
        react.createElement(Button, { size: 'sm', onClick: () => { void openEditor(entry.id) } }, entry.name ?? entry.id),
        react.createElement('span', { style: { flex: 1, opacity: 0.7, whiteSpace: 'nowrap' } }, `${entry.tokens} token`),
        entry.sessionsUsing > 0
          ? react.createElement('span', { style: { opacity: 0.7, whiteSpace: 'nowrap' } }, `${entry.sessionsUsing} 个会话正在使用`)
          : null,
      ))

      return react.createElement(
        'div',
        { style: { lineHeight: 1.7 } },
        react.createElement('p', { style: { margin: '0 0 12px', display: 'flex', gap: '12px', alignItems: 'center' } },
          react.createElement('span', null, '默认卡 '),
          react.createElement(Menu, {
            open: defaultOpen,
            items: state.cards.map(entry => ({ id: entry.id, label: entry.name ?? entry.id })),
            selectedId: state.defaultCard,
            onSelect: (id) => { setDefaultOpen(false); chooseDefault(id) },
            onClose: () => setDefaultOpen(false),
            side: 'bottom',
            anchor: react.createElement(Pill, {
              active: defaultOpen,
              onClick: () => setDefaultOpen(!defaultOpen),
            }, state.defaultCard ?? '未设置'),
          }),
          react.createElement(Button, { size: 'sm', onClick: () => { void openEditor(undefined) } }, '新建卡片'),
        ),
        state.cards.length === 0
          ? react.createElement('p', null, '卡片库为空。点「新建卡片」开始。')
          : react.createElement('ul', { style: { margin: 0, padding: 0, listStyle: 'none' } }, rows),
      )
    }

    /**
     * One card being edited.
     * @param props.view - `{ draft, original }`.
     * @param props.onChange - called with the next draft.
     * @param props.onClose - return to the list, reloading it.
     */
    function CardEditor({ view, onChange, onClose }) {
      const [openGroup, setOpenGroup] = react.useState('identity')

      const idLocked = view.original !== null
      const groups = editorGroups()

      return react.createElement(
        'div',
        { style: { lineHeight: 1.7 } },
        react.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' } },
          react.createElement(Button, { size: 'sm', onClick: onClose }, '返回'),
          idLocked
            ? react.createElement('span', { style: { opacity: 0.75 } }, `id: ${view.draft.id}`)
            : react.createElement(Input, {
                value: view.draft.id ?? '',
                placeholder: 'id（小写字母、数字、连字符）',
                onChange: (event) => onChange(withField(view.draft, 'id', event.target.value)),
              }),
        ),
        react.createElement('div', { style: { margin: '8px 0' } },
          react.createElement('div', { style: { opacity: 0.75, marginBottom: '4px' } }, '名称'),
          react.createElement(Input, {
            value: view.draft.name ?? '',
            onChange: (event) => onChange(withField(view.draft, 'name', event.target.value)),
          }),
        ),
        groups.map(group => react.createElement(EditorGroup, {
          key: group.key,
          group,
          draft: view.draft,
          open: openGroup === group.key,
          onToggle: () => setOpenGroup(previous => (previous === group.key ? null : group.key)),
          onChange,
        })),
      )
    }
```

**这段有一个已写入 spec 的已知缺口**：保存、预览、脏检测与「放弃修改」在 Task 6 补齐。Task 5 的交付物是"能进编辑器、能改字段、能返回"。

- [ ] **Step 7: 运行测试**

Run: `node --test test/client.test.js`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/client.js test/client.test.js
git commit -m "feat: the editor shell, and the two helpers that keep unknown fields

fieldOf and withField read and write one nested path on a cloned card, which is
the mechanism behind the preservation promise: only the named path is assigned,
so an unknown key such as the old budget block survives a save. Rebuilding the
card from a field list would have deleted it on the first edit.

The form is five DisclosureRow groups carrying their D2 impact badges, and
every control comes from the primitives package - no native select, textarea,
or default-styled input."
```

---

### Task 6: 预览、脏状态、保存、重新应用

**Files:**
- Modify: `src/client.js`
- Test: `test/client.test.js`

**Interfaces:**
- Consumes: Task 3/4 的路由；Task 5 的 `fieldOf` / `withField` / `isDirty` / `editorGroups`
- Produces: 无新导出

- [ ] **Step 1: 给 `CardEditor` 加预览与保存**

替换 Task 5 的 `CardEditor` 为：

```js
    /**
     * One card being edited.
     *
     * The preview is debounced because it round-trips to the host, which owns
     * the format rules; the client never renders a second time to guess what a
     * card costs.
     * @param props.view - `{ draft, original }`.
     * @param props.onChange - called with the next draft.
     * @param props.onClose - return to the list, reloading it.
     */
    function CardEditor({ view, onChange, onClose }) {
      const [openGroup, setOpenGroup] = react.useState('identity')
      const [preview, setPreview] = react.useState({ status: 'idle' })
      const [saveError, setSaveError] = react.useState(null)
      const [confirmDiscard, setConfirmDiscard] = react.useState(false)

      const dirty = isDirty(view.draft, view.original)

      react.useEffect(() => {
        let cancelled = false
        const handle = setTimeout(async () => {
          const answer = await postJson('/cards/preview', { card: view.draft })
          if (cancelled) return
          setPreview(answer === undefined
            ? { status: 'error', error: '无法连接宿主' }
            : { status: 'ready', ...answer })
        }, 300)
        return () => { cancelled = true; clearTimeout(handle) }
      }, [view.draft])

      const valid = preview.status === 'ready' && preview.valid === true
      const canSave = valid

      const save = async () => {
        setSaveError(null)
        const isNew = view.original === null
        const path = isNew ? '/cards' : `/cards/${encodeURIComponent(view.draft.id)}`
        const answer = await (isNew ? postJson(path, { card: view.draft }) : putJson(path, { card: view.draft }))
        if (answer === undefined || answer.ok !== true) {
          setSaveError(answer?.error ?? '保存失败')
          return
        }
        onClose()
      }

      const leave = () => {
        if (!dirty) { onClose(); return }
        if (!confirmDiscard) { setConfirmDiscard(true); return }
        onClose()
      }

      const groups = editorGroups()

      return react.createElement(
        'div',
        { style: { lineHeight: 1.7 } },
        react.createElement('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px' } },
          react.createElement(Button, { size: 'sm', onClick: leave },
            dirty ? (confirmDiscard ? '确认放弃？' : '放弃修改') : '返回'),
          idLockedField(view, onChange),
          react.createElement(Button, { size: 'sm', onClick: () => { void save() }, disabled: !canSave }, '保存'),
        ),
        saveError === null ? null : react.createElement('p', { style: { opacity: 0.8 } }, saveError),
        nameField(view, onChange),
        groups.map(group => react.createElement(EditorGroup, {
          key: group.key,
          group,
          draft: view.draft,
          open: openGroup === group.key,
          onToggle: () => setOpenGroup(previous => (previous === group.key ? null : group.key)),
          onChange,
        })),
        previewPanel(preview),
      )
    }
```

`CardEditor` 里用到的三个小渲染函数，放在它之前：

```js
    /** The id row: an input while creating, plain text after that. */
    function idLockedField(view, onChange) {
      if (view.original !== null) {
        return react.createElement('span', { style: { opacity: 0.75 } }, `id: ${view.draft.id}`)
      }
      return react.createElement(Input, {
        value: view.draft.id ?? '',
        placeholder: 'id（小写字母、数字、连字符）',
        onChange: (event) => onChange(withField(view.draft, 'id', event.target.value)),
      })
    }

    /** The name row. */
    function nameField(view, onChange) {
      return react.createElement('div', { style: { margin: '8px 0' } },
        react.createElement('div', { style: { opacity: 0.75, marginBottom: '4px' } }, '名称'),
        react.createElement(Input, {
          value: view.draft.name ?? '',
          onChange: (event) => onChange(withField(view.draft, 'name', event.target.value)),
        }),
      )
    }

    /** Size and D5 advisories. */
    function previewPanel(preview) {
      if (preview.status === 'idle') return null
      if (preview.status === 'error') return react.createElement('p', { style: { opacity: 0.8 } }, preview.error)
      if (preview.valid !== true) return react.createElement('p', { style: { opacity: 0.8 } }, preview.error)
      return react.createElement('div', { style: { marginTop: '12px', opacity: 0.85 } },
        react.createElement('div', null, `${preview.tokens} token · ${preview.chars} 字符`),
        (preview.warnings ?? []).map(warning =>
          react.createElement('div', { key: warning.code, style: { marginTop: '4px' } }, `⚠ ${warning.message}`)),
      )
    }
```

- [ ] **Step 2: 让 `postJson` 带回错误，并加 `putJson`**

现在的 `postJson` 在 `!res.ok` 时返回 `undefined`，编辑器就拿不到 409 / 400 的 `code` 与
`error`——保存失败只会显示一句无信息量的"保存失败"。改成始终返回解析后的 body。

替换现有的 `postJson`：

```js
    /**
     * POST JSON.
     * @returns the parsed body; on a non-2xx status the body's own error fields
     *   are kept with `ok: false` forced, so callers can say why. Undefined only
     *   when the request itself failed.
     */
    async function postJson(path, body) {
      try {
        const res = await fetch(`${ROUTE}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const payload = await res.json().catch(() => ({}))
        if (res.ok) return payload
        return { ok: false, code: payload.code ?? 'http', error: payload.error ?? `HTTP ${res.status}` }
      } catch {
        return undefined
      }
    }

    /** PUT JSON, with the same error shape as postJson. */
    async function putJson(path, body) {
      try {
        const res = await fetch(`${ROUTE}${path}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const payload = await res.json().catch(() => ({}))
        if (res.ok) return payload
        return { ok: false, code: payload.code ?? 'http', error: payload.error ?? `HTTP ${res.status}` }
      } catch {
        return undefined
      }
    }
```

现有的调用点（切卡控件的 `choose`、默认卡切换）忽略返回值，这次改动对它们无影响。

- [ ] **Step 3: 在列表行加「重新应用」**

把 Task 5 的行渲染里 `entry.sessionsUsing > 0` 那一支改成：

```js
        entry.sessionsUsing > 0
          ? react.createElement('span', { style: { opacity: 0.7, whiteSpace: 'nowrap', display: 'inline-flex', gap: '6px', alignItems: 'center' } },
              `${entry.sessionsUsing} 个会话正在使用`,
              react.createElement(Button, {
                size: 'sm',
                onClick: async () => {
                  await postJson(`/cards/${encodeURIComponent(entry.id)}/apply`, {})
                  void reload()
                },
              }, '重新应用'),
            )
          : null,
```

- [ ] **Step 4: 导出供测试的新函数**

`return { apply, editorGroups, fieldOf, initialSelection, isDirty, switcherEntries, switcherMode, withField }`

- [ ] **Step 5: 测试通过**

Run: `node --test test/client.test.js`
Expected: PASS

- [ ] **Step 6: 全量测试**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/client.js test/client.test.js
git commit -m "feat: live preview, explicit save, and an opt-in re-apply

Every edit round-trips to the host's preview route 300ms after typing stops, so
the token figure and the D5 advisories come from the same renderer the model
will see rather than a second implementation on the client. Saving is disabled
until the draft is valid.

Leaving with unsaved work takes two clicks and no modal: the first turns the
button into a confirmation, the second discards. A card that is in use says so,
and applying the new version to those sessions is a separate deliberate press."
```

---

### Task 7: 活体验证

**Files:** 无（验证清单）

- [ ] **Step 1: 重启并检查路由**

```bash
for p in $(netstat -ano | grep -i listening | grep 127.0.0.1: | sed 's/.*127.0.0.1:\([0-9]*\).*/\1/' | sort -un); do
  curl -s -m 2 "http://127.0.0.1:$p/dsh-character-cards/cards" | grep -q '"cards"' && echo "PORT=$p"
done
```

Expected: 一个端口。`curl -s http://127.0.0.1:$P/dsh-character-cards/cards` 里每条摘要都带 `sessionsUsing`，且**没有** `maxTokens` / `truncated`。

- [ ] **Step 2: 预览**

```bash
curl -s -X POST http://127.0.0.1:$P/dsh-character-cards/cards/preview \
  -H 'content-type: application/json' \
  -d '{"card":{"dshcd":1,"id":"probe","constraints":["a"]}}'
```

Expected: `valid:true`，带 `chars` / `tokens`，`warnings: []`。

- [ ] **Step 3: 设置页**

打开设置 →「角色卡」：

- 看到默认卡选择器（`Pill` + `Menu`，不是原生 select）
- 看到「新建卡片」
- 每行可点进编辑器
- **编辑器里没有任何 Windows 原生控件**

- [ ] **Step 4: 新建并保存**

点「新建卡片」→ 填 `id`（如 `probe-card`）和名称 → 展开「表达」改语气 → 保存。

Expected: 回到列表，`~/.dsh/character-cards/probe-card.dshcd` 存在且内容包含 `dshcd: 1`。

- [ ] **Step 5: 未知字段往返**

```bash
printf '%s\n' '{"dshcd":1,"id":"legacy","name":"旧卡","budget":{"maxTokens":400}}' \
  > ~/.dsh/character-cards/legacy.dshcd
```

在设置页打开 `legacy` → 改名称 → 保存 → 检查文件：

```bash
cat ~/.dsh/character-cards/legacy.dshcd | grep budget
```

Expected: `"budget"` 仍在。**这是 GOAL D6 的验收点。**

- [ ] **Step 6: 重新应用**

把一张**正在被使用**的卡的名称或约束改掉 → 保存 → 列表该行显示「N 个会话正在使用」→ 点「重新应用」：

```bash
curl -s http://127.0.0.1:$P/dsh-character-cards/status | grep -o '"chars":[0-9]*'
```

Expected: 该 session 的 `chars` 变成新渲染的长度。

- [ ] **Step 7: 清理测试卡**

```bash
rm -f ~/.dsh/character-cards/probe-card.dshcd ~/.dsh/character-cards/legacy.dshcd
```

---

## Self-Review

**Spec coverage**

| spec 节 | 落在哪 |
|---|---|
| §3.1 移除预算、不截断 | Task 1 |
| §3.2 删除的概念 | Task 1 |
| §4.1 五条路由 | Task 3（预览/新建/更新/读取）、Task 4（apply） |
| §4.2 id 白名单 + 原子写入 | Task 2 |
| §4.3 预览复用宿主规则 + `inspectCard` 重构 | Task 1（拆分）、Task 3（路由与 `cardWarnings`） |
| §4.4 sessionsUsing / apply | Task 4 |
| §4.5 保存不重绑 | Task 4（提交说明与实现都只做显式 apply） |
| §5.1 `structuredClone` + 只改已知字段 | Task 5 `withField`，Task 6 保存 |
| §5.2 两个视图 | Task 5 |
| §5.3 列表入口、使用数、重新应用 | Task 5（入口）、Task 4（计数）、Task 6（按钮） |
| §5.4 五组 + D2 徽章 + 原语控件 | Task 5 |
| §5.5 实时预览 | Task 6 |
| §5.6 脏状态、两次确认 | Task 6 |
| §5.7 保存后回列表 | Task 6 |
| §6 失败与边界 | Task 2/3/4 的路由分支 + Task 6 的 `saveError` |
| §7.1 离线验证 | Task 1–6 的测试 |
| §7.2 活体验证 | Task 7 |

**Placeholder 扫描**：无 TBD/TODO。Task 5 Step 3 里的 `editorGroups()` 完整列出全部字段。Task 7 的端口变量 `$P` 由 Step 1 产出。

**类型一致性**：
- `writeCardFile` 返回 `{ ok, id } | { ok, code, error }`，Task 3 与 Task 6 的保存分支都按 `ok` / `code` / `error` 读取。
- `listCardSummaries` 返回 `{ id, name, description, chars, tokens }`（Task 1），Task 4 在其上追加 `sessionsUsing`，Task 5 的行渲染读 `entry.tokens` / `entry.sessionsUsing`。
- `inspectCard` 返回 `{ card } | { error }`，Task 3 的三条路由统一用 `'error' in inspected` 判定。
- `measure` 返回 `{ chars, tokens }`，Task 1 的 `renderCardById` 与 Task 3 的预览都用展开写入。

**两处刻意的取舍，已在正文标注**：
1. Task 5 的编辑器骨架**不含保存**——保存依赖 Task 3 的路由，放在 Task 6，避免 Task 5 的测试依赖尚不存在的接口。
2. `src/client.js` 保持在单文件内，因为经典的 `__ModuleLoader__` factory 没有模块导入机制；用函数拆分控制可读性。
