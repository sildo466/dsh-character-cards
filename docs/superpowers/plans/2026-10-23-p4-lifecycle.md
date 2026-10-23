# P4 卡片生命周期实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在设置页完成单卡的导入、导出、复制、删除，并保证 `.dshcd` 往返零丢失。

**Architecture:** 文件 I/O 留在浏览器；宿主只新增 `DELETE /cards/<id>`，负责删文件、清覆盖表、清默认指针、解绑 live session。导入的版本兼容由客户端在警告后重写为 `dshcd: 1`，复用现有创建路由。

**Tech Stack:** Node 22、`node:test`、原生 fetch / Blob / File API、现有 dsh 客户端模块协议。

## Global Constraints

- 客户端插件必须满足 D7：`apply()` 全程 try/catch，依赖用前判空，缺原语时降级，不抛出。
- 宿主路由不得依赖 `Origin` / `Referer`（D8）。
- 卡片 id：`^[a-z0-9][a-z0-9-]*$`，最长 64。
- 写入保持原子性（临时文件 + rename）；删除是唯一新增的文件操作。
- 代码、注释、文档、提交信息禁止 emoji。
- 测试只跑单文件：`node --test test/cards.test.js`、`node --test test/routes.test.js`、`node --test test/client.test.js`。
- 每个任务结束都要提交。

---

## File Structure

- `src/cards.js`：新增删除、清默认指针、批量解绑覆盖表三个存储函数。
- `src/index.js`：在 `/cards/<id>` 前缀路由增加 DELETE。
- `src/client.js`：新增纯函数、`deleteJson`、导入/导出/复制/删除 UI 与提示条。
- `test/cards.test.js`、`test/routes.test.js`、`test/client.test.js`：对应测试。
- `GOAL.md`：P4 完成后更新阶段表与路由清单。

---

### Task 1: 存储层删除原语

**Files:**
- Modify: `src/cards.js`（`writeCardFile` 之后、`readDefaultCardId` 之后、`setSessionOverride` 之后）
- Test: `test/cards.test.js`

**Interfaces:**
- Produces:
  - `deleteCardFile(dir, id, logger): { ok: true } | { ok: false, code: 'invalid-id' | 'not-found' | 'delete-failed', error: string }`
  - `clearDefaultCardId(dir, logger): boolean`
  - `detachOverridesForCard(dir, cardId, logger): { ok: boolean, detached: number }`

- [ ] **Step 1: 写失败测试**

在 `test/cards.test.js` 的导入列表中加入三个函数：

```js
import {
  clearDefaultCardId, deleteCardFile, detachOverridesForCard,
} from '../src/cards.js'
```

在文件末尾追加：

```js
test('deleteCardFile removes an existing card and reports a missing one', () => {
  const dir = library({ 'terse.dshcd': TERSE })
  const logger = collector()
  assert.deepEqual(deleteCardFile(dir, 'terse', logger), { ok: true })
  assert.equal(cardExists(dir, 'terse'), false)
  assert.deepEqual(deleteCardFile(dir, 'terse', logger), {
    ok: false, code: 'not-found', error: 'no card "terse"',
  })
})

test('clearDefaultCardId removes the pointer and tolerates its absence', () => {
  const dir = library({})
  const logger = collector()
  writeFileSync(join(dir, 'default'), 'terse\n')
  assert.equal(clearDefaultCardId(dir, logger), true)
  assert.equal(readDefaultCardId(dir), undefined)
  assert.equal(clearDefaultCardId(dir, logger), true)
})

test('detachOverridesForCard turns only matching pins into explicit none', () => {
  const dir = library({})
  const logger = collector()
  setSessionOverride(dir, 's1', 'terse', logger)
  setSessionOverride(dir, 's2', 'teacher', logger)
  setSessionOverride(dir, 's3', null, logger)
  assert.deepEqual(detachOverridesForCard(dir, 'terse', logger), { ok: true, detached: 1 })
  assert.deepEqual(readSessionOverrides(dir, logger), { s1: null, s2: 'teacher', s3: null })
  assert.deepEqual(detachOverridesForCard(dir, 'ghost', logger), { ok: true, detached: 0 })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/cards.test.js`
Expected: FAIL，报 `deleteCardFile is not a function`。

- [ ] **Step 3: 实现存储函数**

