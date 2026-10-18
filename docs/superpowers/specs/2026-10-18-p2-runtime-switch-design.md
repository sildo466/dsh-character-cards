# P2 设计 · 运行时切卡

日期：2026-10-18
上游：`GOAL.md`（D9 激活模型、D10 换卡免重启、§4 实测结论）
前置：P0（插件骨架）、P1（卡片库 + 注入管线）已完成

---

## 1. 目标

**一个 session 内点一下切卡，下一轮回答就变。**

同时提供全局默认卡的切换。两者由**同一个组件**承担，靠它有没有拿到
`sessionId` 自动分形。

### 验收

1. 打开一个 session，切卡 → **下一轮**回答的语气/代码风格明显变
2. 切回「跟随默认」→ 变回默认卡的效果
3. 在插件设置页切换全局默认 → 之后**新建**的 session 用新默认
4. 切换过程中 dsh 其余 UI 完全不受影响

第 1、2 条的硬证据不是"读回答感觉像"，而是 status 路由 `assembles[].ourChars`
的数值变化（见 §7）。

---

## 2. 范围

**做**

- 宿主：三个 HTTP 路由 + 运行时重绑
- 客户端：一个自适应组件，挂到已验证的 slot 上
- 一次 slot 发现（外部步骤，见 §6）

**不做**

- 自定义弹层 / chip / token 数值展示 → P3
- 卡片编辑、导入导出 → P4
- slot 发现的自动化
- 改变已发生的历史（见 §5）

---

## 3. 解析顺序（P1 已实现，此处只作前提）

```
sessions.json[sessionId]  →  default 指针  →  不绑（原生行为）
```

P2 新增的是**运行时改变**这条链上第一环的能力。

---

## 4. 宿主

