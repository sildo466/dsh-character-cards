# GOAL — dsh 角色卡 / Agent 卡系统（dshcd）

> 这份文档只定义**目标、边界和已定的设计决策**，不是实现计划。
> 在 `C:\WinTool\my-dsh-plugin` 开新对话继续讨论时，先读这份。

---

## 0. 范围修正（2026-10-17）

**不做**：SillyTavern 卡、世界观 / lorebook / 情节扮演。

**只做 dsh 自己的身份层**：

- **语气**（tone）
- **人设**（identity / role）
- **性格**（traits）
- **代码风格**（code style）
- 以及可选的**工作方式**（workflow）与**硬约束**（constraints）

**对外格式**：`.dshcd`（DSH Character Definition），自定义、可导入导出。

**理由**：dsh 是编码 harness。扮演卡水土不服；"让 agent 用某种语气、按某种代码风格干活"是每个重度用户的真实需求，且市场里**没有任何插件做这件事**。

---

## 1. 一句话目标

给 dsh 一个**可切换的身份层**：导入或自建一张 `.dshcd` 卡，agent 就以那张卡的语气、人设、性格和代码风格工作；卡是纯数据、可导出、可继承、有明确 token 预算。

---

## 2. 为什么做（证据）

### 2.1 dsh 源码自己承认缺口

`packages/preset/persona/src/index.ts`：

> An agent preset cannot mount the prompt registry itself, so without a row of its own a preset
> could change an agent's tools but never its identity.

**现状**：agent preset 能换工具/模型，**换不了身份**。

### 2.2 市场 0 命中

`dsh-web` 插件目录（132 个）关键词全量搜索：

| 关键词组 | 命中 |
|---|---|
| emotion / affect / mood / companion / relationship / persona / bond | **0** |
| character card / role card / lorebook / world info | **0** |
| code style / style guide / naming convention | **0** |

皮肤（61）和宠物（10）是装饰；`Output Styles` 管全局输出格式；`Prompt Manager` 管全局系统提示词。
**没有"可切换的身份卡"。**

### 2.3 与受众匹配

dsh 是编码工具，用户是开发者。**代码风格 + 语气**比世界观扮演有用得多。

---

## 3. 已定的设计决策

### D1 格式：`.dshcd` v1（自定义，JSON）

```json
{
  "dshcd": 1,
  "id": "terse-reviewer",
  "name": "简短审阅者",
  "version": "1.0.0",
  "author": "",
  "description": "",
  "language": "zh-CN",

  "identity": {
    "role": "senior reviewer",
    "expertise": ["backend", "distributed systems"],
    "background": "长期做生产系统，见过太多过度设计"
  },

  "voice": {
    "tone": "direct",
    "verbosity": "terse",
    "formality": "casual",
    "humor": "dry",
    "traits": ["skeptical", "patient"],
    "avoid": ["emoji", "praise", "filler"]
  },

  "code": {
    "naming": "descriptive, no abbreviations",
    "comments": "none-unless-why",
    "error_handling": "boundaries only",
    "abstraction": "minimal",
    "dependencies": "conservative",
    "tests": "before-change",
    "commit_style": "why, not what"
  },

  "workflow": {
    "plan": "before-multi-step",
    "ask_when_unclear": true,
    "verify_before_claim": true
  },

  "constraints": [
    "never commit without asking",
    "no new dependencies without approval"
  ],

  "extends": null
}
```

> **2026-10-19 修订**：`budget.maxTokens` 已从格式中移除，见 D11。

**格式原则**：

- ~~`budget.maxTokens` 是**格式的一部分**，不是插件隐藏设置——作者与用户都能看到成本~~
  **已废除，见 D11。**
- `extends` 支持卡继承（基础卡 + 派生卡），避免复制粘贴
- `constraints` 是**祈使句硬规则**，与 `identity` 的散文分开
- 未知字段**原样保留**，向前兼容
- `voice` 与 `workflow` / `code` 在 UI 上**显式分开标注影响面**

