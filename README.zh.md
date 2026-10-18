# dsh-voice-call

[English](README.md) | 中文

把当前会话变成一个免手语音通话的 DeepSeek Harness 组合包：说话代替打字，助手的回答自动朗读，转写和回复仍然留在正常对话记录里。

它是一层**输入输出适配**，不是第二个 Agent。转写就是普通的用户消息，回答就是普通的助手消息，不会另开会话、另起写入方，也不经过 ACP。关掉通话，DSH 还是原来那个 DSH。

## 它做什么

| 方向 | 路径 |
| --- | --- |
| 语音输入 | 麦克风 → 16 kHz 单声道 WAV → Host `/voice-call/transcribe` → profile 的 `speechController`（`sensevoice-local`） |
| 语音输出 | 助手本轮文本 → 清洗 + 切句 → Host `/voice-call/tts` → 阿里云 DashScope `qwen3-tts-flash` → 单个 audio 元素 |

浮窗渲染在官方 `shell.overlay` 槽位里，所以它浮在所有面板之上，切换会话也不会消失。通话绑定在开始时的那个会话上，切会话不会改变绑定。

## 使用流程

1. 点右下角的 **🎙 通话**，先打开**准备面板**，不会立刻开始。
2. 在面板里选音色、语速、是否朗读清洗、按钮颜色；没配置 Key 的话在同一块面板里粘贴。
3. 点 **开始通话**。面板收成通话卡片，麦克风打开，你说的话作为普通用户消息进入对话。
4. **暂停**停止收音和播放；**打断**只停止当前朗读，不影响 Agent 继续生成；**✕** 结束通话。

## 前置条件

- **DeepSeek Harness 0.2.x**（在 `0.2.1-rc.2` 上验证）。本包不声明 DSH 的 peer 版本范围，所以新版本 Harness 仍然会加载它；如果内部 API 变了，表现是浮窗里显示一条错误，而不是整个 profile 起不来。
- **语音识别提供方。** 语音输入走 profile 的 `speechController` 和本地 `sensevoice-local` 提供方，它随可选的**实验性语音输入**组合包提供。请在**插件**页启用该组合包；没启用也能安装，但浮窗会明确提示识别不可用。
- **阿里云 DashScope API Key**，用于语音合成（`qwen3-tts-flash`）。按字符计费，费用属于使用者自己的账号。

## 安装

下面三种方式装的是同一个组合包；插件管理页那条不需要命令行。

1. **插件管理页（推荐）。** 侧栏 → **插件** → **添加插件** → **安装第三方插件**，粘贴 Git 地址（`https://github.com/Qi-95827/dsh-voice-call`）或本地绝对路径。
2. **命令行，从 Git 安装：**
   ```sh
   dsh plugin --profile <profile> add github:Qi-95827/dsh-voice-call
   ```
3. **命令行，从本地目录安装：** 填包含本 `README.md` 的绝对路径。这种是 link 安装，目录要保留。
   ```sh
   dsh plugin --profile <profile> add <absolute directory>
   ```

装完重启一次 DSH，让 Host 侧和浏览器侧来自同一代代码，然后在**插件**页确认 **语音通话 / Voice Call** 已列出并启用。

### 或者，直接让 DSH 自己装

不想敲命令的话，把下面这段整块复制，发给 DeepSeek Harness 的对话框，让它替你装：

```text
帮我安装一个 DeepSeek Harness 插件（bundle），装进当前这个 profile，装完确认能用。

插件：dsh-voice-call
来源：https://github.com/Qi-95827/dsh-voice-call

请按这个顺序做：
1. 优先用你的插件管理能力安装：plugin_manager 的 install_bundle，目标就是上面这个地址。
   如果这个工具在当前 profile 不可用，就在 shell 里执行：
   dsh plugin --profile <当前 profile> add https://github.com/Qi-95827/dsh-voice-call
   profile 名可以从环境变量 DSH_PROFILE（PowerShell 里是 $env:DSH_PROFILE）读到。
2. 不要手改 profile 的 package.json 或 cordis.patch.yml，让安装流程自己写。
3. 安装过程中如果需要批准构建脚本或需要重启，直接告诉我。
4. 装完告诉我：装到了哪个 profile、需不需要重启、pnpm 实际装了什么版本。
5. 提醒我重启 DSH，然后让我在「插件」页确认出现「语音通话 / Voice Call」。
6. 顺便检查这个 profile 有没有启用「实验性语音输入」组合包（提供 speechController 和
   sensevoice-local）。没有的话告诉我怎么启用，否则语音识别用不了。
7. 如果安装失败，把 pnpm 的原始报错贴给我，不要自己推测原因。

装好之后，如果需要，再带我走一遍准备：填阿里云 DashScope API Key、选音色。
```

