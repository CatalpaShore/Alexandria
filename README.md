<p align="center"><img src="client/public/brand-icon.png" alt="Alexandria 18+ 典藏图标" width="104"></p>
<h1 align="center">Alexandria 18+ · 亚历山大典藏</h1>
<p align="center"><strong>18+ 个人影库</strong> · 自行部署 · 本地优先 · 保留你的整理与观看记录</p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-D4AF37" alt="MIT 许可证" /></a>
  <a href="#快速开始"><img src="https://img.shields.io/badge/Node.js-22%2B-5FA04E?logo=nodedotjs&amp;logoColor=white" alt="Node.js 22 或更新版本" /></a>
  <a href="#快速开始"><img src="https://img.shields.io/badge/pnpm-11.7.0-F69220?logo=pnpm&amp;logoColor=white" alt="pnpm 11.7.0" /></a>
  <a href="#docker"><img src="https://img.shields.io/badge/Deployment-Docker_Compose-2496ED?logo=docker&amp;logoColor=white" alt="支持 Docker Compose 部署" /></a>
  <a href="#数据隐私与示例"><img src="https://img.shields.io/badge/Audience-18%2B-9A3412" alt="仅限 18 岁及以上成年人" /></a>
  <a href="https://github.com/CatalpaShore/Alexandria/stargazers"><img src="https://img.shields.io/github/stars/CatalpaShore/Alexandria?style=flat&amp;logo=github&amp;label=Stars&amp;color=D4AF37" alt="GitHub Stars" /></a>
</p>
<p align="center"><strong>简体中文</strong> · <a href="README.en.md">English</a> · <a href="README.ja.md">日本語</a></p>
<p align="center"><a href="#界面预览">界面预览</a> · <a href="#功能详解">功能详解</a> · <a href="#快速开始">快速开始</a> · <a href="demo/README.md">非成人 Demo</a> · <a href="#内容源与播放兼容">兼容范围</a> · <a href="docs/MIGRATION.md">迁移指南</a> · <a href="docs/OPERATIONS.md">配置与使用</a> · <a href="docs/README.md">文档导航</a> · <a href="docs/USER_GUIDE.md">功能使用指南</a></p>