### D2 影响面分级（重要）

| 字段组 | 影响 | UI 提示 |
|---|---|---|
| `voice`（tone / verbosity / humor / avoid） | **只影响表达**，不影响正确性 | 安全 |
| `identity` | 影响视角与用词 | 低风险 |
| `code` | **影响产出质量与风格** | 会改变代码 |
| `workflow` / `constraints` | **影响行为决策** | 高风险，需用户明确开启 |

**理由**："说话简短"不影响做题；"大胆下结论、不爱确认"会。不能混成一锅。

### D3 挂载点：dsh 原生 prompt registry

**（2026-10-18 实测修正——原方案是错的，见下）**

原方案写的是把卡片注册进 `PERSONA_SECTION`。**这条路走不通**：四个随包预设
（标准 / 极简 / PTC / 创造模式）全都挂了 `@deepseek-ai/dsh-persona`，而 preset 是在
agent 发布**之前**挂载的，所以 `agent/created` 触发时那个 scope 里已经有了
`deployment:persona`，再注册同名 section 同 layer 重名 → 抛异常。

**改为自有 section 名**，依据是随包发布的 `packages/experimental/tool-agent-team/src/index.ts:160`
——它面临同样约束，用的也是自有名 `'team:policy'`。

实测确认可用的写法（**四要素，缺一不可**）：

```js
agent.ctx.inject(['systemPrompt'], (scope) => {
  scope.systemPrompt.section({
    name: 'dshcd:identity',                    // ① 自有名，不用 PERSONA_SECTION
    order: resolveOrder(scope.systemPrompt),   // ② 探测，不写死单一枚举名
    text: rendered,
  })
})
```

1. **自有 section 名** `dshcd:identity`。语义上也更对：GOAL §1 说的是"身份**层**"，可叠加，不是替换 persona。
2. **order 必须探测**——`DEPLOYMENT_PERSONA` → `DEPLOYMENT_PERSONA_PREFIX` → `PERSONA` → `PLAN_POLICY`
   依次试，取第一个有限值。原因见 §4.1。
3. **必须走 `agent.ctx.inject([...], cb)`，不能直接取 `agent.ctx.systemPrompt`**——
   agent scope 的服务在 agent 刚创建时并非全部可解析。依据 `packages/context/file-reference-local/src/index.ts:62`。
4. **注册的 fiber 要留存并在 `agent/disposed` 时 dispose**（`file-reference-local` 这么做，之前漏了会泄漏）。

**预设兼容性**（实测）：

| 预设 | 兼容 | 原因 |
|---|---|---|
| 标准 / PTC / 创造模式 | ✅ 可叠加 | persona 是普通 section，我们排在它之后 |
| **极简模式** | ❌ **完全不生效** | persona 配了 `complete: true`，装配末尾会**独占** system prompt，把我们的 section 整个丢掉。**不报错、静默失败** |

`complete: true`（卡独占 system prompt）——**v1 不开启**。它还要求同 scope 内没有第二个
complete section，且会连带丢掉所有 `tool:*` section 的描述，严重削弱工具使用。

**卡片文本的组装**：`identity` + `voice` + `code` + `workflow` + `constraints` 各自渲染成
**带标题的祈使式清单**（`【表达要求｜必须遵守】` + 项目符号），
按固定顺序拼接，**总长受 `budget.maxTokens` 约束**（超了就截断并警告，不静默）。

实测渲染尺寸：简短审阅者 454 字符 ≈ 152 token；耐心的教学者 551 字符 ≈ 184 token。
`budget.maxTokens: 400` 有充足余量。

---

### D9 激活模型：全局默认 + 单 session 覆盖

**（2026-10-18 定案）**

