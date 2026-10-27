# Alexandria 18+ Demo 项目

[文档导航](../docs/README.md) · [Demo 体验顺序](../docs/USER_GUIDE.md#demo) · [各功能操作指南](../docs/USER_GUIDE.md)

提供可操作的非成人产品演示。示例库包含 12 部真实开放电影的片名、年份、导演与配音演员资料，配以按各自 CC BY 许可使用的官方项目页图片。没有成人影片、成人图片或真实 AV 元数据。播放的是本项目生成的 12 秒兼容测试片，不是电影正片。

## 本机启动

在仓库根目录执行：

```sh
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 build
corepack pnpm@11.7.0 demo:start
```

需要 Node.js 22 与 FFmpeg / FFprobe，访问 <http://127.0.0.1:4312>。电影资料和已审阅的授权图片随仓库提供，生成器启动时不下载远程素材。首次安装依赖仍需要网络。

## 资料与图片来源

顶部“素材来源与演示说明”列出每部电影的官方链接、图片署名及许可。完整清单见[电影素材说明](../docs/DEMO_FILMS.md)。界面中的主题分组为编辑演示；`Caminandes` 是作品实际所属系列。观看、收藏和片单都是预设模拟数据，没有虚构评分或热度。三种语言的示例字幕用于验证播放和切换，不是原片对白。

## 展示内容

媒体墙、搜索筛选、人物 / 题材 / 系列专题、关系图、原版播放器、中文字幕、个人媒体手记及馆长固定示例。预设 6 条收藏、3 个片单、4 个专题收藏和一周内 8 条观看记录，让界面更接近实际影库。它们不是用户行为或模型生成结果。

馆长只展示固定文案，不调用本地或远程模型。推荐卡片引用当前示例库中的真实电影，可打开作品详情；普通自部署环境未接模型时保留独立占位内容。

## 隔离与限制

- `AMW_DEMO_MODE=true` 在加载 `.env` 后重新限定目录与功能，忽略个人媒体源、数据库路径、元数据服务、模型服务、远程挂载与后台入库配置。
- 仅扫描 `.local/public-demo/movies`。启动前核对文件清单、SHA-256、额外文件与符号链接；发现异常拒绝启动。不要手动修改此目录，重新生成时使用新的空目录。
- SQLite 数据库只存在内存中，不连接用户数据库。生成的资源和缓存均在被 Git 忽略的 `.local/public-demo/`；不会写入普通部署的 `.local/data`。
- API 写操作由服务端统一返回 `DEMO_READ_ONLY`；浏览器中可操作的筛选、播放和字幕选择仍可使用。部分原版按钮点击时会提示只读。
- 路径、配置、诊断、备份导出、文件整理、扫描和模型 API 不公开。可读 API 中的工作目录统一显示为 `/demo`。
- 没有给 Demo 挂载个人媒体的必要，也不应把普通部署改为免认证后用作公开 Demo。

## GitHub Pages 静态演示

**[打开非成人在线 Demo](https://catalpashore.github.io/Alexandria/)** · 无需安装。

Pages 版本复用同一套界面，以浏览器内的只读接口展示经过校验的电影资料。支持搜索筛选、详情、示例视频播放、中英日字幕、专题与关系图、模拟收藏和片单、观看记录、观影台及馆长固定示例。

导入、扫描、转码、字幕翻译、文件管理、备份和模型服务需要自行部署；在线演示不执行这些操作，也不保存收藏或观看进度。播放资源是 12 秒原创测试片，绝非电影正片。语言选择与界面偏好保存在当前浏览器。

```sh
pnpm demo:online:build
node --test tests/online-demo/api.test.mjs
pnpm exec playwright test --config playwright.online.config.ts
```

输出目录为 `.local/online-demo/site`，默认子路径 `/Alexandria/`；更改仓库名时可设置 `DEMO_BASE_PATH=/your-repo/`。通过 HTTPS 或 localhost 打开，需要支持 Service Worker 的现代浏览器，不支持直接双击 HTML。所有电影图片、测试片和字幕都随站点提供，播放时无需连接本地服务。

仓库的 [Pages 工作流](../.github/workflows/demo-pages.yml) 从公开源码重建隔离 Demo，在 API 和桌面 / 手机浏览器测试通过后上传静态目录。仓库 Settings → Pages → Source 选择 **GitHub Actions**，再运行该工作流。发布包排除介绍录像及宣传截图，不包含数据库、环境文件或宿主目录。

## 容器部署

```sh
docker compose -f compose.demo.yaml up --build -d
```

访问 <http://127.0.0.1:4312>。此配置不挂载宿主媒体或数据库，运行目录使用临时文件系统。需要关闭时只停止这个 compose 项目。

容器版仍可用于自建演示服务。在容器前配置 HTTPS 反向代理，仅映射 Demo 服务端口；不要挂载个人媒体。GitHub Pages 使用上面的静态版本，不运行此容器。

代码入口：[启动器](../scripts/start-demo.mjs)、[环境隔离](../server/src/demoEnvironment.ts)、[只读 API](../server/src/demoAccess.ts)、[素材生成](../scripts/create-demo.mjs)。
