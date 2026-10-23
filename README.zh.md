# dsh-character-cards

[English](README.md) | 简体中文

为 [DeepSeek Harness](https://github.com/deepseek-ai) 会话绑定可切换的角色卡：身份、语气、代码风格与硬性约束作为单个会话级提示词 section 注入。

## 功能

- 五组结构化字段：身份、表达、代码风格、工作方式、硬性约束。
- 全局默认卡 + 单会话覆盖；一个会话也可以显式选择“不使用角色卡”。
- 输入框旁的选卡器，以及设置页里的完整编辑器。
- 实时预览：token 估算与规则告警。
- 对已经在运行的会话提供显式“重新应用”；保存本身不会静默改绑任何人。
- 单卡 `.dshcd` 文件的导入、导出、复制、删除；未知字段在往返中完整保留。

## 环境要求

- DeepSeek Harness `>= 0.2.0-rc.2`
- Node `>= 22`

## 安装

从 npm 安装：

```sh
dsh plugin --profile <profile> add dsh-character-cards
```

从 GitHub 安装：

```sh
dsh plugin --profile <profile> add github:sildo466/dsh-character-cards
```

桌面客户端请在“设置 -> 插件”里安装 `dsh-character-cards`（或 `sildo466/dsh-character-cards`）。desktop profile 由客户端托管，请优先在应用内安装。

本地开发：

```sh
dsh plugin --profile <profile> add link:/path/to/dsh-character-cards
```

## 使用

1. 打开“设置 -> 角色卡”。
2. 新建一张卡，填写身份与表达字段，保存。
3. 在页面顶部选择默认卡。
4. 在对话里使用输入框旁的选卡器：把当前会话钉到某张卡、跟随默认，或不使用角色卡。

保存只写入磁盘。正在运行的会话会继续使用它启动时的那一版；要让改动进入 live 会话，请点卡片行上的“重新应用”（编辑器里的同名操作也可以）。

## 卡片格式

一张卡就是一个 `.dshcd` JSON 文件：

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

当前版本不认识的字段会在保存时原样保留，因此卡片可以携带面向未来版本的数据。

## 生命周期

- 导出：把磁盘上的原始 JSON 下载为 `<id>.dshcd`。
- 导入：接受单个不超过 1 MB 的 `.dshcd`/JSON 对象，清洗 id，冲突时自动改名。
- 复制：完整克隆卡片，名称追加“副本”。
- 删除：删除文件，把指向它的会话覆盖改为显式“不使用”，若默认指针指向它则清空，并解绑 live 会话。

## 开发

```sh
node --test
```

没有构建步骤：Node 宿主半区是 `src/index.js`，浏览器 bundle 是 `src/client.js`，直接发布源码。

## 许可证

MIT