- 一个全局默认卡；每个 session 可选一张卡覆盖默认
- 解析顺序：**session 覆盖 → 全局默认 → 不绑（原生行为）**
- 理由：persona section 天然是 agent-scope 的，这个粒度和架构完全吻合；切卡只影响当前 session

存储布局：

```
~/.dsh/character-cards/
  <id>.dshcd       卡片库
  default          全局默认指针，内容是卡 id
  sessions.json    per-session 覆盖 { "<sessionId>": "<cardId>" }
```

**per-session 覆盖用自有 JSON 文件，不用 dsh 的会话持久化。**
理由就是 §4.1 的漂移教训——自有文件零 API 依赖。P3 有真实 UI 时再考虑迁移。

---

### D10 换卡不需要重启

**（2026-10-18 实测）** 卡是在 `agent/created` 时读取的，所以**换卡 = 换文件 + 开新 session**，
不需要重启 dsh，也不需要重装插件。

这也意味着：**已存在的 session 保持它创建时绑定的卡**。这是 D4 缓存原则的自然结果——
按轮变化的内容不能进 system prompt，卡片在 session 内必须稳定。

---

### D11 预算不再是硬上限（2026-10-19 修订 D1）

`budget.maxTokens` **从格式中移除**。

- 渲染**永远输出完整卡片，绝不截断**
- token 数是**纯信息**，编辑器与设置页照常显示，没有"超出"这回事
- 旧卡里的 `budget` 按 D6 作为未知字段原样保留，编辑器不会抹掉它

**原因**：估算方式是「字符数 ÷ 3」，不是 tokenizer，拿它当硬上限是假精确；而且实测发现截断
是从**尾部**砍的，而渲染顺序把 `constraints` 与优先级声明放在末尾——**超预算时最先消失的恰恰
是卡片最能生效的部分**。

**代价**：没有机制阻止一张巨卡撑爆提示词，只剩可见的 token 数作为信号。接受。

### D4 缓存原则（硬规则）

**按轮变化的内容绝不进 `messages[0]`。**

- 卡片内容**稳定** → 适合 system section
- 若将来加入任何"按轮变化"的内容（例如根据当前文件类型微调风格）→ **只能走尾部 superseding 消息**

来源：FSAR 实测，易变块放系统提示词导致缓存命中率 1.6%、计费差 125×。

### D5 代码规则要"少而硬"

LLM 在任务压力下会忘掉散文式规则。**要求**：

- 每条规则是**祈使句**、单行、可判定
- 建议总条数 **≤ 12**
- 编辑器里对过长/过多的规则给出警告
- v1 只做提示词；**v2 考虑接格式化 / lint 做真执行**

### D6 导入/导出

- 导入：`.dshcd`（JSON）
- 导出：`.dshcd`（JSON）
- **不做** SillyTavern / PNG 卡
- 导入时校验 `dshcd` 版本；未知字段保留

### D7 客户端插件必须"不可能弄坏 UI"

**被事故教育出来的硬要求**（一个手写客户端插件曾让整个 dsh 客户端组合失败、所有插件入口消失）：

- 客户端模块内 `inject: []`；`package.json` 的 `dsh.client.inject` 才写包名
- `apply()` 全程 `try/catch`
- 任何依赖用前判空；失败静默
- 定时器有上限并自行清理

### D8 桌面版同源问题从第一天避开

Electron 桌面版走 `dsh-app://app/`，请求**既无 `Origin` 也无 `Sec-Fetch-Site`** → 自建 `sameOrigin` 式校验必然 403。

- 卡片管理接口**不要依赖 Origin / Referer**
- 鉴权用宿主已有 session/token
- 参考事故：codekin `/api/tracewild/action` 在桌面版全部 403

---

## 4. 技术前提验证结论（2026-10-18 实测完成）

三项全部做完，结论如下。**全部是对「装着的运行时」测出来的，不是读检出源得出的**——
这个区别是实测中被教育出来的，见 4.4。

