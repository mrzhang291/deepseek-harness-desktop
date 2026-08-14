# DeepSeek Harness Desktop

DeepSeek Harness 的 Windows 桌面版：把 [deepseek-harness](https://github.com/mrzhang291/deepseek-harness) 的
`dsh web` 浏览器界面封装成桌面应用，自带**会话迁移**功能 —— 可以把网页版实例里的全部
项目、会话、设置与 API 凭据一键迁移到桌面版，命名与侧栏顺序和网页版完全一致。

> 与网页版（`npx dsh web`）完全兼容：桌面版独立运行一个 `dsh web` 后端，
> 数据目录独立，可与网页版同时使用、互不影响。

## 功能特性

- 🐳 一键启动：应用启动即拉起本地 `dsh web` 后端（127.0.0.1 + 自动空闲端口），进入完整 Harness 界面
- 📦 会话迁移工作台：从任意 DSH 数据目录（默认自动探测 `~/.dsh`）迁移项目/会话/设置/凭据
  - 幂等 + 增量刷新：重复迁移不会产生重复项，源更新会自动同步
  - storages 智能合并：`workspace.json` / `session_projcache.json` 按主键合并，
    保证项目名、会话标题、排序与网页版一致
- 🖥️ 托盘常驻：关窗最小化到托盘，托盘菜单可打开界面、同步网页版数据、重启后端、打开数据/日志目录
- 🔁 双后端自动选择：优先使用你本地构建的 fork（`deepseek-harness`），否则回退到内置的
  npm 包 `@deepseek-ai/dsh` —— 未构建 fork 的机器开箱即用
- 🛡️ 崩溃自动重启（退避策略）、启动日志、单实例锁

## 安装（Windows）

### 方式一：安装包（推荐）

1. 到本仓库 [Releases](https://github.com/mrzhang291/deepseek-harness-desktop/releases) 页面下载最新版
   **`DeepSeek-Harness-Setup-x.y.z.exe`**
2. 双击运行，按向导安装（会创建桌面和开始菜单快捷方式）
3. 首次启动进入「首次配置」：确认迁移源后点 **开始使用**，自动完成
   迁移 → 启动后端 → 进入 DeepSeek Harness；之后每次启动直接进入界面

### 方式二：便携版（免安装）

下载 **`DeepSeek-Harness-Portable-x.y.z.exe`** 双击即用，单文件、不写注册表。

### 前置条件（使用安装包）

- Windows 10 / 11 x64
- **无需安装 Node.js 或任何其他依赖**（应用内置 Node 运行时与全部 npm 依赖）
- 无 `D:` 盘也没关系：数据目录会自动落在 `%LOCALAPPDATA%\DeepSeekHarness`

> SmartScreen 提示：当前 exe 未做代码签名，首次运行 Windows 可能提示「未知发布者」，
> 点「更多信息 → 仍要运行」即可。

## 从源码运行 / 构建

### 前置条件（源码方式）

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 24（Windows x64） | 运行与打包必需 |
| npm | 随 Node 自带 | 安装依赖 |
| pnpm | 可选 | 仅当你需要构建 fork 后端时 |
| git | 任意 | 克隆仓库 |

> 国内网络已内置 npmmirror 的 Electron 镜像（`.npmrc`），`npm install` 无需代理。

### 运行

```powershell
git clone https://github.com/mrzhang291/deepseek-harness-desktop.git
cd deepseek-harness-desktop
npm install
npm start
```

### 打包为安装包 / 便携版

```powershell
# 1) 准备打包用 Node 运行时（应用用它跑 dsh，避免 Electron 内嵌 Node 的 FFI 问题）
New-Item -ItemType Directory node-runtime | Out-Null
Copy-Item "$env:ProgramFiles\nodejs\node.exe" node-runtime\node.exe
Copy-Item "$env:ProgramFiles\nodejs\LICENSE" node-runtime\LICENSE   # 无此文件可跳过

# 2) 生成图标（可选，仓库已带生成好的图标）
npm run icons

# 3) 打包（产物在 release\）
npm run dist
```

### 可选：使用你自己的 fork 后端

本应用后端按 `backend` 配置自动选择：

- `auto`（默认）：存在 `<数据根目录>\deepseek-harness\apps\cli\lib\bin.js` 就用 fork，否则用内置 npm 包
- `fork`：强制使用 fork
- `npm`：强制使用内置 npm 包

fork 构建方式：

```powershell
git clone https://github.com/mrzhang291/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm build        # 产物在 apps\cli\lib\bin.js
```

## 会话迁移

桌面版与网页版**数据完全隔离**，迁移是**复制而非移动**：

1. 首次启动（或托盘菜单「同步网页版数据」）打开迁移工作台
2. 迁移源自动探测 `~/.dsh`（网页版默认数据目录），也可在 `launcher-config.json` 的
   `sourceHomes` 里指定其他目录
3. 勾选要迁移的项目会话与实例配置（设置 / API 凭据 / 匿名身份 / storages），点「开始迁移」
4. 迁移幂等且支持增量刷新；源实例仍在运行时复制会做 size+mtime 稳定性重试

## 配置

配置文件 `<数据根目录>\launcher-config.json`（首次启动自动生成）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `backend` | `auto` | 后端选择：`auto` / `fork` / `npm` |
| `port` | `0` | 后端端口，`0` = 自动挑选空闲端口 |
| `home` | `<root>\home` | 桌面版 DSH 数据目录（迁移目标） |
| `workDir` | `<root>` | 新会话的工作目录 |
| `autoStart` | `true` | 启动应用即启动后端 |
| `closeToTray` | `true` | 关闭窗口最小化到托盘 |
| `sourceHomes` | `[]` | 迁移源目录；空 = 自动探测 `~/.dsh` |

数据根目录解析顺序：环境变量 `DSH_LAUNCHER_ROOT` → 已存在的 `D:\deepseek` →
`%LOCALAPPDATA%\DeepSeekHarness`。

## 目录结构

```
├── main/            # Electron 主进程（窗口/托盘/后端进程管理/IPC）
│   ├── migrate.js   # 会话迁移引擎（storages 智能合并、稳定性复制）
│   ├── server.js    # dsh web 子进程：启动/健康检查/崩溃重启
│   └── config.js    # 配置解析（可移植数据根目录）
├── renderer/        # 首页（迁移工作台）与加载页
├── scripts/         # 图标生成、迁移验证等实用脚本
├── assets/          # 图标（官方小鲸鱼）
└── build/           # electron-builder 构建资源
```

## 常见问题

**Q：和网页版（`npx dsh web`）冲突吗？**
不冲突。桌面版使用独立端口与独立数据目录，两者可同时运行。

**Q：迁移后命名和网页版不一样？**
确认迁移时勾选了「storages（会话命名/排序）」。桌面版先前自动生成的缓存会被源数据合并覆盖。

**Q：后端起不来？**
看 `<数据根目录>\logs\launcher.log` 与 `dsh-server.log`；端口被占用会自动改绑空闲端口。

**Q：怎么彻底卸载？**
安装版：设置 → 应用 → DeepSeek Harness → 卸载（会话数据目录不会被删除）；
便携版：直接删除 exe 文件，数据在数据根目录手动删除。

## 参考与许可

- 后端基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（[本项目的 fork](https://github.com/mrzhang291/deepseek-harness)）
- 桌面壳的进程管理思路参考 [StrayBird-excellent/dsh-desktop](https://github.com/StrayBird-excellent/dsh-desktop)，
  在其基础上新增会话迁移工作台、storages 智能合并、fork/npm 双后端、可移植数据目录
- [MIT License](LICENSE)