### 4.1 路由

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-character-cards/cards` | 卡片库全表 + `defaultCard` |
| GET | `/dsh-character-cards/session/<id>` | 该 session 生效的卡 + 来源 |
| POST | `/dsh-character-cards/session/<id>/card` | body `{ cardId }` 或 `{ cardId: null }` |

`{ cardId: null }` = **删除该 session 的覆盖记录**（不是写一个特殊值）。
这样 `sessions.json` 里永远只有"有覆盖"的 session。

全部沿用已有的 `guard()`（loopback + Host 校验；Origin 仅在存在时校验——桌面版
不发 Origin，见 GOAL D8）。响应形状沿用已有的 `{ ok, ... }` 约定。

### 4.2 重绑机制（本节唯一的真实失败模式）

**不能**用 `agent.ctx.inject(...)` 返回的 fiber 来重绑——它的 `dispose()` 是**异步**的，
中间存在一个窗口 session 没有卡；若撞上 `assemble()`，那一轮就掉卡。

**做法**：在 inject 回调内把 `section()` 返回的 disposer 存起来；重绑时**同步**执行
`dispose 旧的 → 注册新的`。

`SystemPrompt.assemble()` 开头是**同步**抓取 section 表的，因此同一 tick 内换完
不会有轮次掉卡。这一点必须有测试钉住（见 §7）。

`NamedEntries.insert()` 的 undo 会 `data.delete(name)`，所以同名重注册不会撞重名
（`packages/core/scope/src/store.ts:38`，GOAL §4.2）。

### 4.3 目标 session 没有 live agent 时

`ctx.agents.get(id)` 找不到 → **照样写盘**，不重绑，**不是错误**。
覆盖记录留着，等该 session 下次创建 / resume 时由 `agent/created` 生效。

### 4.4 重绑失败

`section()` 抛异常（例如又一次 API 漂移）→ 记进 `bindErrors`，
**旧卡保持不变**。绝不能把 session 弄成"无卡"状态——那比切卡失败更糟。

---

## 5. 客户端

### 5.1 组件契约

```
props.sessionId 存在  →  按 session 切卡（打 /session/<id>/*）
props.sessionId 不存在 →  切全局默认（写 default 指针）
```

**同一个组件、同一份代码。** 挂哪个 slot 就自动是哪种行为。

### 5.2 交互

原生 `<select>`：

| 模式 | 选中项 | 选项列表 |
|---|---|---|
| 按 session | 该 session **生效**的卡（若有覆盖则是那张；否则是默认卡） | 全部卡 + 末项「跟随默认」 |
| 全局 | 当前默认卡 | 全部卡（无「跟随默认」项） |

按 session 模式下，**选中「跟随默认」= 发 `{ cardId: null }` 删除覆盖记录**。
因此下拉显示的是**生效的卡**而不是"覆盖的卡"——没有覆盖时显示默认卡但选中项是「跟随默认」，
这一区别靠选项列表的勾选位置表达。

全局模式额外渲染一份**只读**卡片库列表（`id` / `name` / token 占用），数据来自同一个
`GET /cards`，无交互元素。这是 P3 完整管理面板的雏形，P2 不做任何编辑动作。

**故意用原生 `<select>`，不做自定义弹层。** 弹层要处理定位、z-index、被容器裁切——
全是 D7 式"能弄坏 UI"的东西，而 P2 的看点是切卡生效，不是控件好看。P3 再升级。

代价：原生选项是纯文本，放不下 token 数。这是明确的取舍，不是疏漏。

### 5.3 错误处理（D7）

- `apply` 全程 try/catch；任何依赖用前判空
- `fetch` 失败 → 控件停在惰性态，不抛、不白屏
- `slots.inject(key, cb)` 对不存在的 key 是**静默不触发**（安全）
- `slots.register()` 打到**未声明**的 slot 会**失败**（`docs/subsystems/slots.md:13`）
  ——所以只对已验证存在的 key 注册。**这是 §6 发现步骤存在的理由。**
- 卡片库为空、或 `default` / 覆盖指向不存在的卡 → 控件显示「未设置」并保持可用，
  不炸。解析侧已由 P1 的 `resolveCardFor` 处理（告警 + 落到下一级），
  客户端只需正确渲染"无卡"这个正常状态。

---

## 6. 挂载：两步

### 第一步（现在就能做）— `plugins.row.config`

P0 已验证可用的 slot（`dsh-delete-session` 用它，实测正常）。挂上去演**全局默认切换**，
验证整条客户端链路：组件能渲染 → 能 fetch → 能写 `default`。

### 第二步（需要一次发现）— 输入框上方、分支旁边

用户要求控件放在**对话框上方、「分支」旁边**。

检出源（0.1.3）里的候选：

```ts
'conversation.input.left':  { kind: 'list', scope: 'session' }
'conversation.input.right': { kind: 'list', scope: 'session' }
```

形状理想：`session` scope 拿得到 `sessionId`；`list` 是**纯增量**，给个新 `id` 即可，
**顶不掉任何东西**（`slots.md:58`）。对比 `conversation.composer.bar` 是
`single` + `session-maybe`——替换点，D7 意义上的危险形状。

**但检出源里 composer 那行没有「分支」控件**，所以它来自 0.2.x 原生或某个已装插件。
slot 名在 0.1.3 与 0.2.x 之间确实变过（铁证：`plugins.row.config` 在检出源里不存在），
因此**必须发现，不能猜**。

#### 发现指令（交给用户在创造模式 session 里执行）

> 用 `cordis_inspect` 列出客户端 slot 树，回答三个问题：
>
> 1. `conversation.input.left` 和 `conversation.input.right` 在 0.2.x 里还在吗？
>    给出各自完整契约：kind、scope、注册选项（id/key/order）、owner props、标准 props。
> 2. 这两个 slot 现在**分别被谁占着、各自显示什么**？找出「分支」在哪一个里，
>    以便决定挂在它左边还是右边、用什么 `order`。
> 3. 若两者都不存在，输入框那一行附近还有哪些 **session 作用域、list 型**的 slot？

### 兜底

若找不到合适的 session slot 或其契约不匹配：

**退到 `settings.section`（root 作用域）**，做一个正经的卡片管理面板——列表 +
token 占用 + 全局默认切换 + **每个 session 当前卡只读展示**。

按 session 切卡则靠 HTTP 路由（§4）直接调用，入口留到 P3。

**这个兜底不丢 P2 的核心**：运行时重绑机制照建、照能验，只是按 session 的入口暂时没有家。

---

## 7. 验证

### 7.1 离线 — `scripts/dryrun.mjs` 扩展

模拟"绑 A → 重绑 B"：

- 断言最终 section 文本只含 B
- 断言**重绑期间名字没被占用冲突**（证明 dispose 真的释放了名字）
- 断言重绑后文本长度等于 B 的长度

### 7.2 活体 — 用 P1 留下的仪器，不靠主观感受

```
POST /session/<id>/card  { "cardId": "patient-teacher" }
→ status.assembles[0].ourChars  应从 152 变为 184
```

`assembles[]`（监听 `system-prompt/assemble` 瀑布事件）是 P1 调试时留下的资产，
能直接读出**真实装配出的 section 列表**。切卡是否真的换了提示词，看数值即可。

回滚验证：`POST { "cardId": null }` → `ourChars` 变回默认卡的数。

### 7.3 交互

一个 session 内切卡 → 下一轮回答风格变；切「跟随默认」→ 变回去。

---

## 8. 风险

| 风险 | 应对 |
|---|---|
| 0.2.x 里 `conversation.input.left` / `.right` 已改名或不存在 | 发现步骤先确认；兜底走 §6 的 settings 面板 |
| 注册到未声明的 slot 导致客户端组合失败（D7 事故形状） | 只对已验证 key 注册；`list` + 新 `id` 是增量形式，顶不掉别人 |
| 重绑出现一轮掉卡 | §4.2 的同步 dispose+register；§7.1 用测试钉住 |
| `fetch` 在桌面版被 403 | 复用已验证的 `guard()`——P0 实测过桌面版无 Origin 请求返回 200 |
| 需再引入未验证 API（如 remote 服务） | **不引入**。方案 A 只用已验证的 HTTP 路由模式 |

---

## 9. 未决 / 留给后续

- `sessions.json` 的 key 是完整 session id（形如 `session-3a4f...`），手改很不友好 → P3 的 UI 自然解决
- 切卡让 prompt cache 失效一次——接受，不额外处理
- 卡片组件的视觉升级（chip + 弹层 + token）→ P3
- slot 发现能否不必人工执行 → 观察