### 4.1 API 漂移：**存在，且第一次挂载就命中**

检出源 `0.1.3-alpha.1` 与装着的运行时不一致，实测差异：

- **`getSectionOrder('DEPLOYMENT_PERSONA')` 返回 `undefined`**。
  0.2.x 把 persona 拆成了 `deployment:persona-prefix` / `deployment:persona-suffix`，
  真正认识的 order 名是 **`DEPLOYMENT_PERSONA_PREFIX`（锚点 0）**。
- **`getSectionOrder` 对未知名字静默返回 `undefined`**——不抛错、不警告。
  `undefined + 1 = NaN`，直到 `section()` 才抛出 `order must be a finite number`。
  链路上唯一的症状是个 `NaN`。
- 实测装配出的 prompt 有 24 个 section，我们的排在第 2 位。

**结论**：order 不能写死单一枚举名，必须探测候选列表。

### 4.2 运行时作用域：**主方案成立，退路不需要**

- 服务代理的 `.ctx` 返回**访问者上下文**（`vendor/cordis/src/utils.ts:176`），
  所以 `someCtx.systemPrompt.section(...)` 注册落在 `someCtx` 的 scope layer。
- `ctx.agents`（`AgentRegistry`）暴露 `get(id)` / `list()` + `agent/created` / `agent/disposed`；
  `agent.ctx` 是公开的 scope context。**untagged 的根监听器能收到所有 agent 的事件**。
- **切换可行**：`NamedEntries.insert()` 返回的 undo 会 `data.delete(name)`
  （`packages/core/scope/src/store.ts:38`），所以 dispose 后可以同名重注册。
- **退路（生成 preset 配置）作废**：preset 只能在 session **零产出**时切换，
  做不到 §5 验收 2 要的"同一 session 内切卡"。

### 4.3 拦截/注入点

notes 在 `.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md`。
v1 不依赖，未细读。

### 4.4 一条元结论（比上面三条都重要）

**凡是照检出源写的 API，都必须拿装着的运行时验一遍。**

4.1 的漂移不是理论风险——它让前两轮验证**全部无效**，
而且失败方式是静默的（只有 `NaN`）。真正定位它靠的是一台记录**装配结果**的仪器
（监听 `system-prompt/assemble`），不是读代码、也不是看对话记录。

**推论**：后面每接一个新 API，先加观测再写逻辑。


---

## 5. v1 验收标准（可演示）

**同一个任务，两张卡，输出明显不同：**

1. 导入两张 `.dshcd`（例："简短审阅者" vs "耐心的教学者"）
2. 切换卡片 → 在同一段代码上问同一个问题
3. **语气、长度、用词明显不同**
4. **代码建议风格明显不同**（命名/注释/抽象程度）
5. 编辑器显示每张卡的 **token 占用**
6. 导出卡片 → 再导入 → **字段零丢失**
7. 装/卸插件时，**dsh 其余 UI 完全不受影响**

---

## 6. 明确不做（v1）

- SillyTavern 卡 / 世界观 / lorebook / 剧情
- 角色立绘 / TTS / 语音
- 群聊 / 多卡同场
- 完整 preset 管理
- 重做工具系统 / 模型路由
- PNG 格式
- 代码风格的真实执行（lint/format 钩子）→ v2

---

## 7. 参考位置（dsh 源码）

```
packages/preset/persona/src/index.ts                身份 section 的官方范例
packages/core/system-prompt/src/index.ts            section / variable / context / waterfall API
.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md
                                                    工具管线与循环决策的拦截点
```

**插件契约（实测）**：

```
package.json:
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["<包名>", ...], "immediately": false }
  }

cordis.patch.yml:
  - insert:
      - id: <插件 id>
        name: <包名>

lib/index.js   （host）: export { apply, inject, name }   inject = 服务名（如 'systemPrompt', 'sessions', 'webServer'）
lib/client.js  （web） : window.__ModuleLoader__.load({ id: '<包名>', factory: e => { ...; return module.exports } })
                          module.exports 挂 { apply, inject }；此处 inject = **服务名**（如 'slots', 'locale'）
```