> **[在线体验非成人 Demo →](https://catalpashore.github.io/Alexandria/)** · 无需安装。可体验媒体墙、搜索、详情、示例播放、三语字幕、专题与模拟个人记录；导入、转码、备份和模型服务需自行部署。演示仅含 12 部开放电影资料与原创测试片。

> **18+：本项目面向成年人管理自己的个人成人影库。** 请仅导入自己有权持有和使用的内容，并遵守所在地适用规则。仓库不提供成人影片、成人封面或下载资源；README 截图和公开 Demo 使用真实非成人开放电影资料、按 CC BY 授权的图片，以及明确标注的模拟观看记录。

Alexandria 18+ 把媒体墙、播放、专题、观影台、智能馆长和个人媒体手记放在一起。这是一套采用黑金界面的开源个人媒体平台，支持已有影库接入、字幕兼容以及更换磁盘后的记录保留。

## 产品介绍视频

https://github.com/user-attachments/assets/359b205e-9093-42ce-9cda-70d70dddffb3

**[▶ 观看介绍视频](https://cdn.jsdelivr.net/gh/CatalpaShore/Alexandria@master/client/public/tour/product-tour.mp4) · 2 分 18 秒 · 中文配音**

[中文字幕](client/public/tour/subtitles-zh.vtt) · [完整功能使用指南](docs/USER_GUIDE.md)

## 可以做什么

- **从媒体墙开始看**：海报墙、短视频浏览、搜索筛选、随机浏览、版本聚合和媒体详情。
- **接入已有影库**：本地硬盘与已经挂载的 NAS 目录一起索引，读取 NFO、JSON 元数据、海报和字幕，保留手动修改。
- **播放与字幕**：直接播放、封装转换、转码 / HLS；切换本地与内嵌文本字幕，手动选择乱码字幕的编码。
- **把收藏整理成体系**：人物、系列、题材、厂商等专题与关系图，收藏、片单、精彩片段、播放进度、用户切换和统计。
- **决定今晚看什么**：观影台利用馆藏和已有记录组织候选；智能馆长可选连接本地 Ollama。未接入模型时展示明确标注的固定示例，不伪装成模型回答。
- **保留长期记录**：个人媒体手记、数据备份、任务中心、入库审计与迁移预览。

媒体扫描与本地资料导入不改动源文件。手动入库、改名、整理等管理动作另有入口；尝试迁移前先备份，详见[迁移指南](docs/MIGRATION.md)。项目聚焦个人媒体的整理、发现与观看。

## 界面预览

以下均为实际运行截图，展示的是非成人 Demo。点击图片查看原图；截图不包含真实成人封面、演员照片或私人路径。

| 媒体墙：搜索、筛选与海报浏览 | 智能馆长：未接入模型时的固定示例 |
| --- | --- |
| [![Demo 媒体墙](docs/screenshots/media-wall.png)](docs/screenshots/media-wall.png) | [![馆长固定示例，非 AI 回答](docs/screenshots/curator-demo.png)](docs/screenshots/curator-demo.png) |
| **播放器：字幕与播放控制** | **观影台：选择下一部** |
| [![播放器与中文字幕](docs/screenshots/player-subtitles.png)](docs/screenshots/player-subtitles.png) | [![观影台：选择下一部](client/public/showcase/viewing-desk.png)](client/public/showcase/viewing-desk.png) |

*播放器：实际播放 12 秒原创兼容测试片，支持中英日示例字幕及编码切换；测试片不是电影正片。电影图片保存在仓库中，来源和许可见[电影素材清单](docs/DEMO_FILMS.md)。*

### 更多界面效果

以下截图均来自独立非成人 Demo，包含 12 部真实开放电影、授权图片与模拟观看记录；图片内为中文界面，实际应用可切换三种语言。

| 专题浏览：人物、主题与标签 | 作品详情：资料、文件与播放入口 |
| --- | --- |
| [![专题浏览：人物、主题与标签](client/public/showcase/topics.png)](client/public/showcase/topics.png) | [![作品详情：资料、文件与播放入口](client/public/showcase/media-detail.png)](client/public/showcase/media-detail.png) |
| **知识图谱：沿关系逐层探索** | **个人媒体手记：收藏与观看轨迹** |
| [![知识图谱：沿关系逐层探索](client/public/showcase/knowledge-graph.png)](client/public/showcase/knowledge-graph.png) | [![个人媒体手记：收藏与观看轨迹](client/public/showcase/personal-library.png)](client/public/showcase/personal-library.png) |

**移动端媒体墙**

| 媒体墙 | 专题浏览 | 观影台 | 智能馆长 |
| --- | --- | --- | --- |
| [<img src="client/public/showcase/mobile-wall.png" width="180" alt="媒体墙" />](client/public/showcase/mobile-wall.png) | [<img src="client/public/showcase/mobile-topics.png" width="180" alt="专题浏览" />](client/public/showcase/mobile-topics.png) | [<img src="client/public/showcase/mobile-viewing.png" width="180" alt="观影台" />](client/public/showcase/mobile-viewing.png) | [<img src="client/public/showcase/mobile-curator.png" width="180" alt="智能馆长" />](client/public/showcase/mobile-curator.png) |

全部图片保存在仓库中，点击可查看原图。录像和截图的来源、脱敏范围及公开 Demo 的隔离规则见[资源说明](docs/ASSETS.md)。

Demo 使用《Big Buck Bunny》《Sintel》《Spring》《Wing It!》等真实非成人开放电影的事实资料，补齐导演、配音演员、题材、片单、收藏及观看轨迹。模拟数据不代表真实用户行为，馆长仍为预设文案。可在顶部“素材来源与演示说明”查看授权与原始作品链接。

## 功能详解

按功能了解能力后，可点击每节末尾的链接查看操作步骤、文件示例和排查方法。也可从[文档导航](docs/README.md)按任务查找。

### 1. 媒体墙、搜索与多版本浏览

- 在海报墙和短视频视图之间切换，从媒体详情查看文件、资料和播放入口；也可以随机浏览馆藏。
- 按演员、题材、导演、厂商、厂牌、系列、番号前缀、来源目录、文件类型等筛选，结合收藏状态和观看状态缩小范围。搜索建议可直接定位到相关作品或专题。
- 同一作品的多个文件可聚合展示，再选择实际要播放的版本。版本聚合用于浏览整理，不会删除或合并磁盘文件。

[详细操作](docs/USER_GUIDE.md#media-wall)

### 2. 导入已有媒体库与本地资料

- 把硬盘、外置盘或已挂载的 NAS 目录加入媒体源，无需先重排整套目录；扫描读取文件信息并建立索引。普通扫描不会移动、改名或改写源文件。
- 读取影片旁的 NFO、`.media.json`、海报和字幕；同名 JSON 按字段覆盖 NFO，已有手动修正与已完成的外部资料优先，避免重新扫描覆盖个人整理结果。
- 海报与普通图片分别识别，避免电影封面混进图片墙。元数据管理与质量检查帮助定位缺失字段、冲突资料和文件关联问题；外部补充服务需要自行配置。

[详细操作](docs/USER_GUIDE.md#library-import) · [本地资料示例](docs/USER_GUIDE.md#metadata)

### 3. 播放器、字幕与进度

- 播放器支持播放进度记录和继续观看。根据文件与浏览器能力使用直接播放、封装转换或转码 / HLS；FFmpeg / FFprobe 负责媒体探测和需要的转换。
- 支持外置 SRT、ASS、SSA、VTT，以及 MKV / MP4 内嵌文本字幕的轨道选择。字幕乱码时可切换字符编码，不必先改写字幕文件。
- 文本字幕提取为浏览器可用的 VTT；ASS / SSA 的复杂排版和特效不会完整保留，图片字幕暂不支持。编码、音轨和设备能否播放仍取决于浏览器与 FFmpeg，不能保证所有文件直接播放。

[详细操作](docs/USER_GUIDE.md#playback) · [字幕与编码](docs/USER_GUIDE.md#subtitles)

### 4. 专题与知识图谱

- 按演员、主题 / 系列、标签、番号前缀、导演、厂商和厂牌浏览专题，查看相关作品并在不同维度间继续探索。
- 专题可搜索，并按作品数、名称、最近更新或随机顺序排列；关系图用于发现人物、作品和分类之间的联系。
- 展示范围取决于实际导入的元数据。公开仓库不附带完整的演员资料库或演员照片，自有资料和外部补充需单独配置。

[详细操作](docs/USER_GUIDE.md#topics)

### 5. 观影台：从候选中做选择

- 观影台结合本地馆藏、收藏、观看历史和近期入库内容组织候选，提供快速选择、探索、收藏和未看等入口，不要求先部署语言模型。
- 通过主题条件与成对选择逐步缩小范围，结果分为“最合口味”“换点新意”“大胆试试”，便于在熟悉偏好和新内容之间选择。
- 可继续上一次会话，或从近期会话复用、调整条件。这里的本地选择流程与智能馆长的模型对话是两个独立入口。

[详细操作](docs/USER_GUIDE.md#viewing-desk)

### 6. 智能馆长：可选的本地模型助手

- 可连接自行部署的 Ollama，分别配置对话模型和向量模型，并手动加载或卸载。支持多会话、自然语言检索，以及通过 `@`、`/`、`#` 选择实体、意图和约束。
- 接入后可基于馆藏资料、收藏与观看记录检索，展示带资料引用的推荐、专题、比较和摘要卡片。涉及修改的操作通过确认卡片让用户审核；模型回答仍需结合引用核对。
- **没有启用模型时，展示固定的非成人示例。** 页面明确标注“固定示例 / 非 AI 回答”，用于了解交互效果，不会生成真实推理结果，也不会把示例写入真实会话或影库。
- 模型运行时、模型文件和配置均不随仓库分发；外部服务默认关闭。如果把服务地址指向远端，对应查询和上下文会发送到该地址。配置见[使用说明](docs/OPERATIONS.md)。

[详细操作](docs/USER_GUIDE.md#curator)

### 7. 收藏、片单与个人媒体手记

- 使用收藏和片单组织想看、常看或特定主题的作品；播放进度、继续观看、已看状态和历史记录形成长期观看记录。
- 个人媒体手记汇总近期入库、继续观看、观看历史、完成情况和偏好统计，也可删除观看记录或调整完成状态。它以观看数据回顾为主。
- 可切换个人档案，分别保留个人收藏、进度和片单等状态；这不等同于企业级多用户权限管理。

[详细操作](docs/USER_GUIDE.md#personal-library)

### 8. 精彩片段：保存独立片段

- 在播放器中指定开始和结束时间，或把当前播放位置设为边界，截取 1 秒至 30 分钟的片段。
- 片段单独生成和保存，原视频不被改写。生成完成后可播放、循环观看或下载，也可查看排队、处理、失败和重试状态。
- 生成过程依赖可用的原视频、FFmpeg 和片段存储目录；删除片段只清理对应片段，不删除原作品。请把需要长期保存的片段一起纳入备份。

[详细操作](docs/USER_GUIDE.md#highlights)

### 9. 统计、入库审计与维护

- 资料质量检查和影库统计帮助发现整理缺口；任务相关入口用于查看后台处理进度与失败情况。
- 可配置本地待整理文件的定时入库，按批次查看结果及原路径、目标路径；移动后的回滚取决于文件和路径是否仍可用。它不是云盘下载或订阅追更服务。
- 自动扫描与会移动文件的入库 / 整理操作分开。操作真实影库前先核对预览与审计信息，并保留独立备份。

[详细操作](docs/USER_GUIDE.md#maintenance)

### 10. 备份、媒体源迁移与离线记录

- 备份中心支持手动与定时备份，并配置备份位置和范围。数据库快照不能代替全部资料备份，海报、字幕、片段及其他独立文件也需要保留。
- 更换磁盘或挂载点前可预览媒体源变化。来源分类、名称和相对路径保持一致时保留媒体 ID；预先建立的完整文件指纹可辅助匹配改名或移动后的文件，歧义重复项不自动合并。
- 媒体源断开时保留离线记录，不直接删除收藏和观看历史。数据库结构更新时会先创建一致性快照；迁移仍应在独立副本上验收，禁止多个服务实例同时使用同一数据库。
- 大型 NAS 上首次计算完整指纹可能较慢；真实完整库迁移与大规模负载尚未完成验证。准备步骤和匹配边界见[迁移指南](docs/MIGRATION.md)。

[详细操作](docs/USER_GUIDE.md#backup-migration)

### 从哪里开始

| 使用场景 | 建议路径 |
| --- | --- |
| 先看看界面和播放效果 | 运行独立非成人 Demo；预设收藏、片单和历史可查看，修改操作被阻止 |
| 已有整理好的硬盘 / NAS 影库 | 配置媒体源 → 扫描本地资料 → 检查质量问题 → 测试播放和字幕 |
| 不知道今晚看什么 | 打开观影台，选择候选条件；不需要语言模型 |
| 想用自然语言查找馆藏 | 自行部署并配置 Ollama，在馆长中加载模型后使用 |
| 更换磁盘或导入已有数据 | 备份全部数据 → 使用独立副本 → 预览源变化 → 验收记录与播放 |

### 界面语言

首页顶部可切换 **中文 / English / 日本語**，默认中文，并记住当前浏览器的选择。切换语言不会重置筛选、修改媒体资料或影响目录配置；界面语言与播放器中的字幕语言、中文 / 日文元数据切换分别管理。主要浏览与操作界面采用翻译词典，未翻译的维护说明回退中文；影片标题、演员名、用户输入与服务端原始诊断信息保持原始内容。

## 快速开始

需要 **Node.js 22、pnpm 11.7.0、FFmpeg / FFprobe**。目前以源码运行。已有影片时优先使用下方接入流程；只想看效果可运行独立非成人 Demo。

### 让 AI 助手帮你初始化

如果你使用 Codex 等能访问项目文件和终端的 AI 编程助手，可以在打开本项目后复制下面的提示词。告诉助手媒体目录的绝对路径；如果暂时没有媒体，也可以先运行 Demo。

```text
请帮我在本机初始化并启动 Alexandria 18+。先阅读项目 README 和 docs/GETTING_STARTED.md，
根据当前系统执行，不要假设我的用户名、目录或已安装的软件。

1. 检查 Node.js、Corepack、pnpm、FFmpeg 和 FFprobe；使用项目要求的 Node.js 22
   和 pnpm 11.7.0，安装项目依赖并运行 corepack pnpm@11.7.0 doctor。遇到缺少工具或权限问题时，
   说明需要我做什么；不要删除现有环境或覆盖已有配置。
2. 如果我尚未提供媒体目录，询问我是先体验 Demo，还是接入已有影库；接入时向我
   要服务器上可读取的绝对路径。NAS、SMB 或 NFS 目录应先在服务器上挂载。
3. 选择 Demo 时，构建项目并启动独立 Demo，告诉我访问地址和只读限制。
4. 接入已有影库时，先用 corepack pnpm@11.7.0 setup:library --source "目录" --dry-run 检查；
   确认使用我提供的目录后，首次安装再用 --write 创建私有配置，构建并启动服务。
   如发现已有数据库或媒体源配置，不要覆盖或删除；改用首页接入向导进行预览和备份。
5. 检查服务健康状态，说明实际访问地址、扫描状态，以及如何验证一部影片的播放
   和字幕；如果无法完成某项检查，明确告诉我原因，不要把未验证的步骤当作成功。

请保持媒体源文件不被移动、改名或修改，不要把私人路径、媒体、数据库或密钥提交到
Git，也不要自动安装模型或连接外部元数据服务。需要更多信息时再问我。
```

也可以手动执行以下命令，先查看 Demo：

```sh
git clone https://github.com/CatalpaShore/Alexandria.git
cd Alexandria
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 build
corepack pnpm@11.7.0 demo:start
```

先打开 <http://127.0.0.1:4312> 体验非成人 Demo。接入自己的影片请使用下一节流程；开发模式运行 `pnpm dev`，前端端口为 4311。

### 独立的公开 Demo

打开 <http://127.0.0.1:4312>。Demo 使用独立的非成人电影示例库和内存数据库，不读取个人影库配置；可体验浏览、搜索、专题、播放、字幕和馆长示例。收藏、进度写入、目录配置、导入、导出、文件管理及模型请求由服务端阻止。预设收藏、片单和观看记录仅用于展示，重启恢复预设。

Demo 项目说明、容器启动和部署限制见 [demo/README.md](demo/README.md)。当前没有正式线上 Demo 域名；远程仓库与部署地址确定后再补链接。

## 快速接入已有资源

首次安装可运行：

```sh
corepack pnpm@11.7.0 install --frozen-lockfile
pnpm doctor
# 默认只读预览；可重复 --source 添加多个已挂载目录：
pnpm setup:library --source "/absolute/path/to/media" --dry-run
# 确认目录后，首次安装使用 --write 创建私有配置：
pnpm setup:library --source "/absolute/path/to/media" --write
pnpm build
pnpm start
```

脚本支持 `--lang zh-CN|en|ja`，只抽样检查目录并生成配置，不移动、重命名或修改媒体，不安装模型。配置保存在被 Git 忽略的运行目录；已有数据库或媒体源配置不会被覆盖。

服务已运行时，从首页 **“接入媒体库” → 添加目录 → 预览检查 → 备份并开始扫描** 操作，无需填写 JSON。空影库会显示三步引导；复杂的双根目录布局放在高级设置中。

完整步骤、目录示例、NAS / Docker 和常见问题见[上手指南](docs/GETTING_STARTED.md)。

## 内容源与播放兼容

| 能力 | 当前支持与边界 |
| --- | --- |
| 本地与 NAS | 多个本地可读目录（网页接入上限 32 个）；SMB / NFS / 网盘先由系统挂载，容器内使用只读媒体卷 |
| 元数据 | 同名 `.nfo`（movie / episodedetails）、单视频目录的 `movie.nfo`；同名 `.media.json` 按字段覆盖 NFO；已有手动覆盖及已完成外部资料优先 |
| 海报 | 同名 `-poster` / `.poster` / `.cover`，单视频目录的 `poster` / `folder` / `cover`，支持 JPG / PNG / WebP；海报不混入普通图片墙 |
| 本地字幕 | SRT / ASS / SSA / VTT；自动识别 UTF-8 与 UTF-16 BOM，支持选择 GB18030、Big5、Shift JIS、Windows-1252 |
| 内嵌字幕 | FFprobe 枚举 MKV / MP4 文本轨道，FFmpeg 提取为 VTT；图片字幕暂不支持，需另行 OCR |
| 播放兼容 | 支持直接播放、remux、转码与 HLS；实际支持取决于浏览器与部署的 FFmpeg 编解码器；ASS / SSA 转文本后不保留复杂特效 |
| 磁盘迁移 | 先预览源变化并备份数据库；相同源与相对路径保留 ID，完整指纹辅助识别移动；重复内容有歧义时不自动合并 |
| 尚未接入 | 原生 WebDAV / Emby / Jellyfin 连接器、STRM 链接库、音频专用资料库、云盘下载和订阅追更 |

不要把“已挂载目录可用”理解为已实现所有网盘或媒体服务器的原生协议。断开的媒体源会保留记录；收藏、进度等保留规则和误匹配边界见[迁移指南](docs/MIGRATION.md)。

## Docker

```sh
mkdir -p media .local/docker-data
# Linux 下确保数据目录可由容器 node 用户（UID 1000）写入。
ALEXANDRIA_MEDIA_DIR=/absolute/path/to/media docker compose up --build -d
```

默认仅在宿主机回环地址开放 4310；容器内启用配对认证，配对码见本机服务日志。媒体卷只读、数据目录可写。容器与 Android 实机验证状态见[验证记录](docs/VERIFICATION.md)。

## 数据、隐私与示例

- 媒体、数据库、模型、密钥、缓存与私人配置不进入 Git；默认保存在 `.local/`，`.env` 也被忽略。
- 公开源码使用通用路径与可配置目录，不包含开发者用户名、私人磁盘标识、原库目录或账户信息。
- README 图片仅允许审核后的项目图标与非成人截图，按 SHA-256 校验；运行 `pnpm privacy:check` 检查待发布工作区，`pnpm release:check` 检查 Git 索引。
- [成人文字元数据示例](examples/adult-metadata/README.md)只有 3 条已核实的番号、发行时署名、片商和日期；显示标题为中性档案名。运行 `pnpm example:adult-metadata` 可在忽略目录生成独立测试素材。它不包含原作品视频、原封面或成人图片，也不会自动添加到 Demo。
- 外部资料服务与模型需要自行配置。开启后会向配置的服务发出相应查询；详情见[配置说明](docs/OPERATIONS.md)。

## 常见问题

**会改动原媒体文件吗？** 普通扫描、海报读取与本地元数据导入不会。手动入库与文件整理属于管理动作，先看操作预览与审计记录。

**没有模型可以用吗？** 浏览、播放和整理可正常使用。馆长展示标注清楚的固定示例；接入模型后切换到真实对话，首次对话仍需要手动加载模型。

**可以用真实成人内容运行公开 Demo 吗？** 本项目提供的 Demo 固定使用已审阅的非成人电影资料与测试片，没有导入个人影库的入口。个人部署与公开演示使用不同的数据范围。

**如何迁移已有数据？** 先备份完整数据并用副本测试。涉及结构更新时会备份数据库；禁止多个服务实例同时打开同一个数据库。迁移结果仍需按你的实际数据验收。

**手机可以看吗？** 提供响应式界面与 Android 外壳代码。自部署可启用局域网访问与配对认证；Android 实机及所有设备 / 编码组合尚未完成验证。

## 开发与反馈

```sh
pnpm typecheck
pnpm test:unit
pnpm build
pnpm privacy:check
git add .
pnpm release:check
```

反馈请附版本、复现步骤、预期与实际结果。遮盖路径、凭据和局域网地址；不要上传私人数据库、媒体或含成人图片的截图。

[配置与使用](docs/OPERATIONS.md) · [迁移指南](docs/MIGRATION.md) · [Demo 项目](demo/README.md) · [示例与图片来源](docs/ASSETS.md) · [项目范围](docs/SOURCE_BASE.md) · [验证记录](docs/VERIFICATION.md)

## 许可证与致谢

本项目自行编写的代码采用 [MIT](LICENSE)。第三方依赖、模型与媒体分别适用自身许可，见[第三方声明](THIRD_PARTY_NOTICES.md)；例如 GSAP 使用 Standard No Charge 条款。图片与样例来源详见[资源说明](docs/ASSETS.md)。
