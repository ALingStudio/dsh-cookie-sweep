# dsh-cookie-sweep

[English](./README.en.md) | 中文

每次启动自动清掉 DSH 桌面端网络目录里残留的登录 cookie 文件，避免它们越攒越多、把请求头撑过 16KB，
被服务端 431 退回，界面永久停在 “Web authentication failed”。

## 为什么需要它

桌面端把 cookie 持久化在下面这些位置：

```
%APPDATA%\@deepseek-ai\dsh-desktop\Network\
%APPDATA%\@deepseek-ai\dsh-desktop\Partitions\<分区>\Network\
```

启动次数一多，这些文件只增不减。攒到一定程度，每次请求头都会超过常见的 16KB 上限，服务端直接回 431，
Web 界面就再也登录不上。手动修法是彻底退出 DSH、删掉 `Cookies` 与 `Cookies-journal`、再打开；
这个插件把这一步变成自动的。登录态本身在 `.dsh` 目录里，不受影响。

> 症状对照：启动大约 72 次之后彻底打不开、报 `Web authentication failed`；浏览器网络面板里请求头
> 超过 16KB、服务端回 **431**。如果清理后仍打不开，先确认是不是同一个原因。

## 它做什么

- **启动时清理**：插件被加载时（也就是 DSH 启动时）清一次 `Cookies` / `Cookies-journal`
  （可选连 `Trust Tokens` 一起清）。删除失败会重试约 6 秒，因为正在退出的进程要过一会儿才放开句柄。
- **状态页**：设置 → **Cookie 清理**，逐文件显示 `已删除 / 不存在 / 被占用 / 已跳过 / 已重建`、大小与原因，
  并有一个「立即清理」按钮。

## 安全边界

删除是不可逆的，所以这里刻意保守：

- 只在 `%APPDATA%\@deepseek-ai\<app>\Network` 与 `Partitions\<p>\Network` 里动手，路径由插件自己拼出。
- 只删固定名单里的文件名，绝不通配。
- 非空文件必须在开头看到 SQLite 或 LevelDB 的 cookie 库签名才会删；不像就跳过并在状态里说明。
- `Partitions\temp-*`（一次性会话）一律不碰，避免打乱正在进行的登录流程。
- 任何失败都只写进状态，绝不让插件拖垮启动。

## 配置

`cordis.patch.yml` 里的 `config`：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉后启动不清、手动清理也不可用 |
| `onStartup` | `true` | 每次启动自动清一次 |
| `keepTrustTokens` | `true` | 只清 Cookies，保留 Trust Tokens |
| `extraPaths` | `[]` | 额外的 Electron 网络目录（绝对路径） |

## 安装

在 `cordis.patch.yml` 里插入：

```yaml
- insert:
    - id: cookie-sweep
      name: 'dsh-cookie-sweep'
      config:
        enabled: true
        onStartup: true
```

或者让插件管理器直接指向本目录：

```
plugin_manager install_bundle <本目录的绝对路径>
```

包没有任何运行时依赖：`index.js` 只用 Node 内置模块，`client.js` 是通过
`window.__ModuleLoader__` 加载的普通模块。

## 文件

```
index.js          Host 半部分：清理、重试、复核，以及 /dsh-cookie-sweep 路由
client.js         Client 半部分：设置页
cordis.patch.yml  把这个插件插进 profile 的 bundle patch
locale/*.json     插件列表里的标题与说明（zh / en）
icon.svg          插件列表里的图标
```

## 已知限制

- 运行中的应用会独占主 `Network\Cookies`，所以**本次运行期间**启动清理大概率会报“被占用”。
  把它彻底退出（含托盘）再打开，下一次启动就是在文件被放开之前动手的。
- 主库被占用且应用随后重建它时，状态会显示“已重建”而不是“已删除”——那不是失败，只是它又被新建了。
- 清掉 cookie 库可能要在下次启动时重新授权一次；`.dsh` 里的会话记录不受影响。

## 许可证

MIT