上面这段已经指向本仓库（`Qi-95827/dsh-voice-call`）。如果你 fork 了，把块里两处 URL 一起改掉。

## 配置

在准备面板或通话卡片里粘贴阿里云 DashScope API Key（`sk-…`）。

- profile 里有凭据库时，Key 存在凭据库的 `DASHSCOPE_API_KEY` 下，不会写进设置文件。
- 没有凭据库时退回 `~/.dsh/voice-call.json`，其中已存在的 Key 会在首次使用时迁移进凭据库。
- 环境变量 `DASHSCOPE_API_KEY` 作为最后兜底。

非敏感偏好（音色、语速、本月字符数）存在 `~/.dsh/voice-call.json`。**朗读清洗**和**按钮颜色**都按浏览器保存在 `localStorage` 里；颜色只在准备面板里改，通话中不再显示这一行。

## 行为说明

- **「打断」只停止朗读。** 它中断当前的合成请求、清空队列，但 Agent 继续生成。如果这一轮还在跑，你接着说会用 `steer` 把话插进当前轮。
- **边生成边朗读。** 每完成一句（或攒到 90 字）就立刻送去合成，不再等 `turn/end`，所以第一声不用等整段回复写完。剩下的延迟是 DashScope 的往返和合成时间。
- **从不朗读思考过程。** `reasoning-delta` 增量以及 `reasoning` / `thinking` 块在朗读前就被过滤掉。
- **一个页面只有一个引擎。** 存活实例通过 `window.__dshVoiceCallOwner` 独占麦克风和浮窗；第二个实例（热更新残留、早先手动安装留下的副本）会先销毁上一个再挂载，所以同一句话不会被录两次、发两次。
- **表格和代码可选。** 打开朗读清洗后，代码块、表格、Markdown 标记、链接和裸 URL 只在朗读时被去掉，对话里仍然显示原文。
- **暂停**停止收音和播放，但不结束通话。
- `GET /voice-call/diagnostics` 返回插件 apply 次数和最近 40 次语音请求（到达时间、音频字节数、客户端实例标记、字符数）。怀疑「多实例抢麦」时，看这个最快。

## 隐私与安全

- 麦克风音频在页面内录成 WAV 后只发给本机 Host；识别走 profile 自己的提供方，不额外上传到别的语音服务。
- 转写会变成普通用户消息，和打字一样写进会话记录。
- 朗读文本会发给阿里云 DashScope 合成，请求里带回复文本和 API Key。
- Key 存在凭据库（`DASHSCOPE_API_KEY`），不写设置文件，也从不回传给页面——页面只拿到掩码提示。
- `/voice-call/*` 由本机 Host 提供：只接受同源请求，服务默认绑回环地址。如果 profile 里改成非回环绑定，就等于把它暴露给那个网络，建议保持默认。

## 升级预期

- 本包不对 DSH 包声明 `peerDependencies`，所以 Harness 升级不会因为版本范围拒绝加载。`dsh.compatibility.dshReleases` 记录验证过的版本，供插件管理页展示。
- 用到的 Host API：`webServer.register`、`speechController.transcribe/prepare`、可选的 `credentials.resolve/set/unset`。
- 用到的 Client API：`slots.inject/register`、`sessions.retain`、`uiSession.current`、`binding.session.prompt/cancel`、`binding.eventSource`。
- 所有注册都在 `apply` 里通过 `ctx.effect` 完成；浮窗组件不向自己的槽位以外写 DOM。

将来某个版本如果改名了其中某个 API，故障会局限在本插件内（浮窗显示错误），不影响 Harness 其他部分。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 插件：HTTP 路由、阿里云合成、Key 解析 |
| `client.js` | Client 插件：槽位注册、录音、播放、浮窗 |
| `cordis.patch.yml` | bundle 层，插入 Host 行 |
| `locale/*.json` | 插件管理页的标题与描述 |
| `icon.svg` | 插件图标 |

## 许可

MIT —— 见 [LICENSE](LICENSE)。