在 `src/cards.js` 的 `node:fs` 导入中加入 `unlinkSync`：

```js
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
```

在 `writeCardFile` 之后加入：

```js
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
```

在 `setDefaultCardId` 之后加入：

```js
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
```

在 `clearSessionOverride` 之后加入：

```js
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/cards.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```sh
git add src/cards.js test/cards.test.js
git commit -m "feat(host): add card deletion storage primitives"
```

---

### Task 2: DELETE 路由与 live 解绑

**Files:**
- Modify: `src/index.js`（导入列表；`/cards/<id>` 前缀路由）
- Test: `test/routes.test.js`

**Interfaces:**
- Consumes: Task 1 的三个函数。
- Produces: `DELETE /dsh-character-cards/cards/<id>` → `{ ok, id, detached, rebound, warnings }`。

- [ ] **Step 1: 写失败测试**

在 `test/routes.test.js` 末尾追加：

```js
test('DELETE /cards/<id> removes the card and reports it', async () => {
  writeFileSync(join(cardsDir, 'doomed.dshcd'), card('doomed', '临时卡', '审阅者'))
  const res = await harness().call('/dsh-character-cards/cards/doomed', { method: 'DELETE' })
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.equal(res.body.id, 'doomed')
  assert.equal(cardExists(cardsDir, 'doomed'), false)
})

test('DELETE /cards/<id> is 404 for a missing card', async () => {
  const res = await harness().call('/dsh-character-cards/cards/ghost', { method: 'DELETE' })
  assert.equal(res.status, 404)
  assert.equal(res.body.code, 'not-found')
})

