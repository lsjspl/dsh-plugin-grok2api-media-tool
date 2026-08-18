# [dsh-plugin-grok2api-media-tool](https://github.com/lsjspl/dsh-plugin-grok2api-media-tool)

一个 [dsh（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 插件，让智能体通过 [grok2api](https://github.com/chenyme/grok2api) 生成图片/视频，并用 Grok 最新语言模型识别图片。当用户提出「画一张图」「做一个视频」「分析这张图片」等需求时，模型会调用插件提供的工具并返回可查看的结果。

## 功能

| 工具 | 说明 |
|---|---|
| `generate_image` | 文生图：返回图片 URL，并可将图片保存到当前会话工作区 |
| `generate_video` | 文生视频：创建异步任务并等待完成，返回视频 URL，并可保存到工作区 |
| `recognize_image` | 识图：把本地图片、data URL 或图片 URL 发给 Grok 最新语言模型（默认自动选最新，可配置如 `grok-4.6`），返回模型对图片的描述/回答 |
| 图片路径上传入口 | 聊天输入框左侧的 🖼️ 按钮：选择图片后上传到 dsh 本地，并把返回的本地路径插入输入框，供模型调用 `recognize_image`。**纯文本主模型（如 DeepSeek）也能用**——它收到的是文本路径，再由插件调 Grok 识图，不依赖主模型支持图片附件 |
| 路径识图 | 模型拿到图片路径后调用 `recognize_image`，由 Grok 最新语言模型进行多模态识别 |

支持两种 grok2api 后端（通过 `apiFlavor` 选择）：

- `chenyme`（默认）：Go 版 [chenyme/grok2api](https://github.com/chenyme/grok2api)
- `aurora`：旧 Python 版 [aurora-develop/grok2api](https://github.com/aurora-develop/grok2api)

## 安装

```sh
dsh plugin --profile web add dsh-plugin-grok2api-media-tool              # 从 npm（推荐）
dsh plugin --profile web add github:lsjspl/dsh-plugin-grok2api-media-tool   # 或从 GitHub
```

安装后重启 `dsh web` 生效。本地 tarball 等其他安装方式见 [DISTRIBUTE.md](./DISTRIBUTE.md)。

## 配置

插件配置保存在 `~/.dsh/settings.yaml` 的 `grok2api-media-tool:` 节，以下三种方式任选其一，效果相同，保存后即时生效（无需重启）。

### 方式 1：直接对话配置

在对话里直接提出即可，模型会调用 `configure_grok2api` 工具写入并生效：

- 「grok2api 复用 llm-pi-ai 里配好的 grok 提供商」
- 「把 grok2api 地址配成 http://192.168.1.100:8000，密钥 sk-xxx」
- 「生成的图片不要保存到工作区」

### 方式 2：复用已配置的 LLM 提供商

如果已在 dsh 的「模型」设置里配好 grok 提供商，插件可以直接复用它（地址、密钥、模型均取自该提供商），无需重复填写：

```yaml
grok2api-media-tool:
  apiSource: llm-provider
  llmProvider: grok   # llm-pi-ai.providers 下的键名（全局默认 provider）
```

三个用途（image / video / vision）还可以各自指定不同的 provider，例如识图用另一个 provider 的模型：

```yaml
grok2api-media-tool:
  apiSource: llm-provider
  llmProvider: grok          # 全局默认
  vision:
    provider: grok-chat      # 识图改用 grok-chat 的模型，留空则回退到 grok
```

### 方式 3：手工编辑配置文件

编辑 `~/.dsh/settings.yaml`（Windows 为 `%USERPROFILE%\.dsh\settings.yaml`）：

```yaml
grok2api-media-tool:
  baseUrl: http://192.168.1.100:8000
  apiKey: sk-xxx
  apiFlavor: chenyme
```

> 说明：dsh rc.7+ 在设置页开放了插件命名空间，本插件提供**图形化配置表单**（设置 → Plugins → 配置 → Grok2API Media Tool）：可选 provider、各用途模型从 provider 的模型目录下拉选择（每用途可单独覆盖 provider），各超时也可调。表单改动保存后即时写入 `settings.yaml`。也可继续使用以上三种方式配置。

## 配置项

> 以下所有字段都可在 dsh 设置页的**图形化表单**里直接配置（设置 → Plugins → 配置 → Grok2API Media Tool，需 dsh rc.7+）：provider 下拉选择、各用途模型从 provider 模型目录下拉、超时数值、功能开关，保存即写入 `settings.yaml`。也可手工编辑下表字段。

未填写的字段使用默认值。

| 键 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8000` | grok2api 服务地址 |
| `apiKey` | `''` | 客户端密钥；非空时以 `Authorization: Bearer` 发送 |
| `apiKeyEnv` | `''` | 存放密钥的环境变量名（如 `GROK_API_KEY`）；`apiKey` 为空时使用 |
| `apiSource` | `manual` | `manual`（使用本节字段）或 `llm-provider`（复用 `llm-pi-ai` 中的提供商） |
| `llmProvider` | `''` | `apiSource: llm-provider` 时，`llm-pi-ai.providers` 下的键名（全局默认 provider） |
| `apiFlavor` | `chenyme` | `chenyme`（Go 版）或 `aurora`（Python 版） |
| `image.enabled` | `true` | 是否启用 `generate_image` |
| `image.model` | `grok-imagine-image-quality` | 图片模型；留空时按 `apiFlavor` 取默认，`apiSource: llm-provider` 时从 provider 模型目录派生 |
| `image.provider` | `''` | 图片用途的 provider 覆盖（`llm-pi-ai.providers` 下的键名）；空则用全局 `llmProvider` |
| `image.timeoutMs` | `180000` | 图片生成总超时（毫秒） |
| `video.enabled` | `true` | 是否启用 `generate_video` |
| `video.model` | `grok-imagine-video` | 视频模型；留空时按 `apiFlavor` 取默认，`apiSource: llm-provider` 时从 provider 模型目录派生 |
| `video.provider` | `''` | 视频用途的 provider 覆盖；空则用全局 `llmProvider` |
| `video.timeoutMs` | `1200000` | 视频生成总超时（毫秒） |
| `video.pollIntervalMs` | `5000` | 视频进度轮询间隔（毫秒） |
| `vision.enabled` | `true` | 是否启用 `recognize_image` |
| `vision.model` | `latest` | 识图默认模型；`latest` 会查询 grok2api 的 `/v1/models` 自动选最新 Grok 语言模型（同一会话只查一次，失败回退 `grok-4.6`），也可直接填具体模型 id |
| `vision.provider` | `''` | 识图用途的 provider 覆盖；空则用全局 `llmProvider` |
| `vision.timeoutMs` | `60000` | 识图单次请求超时（毫秒） |
| `vision.bridgeToText` | `true` | 是否把聊天上传的图片先用 Grok 转成文字，再交给纯文本主模型（如 DeepSeek） |
| `saveToWorkspace` | `true` | 是否将生成的媒体下载到会话工作区 |
| `saveDir` | `generated` | 媒体保存子目录（相对工作区根） |
| `requestTimeoutMs` | `60000` | 单次 HTTP 请求超时（毫秒） |
| `mediaDownloadTimeoutMs` | `300000` | 单个媒体文件下载超时（毫秒） |

## 使用

在 dsh（Web 或 headless）中直接提出需求即可：

- 「帮我生成一张赛博朋克城市夜景图，16:9」
- 「做一个 8 秒的视频：一只橘猫在雪地里奔跑」
- 「生成 2 张水彩灯塔图片，保存到项目里」
- 「分析这张图片里有什么」/「识别 `/path/to/image.png` 里是什么」
- 点击聊天输入框左侧的 🖼️ 按钮，选择一张图片，插件会把本地路径插入输入框；发送后模型会调用 `recognize_image` 用 Grok 识别

生成的图片会以内嵌卡片展示，视频可直接在对话中播放；本地保存的文件路径会以行内代码形式出现在回复里。识图结果会以普通文本返回。

## 限制

- 不支持流式图片与部分预览。
- 视频生成耗时较长，工具会等待完成。
- 生成的媒体通过 dsh 自身的 Web 服务提供给浏览器，支持局域网与 SSH 转发访问；历史会话中的媒体在重启后仍可查看。
- 保存到工作区的文件不会进入 dsh 的「产物（Produced）」列表，而是以本地路径形式出现在回复中。
- 纯文本主模型（如 DeepSeek）不支持原生图片附件（dsh 的限制）。要给这类主模型传图，请用聊天框左侧的 🖼️ 按钮（走 `recognize_image` 识图路径），不要直接拖拽/粘贴图片附件。

## 开发

```sh
node --check index.js && node test/smoke.mjs
```

发布与分发流程见 [DISTRIBUTE.md](./DISTRIBUTE.md)。
