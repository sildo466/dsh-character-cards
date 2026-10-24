# dsh-character-cards

[English](README.md) | 简体中文

[![npm](https://img.shields.io/npm/v/dsh-character-cards.svg)](https://www.npmjs.com/package/dsh-character-cards)
[![downloads](https://img.shields.io/npm/dm/dsh-character-cards.svg)](https://www.npmjs.com/package/dsh-character-cards)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.2.0--rc.2-4c6ef5)](#环境要求)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/sildo466/dsh-character-cards/blob/master/LICENSE)

**给每个会话一副自己的面孔——不用改系统提示词。**

这个会话想要耐心的老师，下个会话想要不留情面的代码审查员，再下一个只想找个人聊天。角色卡让每个 DSH 会话拥有自己的身份：它是谁、怎么说话、怎么写代码、绝对不能做什么。

在设置里编辑，在输入框旁切换，对话中途换角色也不丢上下文。

![使用「耐心的教学者」进行的一段对话，输入框左侧显示当前卡片](https://raw.githubusercontent.com/sildo466/dsh-character-cards/master/docs/images/chat-example.png)

## 为什么不用预设？

Agent 预设是一整个 agent：工具、插件、组合方式。它在创建会话时选定，之后固定不变。

角色卡只是叠在上面的一层：一个很小的 JSON 文件，装着人设和风格。它能配合任何预设使用，而且随时可以换。

| | Agent 预设 | 角色卡 |
|---|---|---|
| 作用范围 | 整个 agent | 人设与风格 |
| 生效时机 | 创建会话时 | 立即，随时 |
| 对话中途切换 | 不能 | 能 |
| 创作方式 | YAML / 文件 | 可视化编辑器 |
| 分享方式 | 安装一个包 | 发一个 `.dshcd` 文件 |

## 环境要求

- DeepSeek Harness `>= 0.2.0-rc.2`
- Node `>= 22`

## 安装

```sh
dsh plugin --profile <profile> add dsh-character-cards
```

桌面客户端：打开“设置 -> 插件”，安装 `dsh-character-cards`，然后重启应用。

从 GitHub 安装：

```sh
dsh plugin --profile <profile> add github:sildo466/dsh-character-cards
```

只有安装这一步需要重启。新建、编辑、切换卡片都会立即生效。

## 快速开始

1. 打开“设置 -> 角色卡”。
2. 点“新建卡片”。
3. 写下这个角色：它是谁、怎么说话、怎么做事。
4. 在输入框旁选择它用于当前会话，或者把它设为新会话的默认卡。

![设置里的卡片库，显示默认卡和每张卡的使用会话数](https://raw.githubusercontent.com/sildo466/dsh-character-cards/master/docs/images/card-list.png)

## 切换

输入框旁的选择器有三种选项：

- **指定一张卡**——把这个会话钉在那个角色上。
- **跟随默认**——使用当前的全局默认卡。
- **不使用角色卡**——这个会话保持宿主原本的人设。

想换几次换几次。对话上下文不变，变的只是身份。

## 可以塑造什么

编辑器的分组方式，就像给新同事交代事情：

- **身份**——它是谁、懂什么、在意什么。
- **表达**——语气、节奏、口头禅、避免使用的词。
- **代码**——命名、注释、测试习惯。
- **工作方式**——什么时候追问、什么时候先验证、怎么规划。
- **硬性约束**——绝对不能越过的线。

![卡片编辑器，分组字段和每个字段下方的一行说明](https://raw.githubusercontent.com/sildo466/dsh-character-cards/master/docs/images/card-editor.png)

## 保存与生效

保存只会把卡片写入磁盘，**不会**悄悄改变已经在运行的对话。

有会话正在使用某张卡时，列表行会显示数量。点“重新应用”，才会把新版本推给这些 live 会话。

## 导入、导出、复制、删除

- **导入 / 导出**——一张卡就是一个 `.dshcd` 文件。导出后可以发给朋友，导入就能用。当前版本不认识的字段会原样保留。
- **示例**——从 [example_cards/](https://github.com/sildo466/dsh-character-cards/tree/master/example_cards) 导入任意一张，再改副本。
- **复制**——复制一张卡再改副本，原卡不受影响。
- **删除**——删除卡片，把钉在它上面的会话改成“不使用”，如果默认指针指向它也一并清空。

## 已知限制

- **角色扮演预设自带完整人设。** 如果预设已经在扮演一个角色，二选一即可；在它上面再叠一张角色卡，可能出现两个互相竞争的人设。
- **运行中的会话会继续使用启动时的那一版**，直到你点“重新应用”。
- **界面目前是中文。** 卡片内容本身可以用任何语言写。
- **desktop profile 由客户端托管。** 请在桌面客户端内安装和更新，不要用 CLI 直接改。

## 文档

- [卡片格式、HTTP 路由与开发说明](https://github.com/sildo466/dsh-character-cards/blob/master/docs/engineering.zh.md)
- [更新日志](https://github.com/sildo466/dsh-character-cards/blob/master/CHANGELOG.md)
- [贡献指南](https://github.com/sildo466/dsh-character-cards/blob/master/CONTRIBUTING.md)（英文）
- [行为准则](https://github.com/sildo466/dsh-character-cards/blob/master/CODE_OF_CONDUCT.md)（英文）
- [安全策略](https://github.com/sildo466/dsh-character-cards/blob/master/SECURITY.md)

## 许可证

MIT
