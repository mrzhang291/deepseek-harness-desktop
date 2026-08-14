# DeepSeek Harness Desktop

DeepSeek Harness 的 Windows 桌面版：开箱即用，双击即装。内置 `dsh web` 后端，
自带会话迁移，与网页版数据互通。

## 下载

| 版本 | 说明 | 下载 |
| --- | --- | --- |
| 安装版 | 创建桌面快捷方式，推荐 | [DeepSeek-Harness-Setup-0.1.0.exe](https://github.com/mrzhang291/deepseek-harness-desktop/releases/download/v0.1.0/DeepSeek-Harness-Setup-0.1.0.exe) |
| 便携版 | 免安装单文件 | [DeepSeek-Harness-Portable-0.1.0.exe](https://github.com/mrzhang291/deepseek-harness-desktop/releases/download/v0.1.0/DeepSeek-Harness-Portable-0.1.0.exe) |

## 安装步骤

1. 上表点选一个版本下载 exe
2. 双击运行。若提示 SmartScreen「未知发布者」：点「更多信息 → 仍要运行」（未做代码签名，正常现象）
3. 首次启动进入「首次配置」：确认迁移源后点 **开始使用**，自动迁移网页版会话 → 启动后端 → 进入 DeepSeek Harness；之后每次启动直接进入界面

**前置条件**：Windows 10 / 11 x64。无需安装 Node.js 或其他任何依赖。

## 功能

- 一键启动本地 `dsh web` 后端，自动端口、崩溃自动重启、托盘常驻
- 会话迁移工作台：从网页版（`~/.dsh`）迁移项目/会话/设置/凭据，命名与侧栏顺序完全一致；幂等、可增量同步
- 双后端：本机 fork 已构建则优先使用，否则用内置 npm 包（无需构建）
- 数据目录自适应：本机 `D:\deepseek`，其他机器自动 `%LOCALAPPDATA%\DeepSeekHarness`

## 从源码运行（可选）

```powershell
git clone https://github.com/mrzhang291/deepseek-harness-desktop.git
cd deepseek-harness-desktop
npm install     # 需要 Node.js ≥ 24
npm start
```

打包：

```powershell
# 把系统 Node 复制进 node-runtime\（首次打包需要）
New-Item -ItemType Directory node-runtime | Out-Null
Copy-Item "$env:ProgramFiles\nodejs\node.exe" node-runtime\node.exe
npm run dist    # 产物在 release\
```

## 配置

配置文件 `<数据根目录>\launcher-config.json`，常用项：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `backend` | `auto` | `auto` / `fork` / `npm` |
| `port` | `0` | 后端端口，0 = 自动 |
| `home` | `<root>\home` | 会话数据目录 |
| `closeToTray` | `true` | 关窗最小化到托盘 |

## License

[MIT](LICENSE) · 后端 [deepseek-harness](https://github.com/mrzhang291/deepseek-harness)
