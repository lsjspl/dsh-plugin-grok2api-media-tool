# 分发与安装指南

本插件是标准的 **dsh bundle 插件**：包内自带 `cordis.patch.yml` 补丁层，并通过 `dsh` manifest 声明 `bundle`（宿主工具）与 `client`（对话里的媒体卡片）。接收方**只需一条 `dsh plugin --profile web add ...` 命令**：dsh 会自动完成安装、把包加入 `dsh.profile.bundles` 补丁层、并在重启后挂载工具与客户端卡片，无需手改任何配置文件。

## 接收方：安装（一条命令）

```sh
# 任选一种来源，效果相同
dsh plugin --profile web add dsh-plugin-grok2api-media-tool                     # A. 从 npm registry
dsh plugin --profile web add file:./dsh-plugin-grok2api-media-tool-<版本>.tgz   # B. 本地 tarball 文件
dsh plugin --profile web add github:lsjspl/dsh-plugin-grok2api-media-tool   # C. GitHub 仓库
dsh plugin --profile web add file:C:/path/to/grok2api-plugin        # D. 源码目录
```

安装后：

1. **重启 `dsh web`**（客户端清单与依赖变更需重启）。
2. 在对话里说「把 grok2api 地址配成 …，密钥 …」，模型会调用 `configure_grok2api` 写入并立即生效；也可 设置 → 常规 → 打开配置文件，手改 `settings.yaml` 的 `grok2api-media-tool:` 节（插件会热加载，无需重启）。
   设置 → 插件 → 配置 里的 **Grok2API** 卡片是只读说明——dsh 当前版本只把内置命名空间开放给设置页，因此这里不提供表单，请用对话或 `settings.yaml` 配置。

卸载：

```sh
dsh plugin --profile web remove dsh-plugin-grok2api-media-tool   # 自动从 dsh.profile.bundles 移除
```

## 发布方：四种渠道

### A. 发布到 npm（公开分发，推荐）

```sh
cd grok2api-plugin
npm publish        # 首次需 npm login；包名 dsh-plugin-grok2api-media-tool
```

发布后接收方用 `dsh plugin --profile web add dsh-plugin-grok2api-media-tool` 安装。

### B. 分发 tarball（内网 / 无 registry）

```sh
cd grok2api-plugin
pnpm pack --pack-destination dist
# 产物：dist/dsh-plugin-grok2api-media-tool-<version>.tgz（含 index.js/api.js/media.js/client.js/cordis.patch.yml/README.md/package.json）
```

把 `.tgz` 文件发给对方，对方 `dsh plugin --profile web add file:<tgz 路径>`。

### C. GitHub 仓库

源码仓库：<https://github.com/lsjspl/dsh-plugin-grok2api-media-tool>。接收方 `dsh plugin --profile web add github:lsjspl/dsh-plugin-grok2api-media-tool`（pnpm 以 git 依赖安装）。本插件**无 build/prepare 脚本**，不会触发 pnpm 的构建脚本拦截；如未来加了构建脚本，接收方需按 pnpm 提示在 profile 的 `pnpm-workspace.yaml` 里加 `allowBuilds`。

### D. 直接发源码目录

把整个目录打包发出去，对方 `dsh plugin --profile web add file:<目录绝对路径>`（建议用 `file:` 而非 `link:`，file: 安装副本与发布方目录解耦，改动互不影响）。

## 依赖与兼容性

- **无需接收方手动安装任何依赖**：peer 依赖（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`）全部由 dsh 安装自带的模块回退（`$DSH_HOME/profiles/node_modules` junction）解析；唯一的普通依赖 `js-yaml` 由 pnpm 随安装拉取。
- 兼容性基线：**dsh `0.1.0-rc.7`**（按该版本的插件 API / settings / client-modules 机制开发）。dsh 仍处于 pre-release，接口可能变化；升级 dsh 后如插件报错，优先重新安装本插件的最新版。
- 运行时要求：接收方 Node ≥ 22（dsh 自身要求），grok2api 服务需网络可达。
- 插件不依赖接收方 grok2api 的部署位置：地址/密钥/后端类型全部由接收方在自己的设置里填。

## 版本发布检查单

发布新版本前：

```sh
node --check index.js && node --check client.js && node test/smoke.mjs   # 26 项 smoke 全绿
pnpm pack --pack-destination dist                                        # 确认 tarball 内容
```

确认包内包含：`index.js`、`api.js`、`media.js`、`media-proxy.js`、`client.js`、`cordis.patch.yml`、`README.md`、`package.json`（缺 `cordis.patch.yml` 会导致 bundle 层失效、缺 `client.js` 会导致启动时报 client bundle 缺失）。

走 GitHub 分发前另外确认：`.ref/`（本地参考仓库）与 `.tmp/`（测试临时目录）没有被提交——它们体积很大且不属于本插件，`.gitignore` 已列出。
