# 工程说明

给想读代码、改插件或基于它继续开发的人。面向用户的文档在 [README.zh.md](../README.zh.md)。

## 工作原理

插件是一个标准的 DSH bundle，分两半：

- **宿主半区**（`src/index.js`）读取卡片库、解析某个会话该用哪张卡、注册 HTTP 路由，并把渲染后的卡绑定进 agent 的提示词。
- **浏览器半区**（`src/client.js`）注册两个 slot：
  - `settings.section`——卡片库与编辑器。
  - `conversation.input.left`——输入框旁的选卡器。

单个会话的解析顺序：

1. 会话自己的覆盖项，指向某张卡。
2. 会话覆盖项是显式 `null`——不使用角色卡。
3. 全局默认指针。
4. 什么都没配置——不使用角色卡。

渲染结果注册为提示词 section `dshcd:identity`，排在宿主 persona section 之后。保存只写入磁盘；正在运行的会话继续使用启动时的那一版，直到 `POST /cards/<id>/apply` 重新绑定。

## 卡片格式

每张卡是一个 `.dshcd` 文件：UTF-8 JSON，版本 `1`。id 就是文件名，必须匹配 `^[a-z0-9][a-z0-9-]*$`，最长 64 字符。

```json
{
  "dshcd": 1,
  "id": "patient-teacher",
  "name": "Patient Teacher",
  "description": "Explains code step by step.",
  "identity": {
    "role": "Patient teacher",
    "expertise": ["TypeScript", "testing"],
    "background": "Ten years of production systems."
  },
  "voice": {
    "tone": "Calm and direct",
    "verbosity": "Concise",
    "traits": ["encouraging"],
    "avoid": ["emoji"]
  },
  "code": {
    "naming": "Descriptive",
    "comments": "Only for non-obvious decisions",
    "tests": "Test behavior, not mocks"
  },
  "workflow": {
    "ask_when_unclear": true,
    "verify_before_claim": true
  },
  "constraints": ["Lead with the conclusion"]
}
```

五组字段对应编辑器的五个分组。支持字符串、布尔值和字符串数组；当前版本不认识的字段会在保存时原样保留，因此卡片可以携带面向未来版本的数据。

导入规则：

- 单个 JSON 对象，最大 1 MB。
- `dshcd` 不是 `1` 时给出警告并改写为 `1` 后导入。
- id 会转小写、把非法字符折叠为 `-`、去掉首尾 `-`、截断到 64 字符；冲突时依次使用 `-2`、`-3`。

## 存储布局

`$DSH_HOME/character-cards/`（未设置 `DSH_HOME` 时为 `~/.dsh/character-cards/`）：

```
<id>.dshcd        一张卡
default           默认卡 id，一行
sessions.json     会话 id -> 卡片 id，或 null 表示“不使用”
```

`sessions.json` 里没有条目表示“跟随默认”；显式 `null` 表示“不使用角色卡”。两者不能互换。

删除一张卡：

1. 先记下当前解析到它的 live 会话。
2. 删除文件（提交点）。
3. 把所有指向它的会话覆盖改为显式 `null`。
4. 如果默认指针指向它，清空默认指针。
5. 把受影响的 live agent 重新绑定到新结果（无卡）。

文件删除之后的清理失败会以 warning 形式返回，不回滚删除。

## HTTP 路由

所有路由都在 `/dsh-character-cards` 下，并受 loopback / Host 校验保护。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/ping` | 健康检查 |
| GET | `/cards` | 卡片库 + 默认指针 + 每张卡的使用会话数 |
| POST | `/cards` | 新建（id 已存在返回 409） |
| GET | `/cards/<id>` | 读取单张卡的原始对象 |
| PUT | `/cards/<id>` | 更新（id 必须与路径一致） |
| DELETE | `/cards/<id>` | 删除、清理覆盖、清理默认指针、解绑 live 会话 |
| POST | `/cards/preview` | 校验草稿、估算 token、返回告警 |
| POST | `/cards/<id>/apply` | 重新绑定正在使用该卡的 live 会话 |
| GET | `/session/<id>` | 某个会话当前生效的卡及来源 |
| POST | `/session/<id>/card` | 设置覆盖（`cardId`、`null`，或空 body 表示跟随默认） |
| POST | `/default` | 设置全局默认卡 |
| GET | `/status` | 诊断信息 |

## 开发

```sh
node --test
```

没有构建步骤，发布包直接包含两个半区的源码。

本地 profile：

```sh
dsh plugin --profile <profile> add link:/path/to/dsh-character-cards
```

桌面客户端托管自己的 profile，请用应用内的插件页安装。

## 兼容性与信任

- DSH `>= 0.2.0-rc.2`，Node `>= 22`。
- 卡片是纯数据。插件不会从卡片加载脚本、插件或 `!!js` 表达式。
- 路由拒绝非 loopback 请求和异常的 Host 头。
- 宿主不可达或缺少 UI 原语时，浏览器半区会降级，不会把客户端带崩。