**安装命令**（dsh 不在 PATH 上）：

```bash
cd /c/WinTool/deepseek-harness
TSX_TSCONFIG_PATH='C:\WinTool\deepseek-harness\tsconfig.json' \
node --import file:///C:/WinTool/deepseek-harness/node_modules/tsx/dist/esm/index.mjs \
  C:/WinTool/deepseek-harness/apps/cli/src/bin.ts plugin --profile desktop <add|remove> <包名>
```

---

## 8. 风险

| 风险 | 应对 |
|---|---|
| 性格/工作流设置伤任务正确性 | D2 分级 + UI 显式标注 + 高风险项默认关闭 |
| 代码规则被 LLM 忽略 | D5 少而硬；v2 接 lint/format 真执行 |
| 卡片增加每轮 token | ~~`budget.maxTokens` 硬上限~~ → **仅显示占用，不设上限**（D11） |
| API 在 0.2.0-rc.2 上漂移 | 第一步先验证，再动设计 |
| 客户端插件弄坏 UI | D7 |
| 桌面版 403 | D8 |

---

## 9. 进度与下一步（2026-10-18）

第 4 节的三个验证**已全部完成**，结论已补回本文档；D3 已按实测修正；D9/D10 为新增决策。

### 阶段划分

| 阶段 | 产出 | 能演示什么 | 状态 |
|---|---|---|---|
| **P0** | 空插件装进 profile（宿主 + 客户端两半） | 插件管理页出现一行标记，其余 UI 无损 | ✅ 完成 |
| **P1 上半** | `.dshcd` 读取 → 渲染 → 注入 agent scope | 「你好」的回复从客套变暴躁，标记全中 | ✅ 完成 |
| **P1 下半** | 软卡对比 | 同一段代码，两张卡输出语气/代码风格明显不同 | ✅ 完成 |
| **P1 收尾** | 卡片库、解析顺序、默认指针、per-session 覆盖、D6 保留字段、budget 截断告警 | 目录里放多张卡，改 `default` 文件换全局卡 | ⏳ 待做 |
| **P2** | 运行时重绑 + 宿主路由 + **已验证 slot 上的最小切换入口** | 一个 session 内点一下切卡，下一轮就变 | 待做 |
| **P3** | slot 发现 + 完整管理 UI | 列表、token 占用、新建/删除 | 待做 |
| **P4** | 编辑器 + 导入导出 | `.dshcd` 零丢失往返 | 待做 |

**P2 的 UI 用 P0 已验证的 slot**（`plugins.row.config`），零新增风险。
真正的选卡 UI 位置留到 P3——技能里写死了「不许猜 slot，必须用 `Slots.listSubTree` 问活体」，
而那是 Claude Code 结构上做不到、只能靠 dsh 创造模式做的事。

### P1 收尾的注意点

- `active.dshcd` 这个单文件拐杖要退休，换成卡片库 + `default` 指针
- D6 要求**未知字段原样保留**——现在直接忽略，往返会丢字段
- `budget.maxTokens` 超限要**截断并告警**，不能静默

### 开发环境

- 插件软链在 `~/.dsh/profiles/desktop/node_modules/dsh-character-cards`
  → `/c/WinTool/my-dsh-plugin`，**改源码重启 dsh 即生效，不用重装**
- 宿主半改动需重启；**换卡不需要**（D10）
- 诊断路由 `GET /dsh-character-cards/status`（宿主端口，实测 19387）——
  报告读到的卡、绑卡各阶段计数、`orderResolved`、以及**实际装配出的 section 名单**
- 离线验证：`node scripts/dryrun.mjs`（假 ctx 跑真实 `apply()`，可模拟 0.2.x 漂移）