test('DELETE detaches pins, clears a default pointer, and unbinds live agents', async () => {
  writeFileSync(join(cardsDir, 'doomed.dshcd'), card('doomed', '临时卡', '导师'))
  writeFileSync(join(cardsDir, 'default'), 'doomed\n')
  const agent = agentStub('session-live')
  const routes = harness({ get: (id) => (id === 'session-live' ? agent : undefined), list: () => [agent] })

  await routes.call('/dsh-character-cards/session/session-live/card', { method: 'POST', body: { cardId: 'doomed' } })
  await new Promise(resolve => setTimeout(resolve, 0))

  const res = await routes.call('/dsh-character-cards/cards/doomed', { method: 'DELETE' })
  assert.equal(res.status, 200)
  assert.equal(res.body.detached, 1)
  assert.equal(res.body.rebound, 1)
  assert.equal(readSessionOverrides(cardsDir, {})['session-live'], null)
  assert.equal(readDefaultCardId(cardsDir), undefined)

  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(agent.events.slice(-2), ['dispose', 'fiber-dispose'])

  // Restore the shared fixture for later tests.
  writeFileSync(join(cardsDir, 'default'), 'terse\n')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/routes.test.js`
Expected: 新测试 FAIL，DELETE 返回 405（当前只接受 GET/PUT）。

- [ ] **Step 3: 实现 DELETE 分支**

在 `src/index.js` 的 `./cards.js` 导入列表中加入：

```js
  clearDefaultCardId,
  deleteCardFile,
  detachOverridesForCard,
```

在 `/cards/<id>` 前缀路由中，`wantsApply` 分支之后、`if (req.method === 'GET')` 之前加入：

```js
      if (req.method === 'DELETE') {
        // Snapshot who resolves to this card before it disappears: after the
        // unlink they would resolve elsewhere and we could no longer find them.
        const affected = sessionsUsing(ctx, id)
        const deleted = deleteCardFile(CARDS_DIR, id, ctx.logger ?? {})
        if (!deleted.ok) {
          sendJson(res, deleted.code === 'not-found' ? 404 : 500, {
            ok: false, code: deleted.code, error: deleted.error,
          })
          return
        }

        // The file is the commit point. Cleanup failures are reported, not
        // rolled back, so the caller never believes the card still exists.
        const warnings = []
        const detached = detachOverridesForCard(CARDS_DIR, id, ctx.logger ?? {})
        if (!detached.ok) warnings.push('session overrides could not be written')
        if (readDefaultCardId(CARDS_DIR) === id && !clearDefaultCardId(CARDS_DIR, ctx.logger ?? {})) {
          warnings.push('default pointer could not be cleared')
        }

        let rebound = 0
        const agents = ctx.get('agents')
        for (const sessionId of affected) {
          const agent = agents?.get(sessionId)
          if (agent === undefined) continue
          rebind(agent, sessionId, ctx.logger ?? {})
          rebound += 1
        }

        sendJson(res, 200, { ok: true, id, detached: detached.detached, rebound, warnings })
        return
      }
```

同时把后面的方法错误文案从 `GET or PUT only` 保持不变（DELETE 已提前返回）。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/routes.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```sh
git add src/index.js test/routes.test.js
git commit -m "feat(host): delete a card and detach every reference"
```

---

### Task 3: 客户端纯函数

**Files:**
- Modify: `src/client.js`（`withField` 之后；模块返回对象）
- Test: `test/client.test.js`

**Interfaces:**
- Produces:
  - `sanitizeCardId(value): string`
  - `uniqueCardId(base, ids): string`
  - `prepareImport(card, ids): { card, renamed, versionWarning }`

- [ ] **Step 1: 写失败测试**

在 `test/client.test.js` 末尾追加：

```js
test('uniqueCardId keeps a free base and adds suffixes when taken', () => {
  const { uniqueCardId } = loaded.factory(makeFakeRequire())
  assert.equal(uniqueCardId('new-card', []), 'new-card')
  assert.equal(uniqueCardId('new-card', ['new-card']), 'new-card-2')
  assert.equal(uniqueCardId('new-card', ['new-card', 'new-card-2']), 'new-card-3')
  assert.equal(uniqueCardId('My Card', []), 'my-card')
})

test('uniqueCardId never exceeds the 64 character id limit', () => {
  const { uniqueCardId } = loaded.factory(makeFakeRequire())
  const base = 'a'.repeat(64)
  const id = uniqueCardId(base, [base])
  assert.equal(id.length, 64)
  assert.match(id, /^a+-2$/)
})

test('prepareImport renames, warns on version, and preserves unknown fields', () => {
  const { prepareImport } = loaded.factory(makeFakeRequire())
  const source = { dshcd: 2, id: 'Bad ID', name: 'x', futureField: { nested: true } }
  const prepared = prepareImport(source, ['bad-id'])
  assert.equal(prepared.card.id, 'bad-id-2')
  assert.equal(prepared.renamed, true)
  assert.equal(prepared.versionWarning, true)
  assert.equal(prepared.card.dshcd, 1)
  assert.deepEqual(prepared.card.futureField, { nested: true })
  assert.equal(source.dshcd, 2, 'the parsed input is not mutated')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/client.test.js`
Expected: FAIL，`uniqueCardId is not a function`。

- [ ] **Step 3: 实现纯函数**

在 `src/client.js` 的 `withField` 之后加入：

```js
    /**
     * Coerce any string into a valid card id.
     * @param value - the requested id.
     * @returns a lowercase, hyphen-separated id of at most 64 characters.
     */
    function sanitizeCardId(value) {
      const cleaned = String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
      return cleaned.length === 0 ? 'imported-card' : cleaned.slice(0, 64)
    }

    /**
     * First free id derived from a base.
     * @param base - the preferred id.
     * @param ids - ids already taken.
     * @returns a valid, unused id.
     */
    function uniqueCardId(base, ids) {
      const taken = new Set(ids)
      const root = sanitizeCardId(base)
      if (!taken.has(root)) return root
      for (let n = 2; ; n += 1) {
        const suffix = `-${n}`
        const candidate = `${root.slice(0, 64 - suffix.length)}${suffix}`
        if (!taken.has(candidate)) return candidate
      }
    }

    /**
     * Prepare a parsed .dshcd for the create route.
     *
     * The host write route accepts v1 only. Restamping an unfamiliar version is
     * how "accept with a warning" is implemented without weakening every other
     * reader; every unknown field still survives.
     * @param card - the parsed object.
     * @param ids - ids already taken.
     * @returns `{ card, renamed, versionWarning }`.
     */
    function prepareImport(card, ids) {
      const copy = structuredClone(card)
      const original = copy.id
      const id = uniqueCardId(sanitizeCardId(original), ids)
      copy.id = id
      const versionWarning = copy.dshcd !== 1
      if (versionWarning) copy.dshcd = 1
      return { card: copy, renamed: id !== original, versionWarning }
    }
```

在模块返回对象中加入这三个名字：

```js
    return { apply, inject, editorGroups, fieldOf, initialSelection, isDirty, nextSelection, prepareImport, sanitizeCardId, switcherEntries, switcherMode, uniqueCardId, withField }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/client.test.js`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```sh
git add src/client.js test/client.test.js
git commit -m "feat(client): add import id helpers"
```

---

### Task 4: 导入、导出、复制

**Files:**
- Modify: `src/client.js`（`deleteJson`；`CardSettingsSection` 的状态、处理器、行与顶部工具栏）

**Interfaces:**
- Consumes: Task 3 的 `uniqueCardId` / `prepareImport`；现有 `getJson` / `postJson` / `reload`。
- Produces: `deleteJson(path)`（Task 5 使用）；`exportCard` / `copyCard` / `importFile`。

- [ ] **Step 1: 加入 `deleteJson`**

在 `putJson` 之后加入：

```js
    /** DELETE JSON, with the same error shape as postJson. */
    async function deleteJson(path) {
      try {
        const res = await fetch(`${ROUTE}${path}`, { method: 'DELETE' })
        const payload = await res.json().catch(() => ({}))
        if (res.ok) return payload
        return { ok: false, code: payload.code ?? 'http', error: payload.error ?? `HTTP ${res.status}` }
      } catch {
        return undefined
      }
    }
```

- [ ] **Step 2: 加入状态与处理器**

在 `CardSettingsSection` 的 `openError` 之后加入：

```js
      const [notice, setNotice] = react.useState(null)
      const [menuFor, setMenuFor] = react.useState(null)
      const [confirmDelete, setConfirmDelete] = react.useState(null)
      const fileInput = react.useRef(null)
```

在 `chooseDefault` 之后加入：

```js
      const showNotice = (tone, text) => setNotice({ tone, text })
      const ids = state.cards.map(entry => entry.id)
      const menuItems = [
        { id: 'export', label: '导出' },
        { id: 'copy', label: '复制' },
      ]

      const exportCard = async (cardId) => {
        setMenuFor(null)
        const payload = await getJson(`/cards/${encodeURIComponent(cardId)}`)
        if (payload?.card === undefined) {
          showNotice('error', '导出失败：无法读取卡片。')
          return
        }
        try {
          const blob = new Blob([`${JSON.stringify(payload.card, null, 2)}\n`], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = `${cardId}.dshcd`
          anchor.click()
          setTimeout(() => URL.revokeObjectURL(url), 0)
          showNotice('info', `已导出 ${cardId}.dshcd`)
        } catch {
          showNotice('error', '导出失败：浏览器拒绝下载。')
        }
      }

      const copyCard = async (entry) => {
        setMenuFor(null)
        const payload = await getJson(`/cards/${encodeURIComponent(entry.id)}`)
        if (payload?.card === undefined) {
          showNotice('error', '复制失败：无法读取卡片。')
          return
        }
        const copy = structuredClone(payload.card)
        copy.id = uniqueCardId(`${entry.id}-copy`, ids)
        copy.name = `${payload.card.name ?? entry.name ?? entry.id} 副本`
        const answer = await postJson('/cards', { card: copy })
        if (answer === undefined || answer.ok !== true) {
          showNotice('error', answer?.error ?? '复制失败')
          return
        }
        void reload()
        showNotice('info', `已复制为 ${copy.id}`)
      }

      const importFile = async (event) => {
        const input = event.target
        const file = input.files?.[0]
        input.value = ''
        if (file === undefined) return
        if (file.size > 1024 * 1024) {
          showNotice('error', '导入失败：文件超过 1 MiB。')
          return
        }
        let parsed
        try {
          parsed = JSON.parse(await file.text())
        } catch {
          showNotice('error', '导入失败：不是合法的 JSON。')
          return
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          showNotice('error', '导入失败：卡片必须是 JSON 对象。')
          return
        }
        let prepared = prepareImport(parsed, ids)
        let answer = await postJson('/cards', { card: prepared.card })
        if (answer?.code === 'exists') {
          prepared = prepareImport(parsed, [...ids, prepared.card.id])
          answer = await postJson('/cards', { card: prepared.card })
        }
        if (answer === undefined || answer.ok !== true) {
          showNotice('error', answer?.error ?? '导入失败')
          return
        }
        void reload()
        showNotice('info', prepared.versionWarning
          ? `已导入为 ${prepared.card.id}；版本未验证，已按当前格式读取。`
          : `已导入为 ${prepared.card.id}`)
      }
```

- [ ] **Step 3: 顶部加入导入**

在「默认角色卡」卡片的 `dshcc-rowline` 中，把 `新建卡片` 按钮替换为两个按钮，并在 `rowline` 之后加入隐藏 input：

```js
            react.createElement(Button, {
              variant: 'outline',
              onClick: () => fileInput.current?.click(),
            }, '导入'),
            react.createElement(Button, {
              variant: 'primary',
              onClick: () => { void openEditor(undefined) },
            }, '新建卡片'),
          ),
          react.createElement('input', {
            ref: fileInput,
            type: 'file',
            accept: '.dshcd,application/json',
            style: { display: 'none' },
            onChange: importFile,
          }),
```

- [ ] **Step 4: 行内加入“更多”菜单**

把 `rows` 中的 `dshcc-actions` 内容替换为：

```js
        react.createElement(
          'span',
          { className: 'dshcc-actions' },
          entry.sessionsUsing > 0
            ? react.createElement(Button, {
                size: 'sm',
                variant: 'outline',
                onClick: async () => {
                  const answer = await postJson(`/cards/${encodeURIComponent(entry.id)}/apply`, {})
                  setApplyError(answer === undefined || answer.ok !== true
                    ? (answer?.error ?? '重新应用失败')
                    : null)
                  void reload()
                },
              }, '重新应用')
            : null,
          react.createElement(Menu, {
            open: menuFor === entry.id,
            items: menuItems,
            onSelect: (action) => {
              setMenuFor(null)
              if (action === 'export') void exportCard(entry.id)
              else if (action === 'copy') void copyCard(entry)
            },
            onClose: () => setMenuFor(null),
            side: 'bottom',
            anchor: react.createElement(Pill, {
              active: menuFor === entry.id,
              onClick: () => setMenuFor(menuFor === entry.id ? null : entry.id),
            }, '更多'),
          }),
          react.createElement(Button, {
            size: 'sm',
            variant: 'ghost',
            onClick: () => { void openEditor(entry.id) },
          }, '编辑'),
        ),
```

- [ ] **Step 5: 加入提示条**

在 `openError` 提示之前加入：

```js
        notice === null
          ? null
          : react.createElement('p', {
              className: 'dshcc-callout',
              'data-tone': notice.tone === 'error' ? 'error' : undefined,
            }, notice.text),
```

- [ ] **Step 6: 语法与测试**

Run: `node --check src/client.js && node --test test/client.test.js`
Expected: syntax OK，14+ tests PASS。

- [ ] **Step 7: 提交**

```sh
git add src/client.js
git commit -m "feat(client): import, export, and copy cards"
```

---

### Task 5: 删除确认

**Files:**
- Modify: `src/client.js`（`menuItems`、`rows`、`removeCard`）

**Interfaces:**
- Consumes: Task 2 的 DELETE 路由；Task 4 的 `deleteJson`。

- [ ] **Step 1: 加入删除处理器**

在 `importFile` 之后加入：

```js
      const removeCard = async (entry) => {
        setConfirmDelete(null)
        const answer = await deleteJson(`/cards/${encodeURIComponent(entry.id)}`)
        if (answer === undefined) {
          showNotice('error', '删除失败：无法连接宿主。')
          return
        }
        if (answer.ok !== true) {
          showNotice('error', answer.error ?? '删除失败')
          return
        }
        void reload()
        const warnings = answer.warnings ?? []
        showNotice(warnings.length > 0 ? 'error' : 'info', warnings.length > 0
          ? `已删除 ${entry.id}，但引用清理未完全成功。`
          : `已删除 ${entry.id}，${answer.detached ?? 0} 个会话已改为不使用。`)
      }
```

- [ ] **Step 2: 菜单加入删除项**

把 `menuItems` 改为：

```js
      const menuItems = [
        { id: 'export', label: '导出' },
        { id: 'copy', label: '复制' },
        { id: 'delete', label: '删除' },
      ]
```

并在 `onSelect` 中加入：

```js
              else if (action === 'delete') setConfirmDelete(entry.id)
```

- [ ] **Step 3: 行内二次确认**

把 `dshcc-actions` 的内容改为先判断 `confirmDelete`：

```js
        react.createElement(
          'span',
          { className: 'dshcc-actions' },
          confirmDelete === entry.id
            ? [
                react.createElement('span', { key: 'ask', className: 'dshcc-meta' }, '确认删除？'),
                react.createElement(Button, {
                  key: 'yes',
                  size: 'sm',
                  variant: 'outline',
                  onClick: () => { void removeCard(entry) },
                }, '确认'),
                react.createElement(Button, {
                  key: 'no',
                  size: 'sm',
                  variant: 'ghost',
                  onClick: () => setConfirmDelete(null),
                }, '取消'),
              ]
            : [
                entry.sessionsUsing > 0
                  ? react.createElement(Button, {
                      key: 'apply',
                      size: 'sm',
                      variant: 'outline',
                      onClick: async () => {
                        const answer = await postJson(`/cards/${encodeURIComponent(entry.id)}/apply`, {})
                        setApplyError(answer === undefined || answer.ok !== true
                          ? (answer?.error ?? '重新应用失败')
                          : null)
                        void reload()
                      },
                    }, '重新应用')
                  : null,
                react.createElement(Menu, {
                  key: 'menu',
                  open: menuFor === entry.id,
                  items: menuItems,
                  onSelect: (action) => {
                    setMenuFor(null)
                    if (action === 'export') void exportCard(entry.id)
                    else if (action === 'copy') void copyCard(entry)
                    else if (action === 'delete') setConfirmDelete(entry.id)
                  },
                  onClose: () => setMenuFor(null),
                  side: 'bottom',
                  anchor: react.createElement(Pill, {
                    active: menuFor === entry.id,
                    onClick: () => setMenuFor(menuFor === entry.id ? null : entry.id),
                  }, '更多'),
                }),
                react.createElement(Button, {
                  key: 'edit',
                  size: 'sm',
                  variant: 'ghost',
                  onClick: () => { void openEditor(entry.id) },
                }, '编辑'),
              ],
        ),
```

- [ ] **Step 4: 语法与测试**

Run: `node --check src/client.js && node --test test/client.test.js`
Expected: syntax OK，全部 PASS。

- [ ] **Step 5: 提交**

```sh
git add src/client.js
git commit -m "feat(client): delete a card after inline confirmation"
```

---

### Task 6: 文档与整体验证

**Files:**
- Modify: `GOAL.md`（`## 9. 进度与下一步` 的阶段表；`### P3 落地后的接口` 路由清单）
- Modify: `docs/superpowers/specs/2026-10-23-p4-lifecycle-design.md`（如实现中产生偏差）

- [ ] **Step 1: 更新 GOAL 阶段表**

把 P3 状态改为 `✅ 完成`，P4 状态改为 `✅ 完成`。

- [ ] **Step 2: 更新路由清单**

在 `/dsh-character-cards` 接口列表中加入：

```
DELETE /dsh-character-cards/cards/<id>       删除（清覆盖表、清默认指针、解绑 live session）
```

- [ ] **Step 3: 跑全部离线测试**

Run: `node --test`
Expected: 全部 PASS。

- [ ] **Step 4: 活体验收**

重启 dsh，按顺序验证：

1. 新建一张卡 → 导出 → 删除 → 导入，字段与未知字段一致。
2. 导入同 id 的卡 → 自动改名为 `-2`。
3. 复制一张正在使用的卡 → 新卡独立，原卡会话不变。
4. 删除正在使用的卡 → 该会话下一轮回复不再带角色卡。
5. 删除默认卡 → 设置页显示「未设置」，新会话无卡。

- [ ] **Step 5: 提交**

```sh
git add GOAL.md docs/superpowers/specs/2026-10-23-p4-lifecycle-design.md
git commit -m "docs: record P4 completion and the delete route"
```

---

## Self-Review

- 规格覆盖：导入、导出、复制、删除、冲突改名、版本警告、默认清理、覆盖表清理、live 解绑、提示条、测试、文档，均有对应任务。
- 占位符：无 TBD / TODO；每个代码步骤都有完整代码。
- 类型一致性：`deleteCardFile` 返回 `{ ok, code?, error? }`；`detachOverridesForCard` 返回 `{ ok, detached }`；`clearDefaultCardId` 返回 boolean；路由消费方式与 Task 2 一致。
- 已知取舍：导入时把非 v1 重写为 v1 并警告；这是「接受并警告」在当前写入路由下的实现方式。
