# AI-contest · 余讯 6.1

**如果只有 1% Battery，你最想留下什么？**

余讯是一件以极简信息传递为主题的交互网页作品。全屏开场之后，观众在有限字节预算内选择、编辑和分类消息，再查看抵达与留下的便笺。页面采用动态切页，无需下滑推进主流程。

当前版本为 **6.1.0**：已移除全景系统，保留「1% → 整理 → 抵达 → 留下」四个逻辑状态。纯 HTML、CSS 和 JavaScript 模块实现，无前端框架、业务后端或运行时依赖。

## 快速启动

需要 **Node.js 18+** 或 **Python 3.8+**，任选其一。所有字体与图标随仓库提供；**不需要 `npm install`，不需要构建**。

```sh
git clone https://github.com/ZCravenQ/AI-contest.git
cd AI-contest
npm start
```

浏览器打开 **http://127.0.0.1:8080**。按 `Ctrl+C` 停止。

Windows 也可直接双击仓库根目录的 **`start-local.bat`**，启动器会依次检查 Python 3、Python、Node.js。

不使用 npm 时，可任选对应命令：

```sh
node scripts/serve.mjs
```

```sh
py -3 scripts/serve.py
```

```sh
python3 scripts/serve.py
```

两种启动器都只监听本机 `127.0.0.1:8080`，只提供静态文件。端口占用时请关闭先前的启动窗口。不要直接双击 `public/index.html`：浏览器的 JavaScript 模块需要 HTTP 环境。

## 仓库结构

| 路径 | 用途 |
| --- | --- |
| `public/` | 可直接部署的完整静态网站 |
| `public/index.html` | 页面内容与结构 |
| `public/last-signal-v61.css` | 全屏入口与当前布局 |
| `public/last-packet.css` | 共享基础样式 |
| `public/last-signal-v61.mjs` | 页面交互与状态控制 |
| `public/minimal-v61.mjs` | 默认消息、分类覆盖与容量内推荐 |
| `public/packet-v6.mjs` | 当前分类消息包的编码与校验 |
| `public/packet-core.mjs` | 旧便笺协议兼容 |
| `public/scene-motion-v6.mjs` | 切页动画与减少动态效果支持 |
| `public/receipt-layout.mjs` | 便笺完整文字分页 |
| `public/fonts/`、`public/icons/` | 本地素材及其许可证 |
| `scripts/` | Node.js / Python 本地静态启动器 |
| `tests/` | 编码、分页、动画状态及交互检查 |
| `docs/` | 设计说明与自检报告 |

源码文件名中的 `v6`、`v4` 表示沿用的模块或兼容协议；当前作品版本以此 README 和 `package.json` 的 **6.1.0** 为准。

## 修改与验证

直接修改 `public/` 内源码，保存后刷新浏览器即可；缓存旧内容时按 `Ctrl+F5`。

使用 Node.js 运行测试：

```sh
npm test
```

测试包含 40 项编码、分页与动效状态检查，以及 23 组 DOM 交互检查。交互测试使用受限的 DOM 模型，不能替代真实浏览器视觉、软键盘、辅助技术和动画观感验收。

## 部署

把 **`public/` 内的全部内容** 放到任意静态网站目录，入口为 `index.html`，保留资源的相对目录。无需服务器业务逻辑、数据库、密钥或环境变量。

托管服务需要将 `.mjs` 以 `text/javascript` 或 `application/javascript` 提供。仓库未配置自动发布流程；可按目标平台把 `public/` 设为发布目录。

## 设计与边界

- 「1%」是作品的假设情境，不读取设备电量；字节预算不能换算为实际续航。
- 消息不会发送给真实联系人。页面内的抵达、断开和留下均为本地交互演示。
- 便笺只存于当前浏览器及当前网址；换网址、换浏览器不会同步，清除浏览器数据可能删除记录。需要留存时使用作品内下载功能。
- 分类覆盖用于帮助取舍，不代表内容语义完整或安全保证。

详见 [设计说明](docs/DESIGN.md) 和 [自检报告](docs/SELF_REVIEW.md)。第三方素材与设计参考见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

本仓库没有为作品自有源码声明开源许可证；字体和图标保留各自的原始许可证。
