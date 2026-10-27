import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "client/src/changelog-data.json");
const args = new Set(process.argv.slice(2));

const titleOverrides = new Map(Object.entries({
  "feat: 完善智能馆长、专题资料与移动接入": "完善智能馆长、专题资料与移动接入",
  "feat: 完善智能馆员与平台架构": "完善智能馆长与平台架构",
  "feat: 增加智能馆员与外置 AI 运行时": "增加智能馆长与外置 AI 运行时",
  "feat: 完善字幕播放与页面导航体验": "完善字幕播放与页面导航体验",
  "feat: 优化字幕翻译与播放器布局": "优化字幕翻译与播放器布局",
  "feat: 优化知识图谱节点探索与响应式体验": "优化知识图谱节点探索与响应式体验",
  "feat: 重构知识图谱分层探索并完善观影偏好": "重构知识图谱分层探索并完善观影偏好",
  "feat: 完善知识图谱下钻与时间探索": "完善知识图谱下钻与时间探索",
  "feat: 增加智能观影台 Arena 与知识图谱": "增加智能观影台 Arena 与知识图谱",
  "feat: 增加智能观影 Arena 推荐流程": "增加智能观影 Arena 推荐流程",
  "feat: 重构智能观影台引导与历史偏好": "重构智能观影台引导与历史偏好",
  "feat: 完善内容知识图谱探索体验": "完善内容知识图谱探索体验",
  "feat: 增加智能观影台与内容知识图谱": "增加智能观影台与内容知识图谱",
  "fix: 统一竖版封面显示规则": "统一竖版封面显示规则",
  "feat: 优化本地入库启动与首页数据动效": "优化本地入库启动与首页数据动效",
  "fix: 修复播放兼容与片单收藏流程": "修复播放兼容与片单收藏流程",
  "feat: improve mobile media navigation": "优化移动端媒体导航",
  "feat: refine discovery filters and personal journal": "优化探索筛选与个人媒体手记",
  "feat: improve media operations and responsive experience": "平台运维与响应式体验升级",
  "fix: harden scheduled media ingestion": "加固定时媒体入库规则",
  "fix: run ingestion worker in local development": "修复本地入库任务启动流程",
  "feat: complete ingestion and playlist workflows": "完善自动入库与片单全流程",
  "feat: automate media ingestion and metadata updates": "自动入库与元数据更新",
  "docs: add reusable project skills and refresh documentation": "沉淀可复用技能并更新项目文档",
  "feat: improve Android back navigation and add artifacts": "优化安卓返回导航与构建产物",
  "feat: support custom topic covers": "支持专题自定义封面",
  "feat: merge localized topic aliases": "合并专题中文别名",
  "feat: improve playback and metadata workflows": "完善播放与元数据工作流",
  "feat: expand personal dashboard and data portability": "扩展个人中心与数据迁移能力",
  "fix: minimize player gesture hints": "精简播放器手势提示",
  "fix: stabilize video playback fallback": "增强视频播放回退稳定性",
  "feat: improve navigation and playback reliability": "提升导航与播放可靠性",
  "feat: refine media browsing and playback experience": "优化媒体浏览与播放体验",
  "feat: add metadata file repair workflows": "增加元数据文件修正流程",
  "feat: refine discovery and interaction feedback": "优化内容发现与交互反馈",
  "feat: modularize platform APIs and add home, playlists, and maintenance": "模块化平台接口并增加首页、片单与维护中心",
  "feat: refine metadata filter navigation": "优化元数据筛选导航",
  "feat: add infinite collections and topic favorites": "增加无限滚动收藏与专题收藏",
  "feat: expand media workflows and topic browsing": "扩展媒体工作流与专题浏览",
  "feat: improve search metadata and reel playback": "优化元数据搜索与刷视频播放",
  "chore: update metadata translations and media cards": "更新元数据翻译与媒体卡片",
  "Improve metadata translation glossary": "完善元数据翻译词库",
  "Improve metadata translation quality": "提升元数据翻译质量",
  "Improve metadata translation and cover caching": "优化元数据翻译与封面缓存",
  "Move card favorite control to metadata row": "调整卡片收藏按钮布局",
  "Improve discovery, health, and poster fallbacks": "优化内容发现、健康检查与封面兜底",
  "Add media detail playback and metadata management": "增加媒体详情播放与元数据管理",
  "Add poster caching for media search": "增加媒体搜索封面缓存",
  "Improve metadata enrichment and parsing": "优化元数据补全与解析",
  "docs: update validation spec for filters": "更新筛选验证规范",
  "fix: validate filters and responsive media grid": "修复筛选校验与响应式媒体网格",
  "fix: parse compact JAV filenames": "修复紧凑型 JAV 文件名解析",
  "chore: validate filters and update media docs": "验证筛选并更新媒体文档",
  "Add metadata facets and advanced filters": "增加元数据维度与高级筛选",
  "feat: add metadata backfill and export": "增加元数据补全与导出",
  "Initial adult media wall app": "初始化媒体墙应用",
  "Merge remote master": "合并远程主分支",
  "enhance media wall settings and docker build": "完善媒体墙设置与 Docker 构建",
  "improve media wall browsing": "优化媒体墙浏览体验",
  "build media wall MVP": "构建媒体墙首个可用版本",
  "first commit": "初始化项目仓库"
}));

const changeOverrides = new Map(Object.entries({
  "feat: 完善智能馆长、专题资料与移动接入": [
    { type: "新增", text: "智能馆长增加 @ 实体选择、猜你想问、专题资料卡、馆藏画像与确定性排行，并优化推荐卡、Markdown、引用和对话密度。" },
    { type: "新增", text: "建立演员、导演、厂商、厂牌和系列的公开资料增强链路，统一身份别名、中日文显示、来源快照、辅助存储 图片缓存及 Agent 结构化查询。" },
    { type: "新增", text: "增加 NAS WebView 服务发现与同源反向代理，并完善 Android 客户端的局域网入口、连接状态和后退导航。" },
    { type: "优化", text: "补充实体资料、别名合并、图片安全、Agent 排行、服务发现与反向代理测试，并沉淀可复用专题增强 Skill 和部署文档。" }
  ],
  "feat: 完善智能馆员与平台架构": [
    { type: "新增", text: "完善智能馆长工作区的连续对话、结构化馆藏工具、推荐卡与确定性聚合能力。" },
    { type: "优化", text: "压缩对话页顶部空间和滚动区域，改善 Markdown、引用、思考摘要及桌面与移动端屏效。" },
    { type: "修复", text: "修复推荐结果使用模糊证据编号代替真实番号，以及部分聚合问题无法从全库数据回答的问题。" },
    { type: "优化", text: "同步完善前后端接口、自动化验证与产品技术文档。" }
  ],
  "feat: 增加智能馆员与外置 AI 运行时": [
    { type: "新增", text: "上线智能馆长工作区，支持流式馆藏问答、安全 Markdown、检索过程摘要、媒体依据、会话管理及桌面和移动端导航。" },
    { type: "新增", text: "增加结构化馆藏 RAG、增量向量索引、外置会话数据库和 Agent API，并保持引用只能打开真实馆藏内容。" },
    { type: "新增", text: "增加 辅助存储 外置 AI 存储与 Ollama 运行时的初始化、迁移、启动和系统服务脚本，缺盘或身份不符时禁止回退到本机。" },
    { type: "优化", text: "字幕上下文模型切换到外置运行时，补充外置存储、流式事件与 Markdown 测试，并同步更新产品规范和部署文档。" }
  ],
  "feat: 完善字幕播放与页面导航体验": [
    { type: "新增", text: "播放器增加独立 AI 字幕开关，检测到视频已有中文字幕时默认关闭 AI 图层，避免双字幕重叠。" },
    { type: "修复", text: "Whisper Metal 模型识别失败时按可用模型与 CPU 路径继续回退，并将 Python Whisper 模型缓存到项目可写目录。" },
    { type: "新增", text: "媒体墙和专题页增加响应式回到顶部按钮，滚动后出现且在移动端避让底部导航。" },
    { type: "优化", text: "补充中文字幕检测测试、环境变量和字幕使用文档，并同步完善桌面与移动端交互样式。" }
  ],
  "feat: 优化字幕翻译与播放器布局": [
    { type: "新增", text: "增加本地 ASR 上下文纠错与专用日中翻译，并为成人对白提供内容保真的本地模型分流和安全回退。" },
    { type: "新增", text: "翻译管理支持收藏视频空闲自动入队、已完成字幕再次翻译，并展示更准确的阶段、模型与进度信息。" },
    { type: "修复", text: "修复字幕缓存与时间轴清理问题，同时让桌面播放器在普通和全屏模式下都为底部操作栏保留独立空间。" },
    { type: "优化", text: "补充字幕解析、上下文翻译及文本清理测试，并同步更新环境变量、产品规范和使用文档。" }
  ],
  "feat: improve mobile media navigation": [
    { type: "新增", text: "优化移动端媒体导航。" },
    { type: "新增", text: "更新前端页面、交互与视觉体验。" },
    { type: "新增", text: "同步更新后端接口、数据处理与服务能力。" }
  ],
  "feat: refine discovery filters and personal journal": [
    { type: "新增", text: "优化探索筛选与个人媒体手记。" },
    { type: "新增", text: "更新前端页面、交互与视觉体验。" },
    { type: "新增", text: "同步更新后端接口、数据处理与服务能力。" },
    { type: "优化", text: "补充自动化验证，降低后续版本回归风险。" }
  ],
  "feat: 优化知识图谱节点探索与响应式体验": [
    { type: "新增", text: "知识图谱节点点击后改为打开图内操作面板，可直接下钻、查看影片、收藏、固定、对比或查看关系证据。" },
    { type: "优化", text: "节点改用自然分布与曲线连线，减少机械对齐，让关系层级和探索焦点更容易辨认。" },
    { type: "修复", text: "修复移动端节点操作面板被后方提示穿透的问题，并提升图谱与通知辅助文字的可读性。" },
    { type: "优化", text: "统一移动端主导航触摸高度，增加专题维度更多入口，并修正智能观影台宽屏内容偏移。" }
  ],
  "feat: 重构知识图谱分层探索并完善观影偏好": [
    { type: "新增", text: "知识图谱重构为专题总览、维度实体和实体关系三层结构，六个专题维度不再混杂展示。" },
    { type: "新增", text: "支持从任意关联节点继续下钻，并保留完整探索路径、关系证据、实体对比和路径查询。" },
    { type: "优化", text: "智能观影台最近偏好支持单条删除，并同步清理对应会话和缓存状态。" },
    { type: "优化", text: "更新日志改为显示本地提交日期及时分秒，提交记录可精确追溯到秒。" }
  ],
  "feat: 完善知识图谱下钻与时间探索": [
    { type: "新增", text: "知识图谱支持按目标维度一跳下钻、局部收起、固定节点和探索历史恢复。" },
    { type: "新增", text: "增加双实体对比、最短关系路径、路径高亮和可分页查看的关联视频证据。" },
    { type: "新增", text: "增加发行年份分布与时间范围筛选，图谱节点、关系和证据随时间区间联动更新。" },
    { type: "优化", text: "完善图谱接口缓存、关系语义、响应式布局及桌面和移动端自动化回归。" }
  ],
  "feat: 增加智能观影台 Arena 与知识图谱": [
    { type: "新增", text: "上线智能观影台，以渐进问答和五轮视频二选一 Arena 收集本次观影偏好。" },
    { type: "新增", text: "增加演员、主题、标签、导演、厂商和厂牌之间的可交互内容知识图谱。" },
    { type: "优化", text: "根据 Arena 胜者的元数据重排每组四部的今日推荐，并持久化偏好、进度和结果。" },
    { type: "优化", text: "完善图谱封面节点、关系强度、共同作品及桌面和移动端响应式体验。" }
  ],
  "feat: 增加智能观影 Arena 推荐流程": [
    { type: "新增", text: "初步偏好问答后增加五轮视频二选一 Arena，并展示封面、番号、演员和标签。" },
    { type: "新增", text: "逐轮持久化固定对战与胜者，历史会话可继续未完成选择或恢复原推荐结果。" },
    { type: "优化", text: "根据胜者的演员、系列和标签等元数据重排今日推荐，并优先展示胜出内容。" },
    { type: "优化", text: "推荐结果改为每组四部，支持上一组、下一组、查看详情和直接播放。" }
  ],
  "feat: 重构智能观影台引导与历史偏好": [
    { type: "新增", text: "将观影偏好收集改为场景、时长、分类和探索方式的渐进式卡片问答。" },
    { type: "新增", text: "保存每次生成时的偏好与结果，支持从最近偏好中恢复任意历史会话。" },
    { type: "优化", text: "推荐结果改为单视频沉浸卡片，支持前后切换、播放、详情和反馈。" },
    { type: "优化", text: "完善桌面与移动端响应式布局，历史轨道可横向浏览且页面无横向溢出。" }
  ],
  "feat: 完善内容知识图谱探索体验": [
    { type: "新增", text: "演员与主题节点支持聚焦封面，并保持手动专题封面优先。" },
    { type: "新增", text: "关系详情展示共同作品数、归一化关联度和按需加载的共同作品预览。" },
    { type: "优化", text: "增加分类、通用标签和最低共同作品筛选，降低高频标签对图谱中心的干扰。" },
    { type: "优化", text: "单击聚焦、双击进入专题，并完善桌面和移动端的关系探索布局。" }
  ],
  "feat: 增加智能观影台与内容知识图谱": [
    { type: "新增", text: "增加可按时长、分类和观看偏好生成并续看的智能观影会话。" },
    { type: "新增", text: "增加演员、主题、标签、导演、厂商和厂牌之间的内容知识图谱。" },
    { type: "优化", text: "观影反馈与会话持久化到本地 SQLite，知识图谱复用元数据索引和缓存。" },
    { type: "优化", text: "桌面与移动端导航、图谱详情联动和响应式布局保持一致。" }
  ],
  "fix: 统一竖版封面显示规则": [
    { type: "修复", text: "竖版封面统一按容器高度完整显示，避免按宽度铺满时裁切上下内容。" },
    { type: "优化", text: "首页、媒体墙、专题、相关推荐、通知中心和片单详情复用同一封面方向判断。" },
    { type: "优化", text: "兼容缓存图片与移动端布局，横版封面继续保持原有铺满效果。" }
  ],
  "feat: 优化本地入库启动与首页数据动效": [
    { type: "修复", text: "将自动入库执行器内嵌到本地后端启动流程，避免定时任务因独立进程未启动而持续排队。" },
    { type: "新增", text: "为首页文件数量、容量、个人统计和分区计数增加数字滚轴动画。" },
    { type: "优化", text: "为月度回顾与趋势图增加错峰生长动效，并兼容系统减少动态效果设置。" },
    { type: "优化", text: "在自动入库设置中展示执行器状态，Docker 与 NAS 环境继续保持禁用。" }
  ],
  "fix: 修复播放兼容与片单收藏流程": [
    { type: "修复", text: "检测真实视频帧并在有声音无画面时自动进入兼容播放回退。" },
    { type: "修复", text: "统一片单为可维护的普通片单，修复创建、选择、加入和详情查看链路。" },
    { type: "优化", text: "整合个人中心收藏入口，并改善深色主题下告警与禁用状态的可读性。" },
    { type: "优化", text: "补充 HEVC 兼容性分类测试并修正已有媒体状态。" }
  ],
  "feat: improve media operations and responsive experience": [
    { type: "新增", text: "增加运行环境识别、系统诊断、数据库维护和元数据质量工具。" },
    { type: "优化", text: "完善自动入库审计、通知中心、窄屏专题详情和高清封面展示。" }
  ],
  "fix: harden scheduled media ingestion": [
    { type: "修复", text: "收紧番号识别与文件移动规则，避免普通视频被定时任务错误归档。" }
  ],
  "fix: run ingestion worker in local development": [
    { type: "修复", text: "将入库任务纳入本地启动流程，确保定时扫描能够持续运行。" }
  ],
  "feat: complete ingestion and playlist workflows": [
    { type: "新增", text: "完善自动入库记录、最近入库明细及片单选择、查看和编辑全流程。" }
  ],
  "feat: automate media ingestion and metadata updates": [
    { type: "新增", text: "支持定时扫描下载目录，自动重命名、归档、重扫、抓取元数据并翻译。" }
  ],
  "docs: add reusable project skills and refresh documentation": [
    { type: "优化", text: "将元数据抓取与翻译经验整理为可复用技能，并同步更新开发规范。" }
  ],
  "feat: improve Android back navigation and add artifacts": [
    { type: "优化", text: "安卓返回手势优先关闭当前页面层级，并更新移动端构建产物。" }
  ],
  "feat: support custom topic covers": [
    { type: "新增", text: "专题维度支持手动挑选关联媒体作为展示封面。" }
  ],
  "feat: merge localized topic aliases": [
    { type: "优化", text: "合并中文名称相同的演员和标签，去除重复专题分类。" }
  ],
  "feat: improve playback and metadata workflows": [
    { type: "优化", text: "完善播放队列、关联推荐排序和元数据处理流程。" }
  ],
  "feat: expand personal dashboard and data portability": [
    { type: "新增", text: "扩展个人中心、收藏内容和本地数据导入导出能力。" }
  ],
  "fix: minimize player gesture hints": [
    { type: "修复", text: "精简播放器手势提示，减少对视频画面的遮挡。" }
  ],
  "fix: stabilize video playback fallback": [
    { type: "修复", text: "完善视频加载失败时的格式兼容与播放回退策略。" }
  ],
  "feat: improve navigation and playback reliability": [
    { type: "优化", text: "修正抽屉导航、上下集切换和视频播放可靠性。" }
  ],
  "feat: refine media browsing and playback experience": [
    { type: "优化", text: "改善媒体浏览、相关推荐和桌面播放器操作体验。" }
  ],
  "feat: add metadata file repair workflows": [
    { type: "新增", text: "支持修改番号与文件名、修正目录并重新抓取对应元数据。" }
  ],
  "feat: refine discovery and interaction feedback": [
    { type: "优化", text: "改善推荐去重、收藏状态反馈和详情页面交互。" }
  ],
  "feat: modularize platform APIs and add home, playlists, and maintenance": [
    { type: "新增", text: "上线智能首页、智能片单和资产维护中心，并拆分平台接口。" }
  ],
  "feat: refine metadata filter navigation": [
    { type: "优化", text: "重新组织元数据筛选顺序、位置和移动端交互。" }
  ],
  "feat: add infinite collections and topic favorites": [
    { type: "新增", text: "专题列表支持无限滚动，并扩展演员、系列和标签等多维收藏。" }
  ],
  "feat: expand media workflows and topic browsing": [
    { type: "新增", text: "增加演员、主题、标签、番号等专题维度及其详情浏览。" }
  ],
  "feat: improve search metadata and reel playback": [
    { type: "优化", text: "增强中文元数据搜索、模糊番号匹配和刷视频自动播放。" }
  ],
  "chore: update metadata translations and media cards": [
    { type: "优化", text: "更新中文标题翻译，并统一卡片番号、演员、标题和标签布局。" }
  ],
  "Improve metadata translation glossary": [
    { type: "优化", text: "扩充翻译词库，修正高频日文表达的中文结果。" }
  ],
  "Improve metadata translation quality": [
    { type: "优化", text: "清理标题末尾模板词并提升中文标题自然度。" }
  ],
  "Improve metadata translation and cover caching": [
    { type: "优化", text: "支持英文标题直接翻译，并预缓存媒体封面。" }
  ],
  "Move card favorite control to metadata row": [
    { type: "优化", text: "将收藏按钮移至卡片信息栏右侧，减少封面遮挡。" }
  ],
  "Improve discovery, health, and poster fallbacks": [
    { type: "优化", text: "增加健康检查，并使用视频第十分钟截图作为缺失封面兜底。" }
  ],
  "Add media detail playback and metadata management": [
    { type: "新增", text: "增加媒体详情、播放记录、高级筛选和元数据管理后台。" }
  ],
  "Add poster caching for media search": [
    { type: "新增", text: "为番号与演员搜索增加封面缓存，提升首屏响应速度。" }
  ],
  "Improve metadata enrichment and parsing": [
    { type: "优化", text: "扩展元数据来源并增强番号识别和字段解析。" }
  ],
  "Add metadata facets and advanced filters": [
    { type: "新增", text: "增加演员、系列、标签、导演、厂商和厂牌高级筛选。" }
  ],
  "feat: add metadata backfill and export": [
    { type: "新增", text: "支持批量抓取元数据并同步维护本地 Excel 导出。" }
  ],
  "enhance media wall settings and docker build": [
    { type: "新增", text: "增加资源路径配置持久化和 Intel NAS Docker 镜像构建。" }
  ],
  "improve media wall browsing": [
    { type: "优化", text: "增加无限滚动、筛选联动、移动端布局和播放器手势。" }
  ],
  "build media wall MVP": [
    { type: "新增", text: "完成本地媒体扫描、搜索、筛选、缩略图和播放基础能力。" }
  ]
}));

function git(args, fallback = "") {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return fallback;
  }
}

function changeType(subject) {
  if (/^(fix|hotfix)(\(.+\))?:/i.test(subject)) return "修复";
  if (/^(docs|chore|refactor|style|test|build)(\(.+\))?:/i.test(subject)) return "优化";
  return "新增";
}

function cleanSubject(subject) {
  const withoutPrefix = subject.replace(/^[a-z]+(?:\(.+\))?:\s*/i, "").trim();
  if (!withoutPrefix) return "更新平台功能";
  return withoutPrefix.charAt(0).toUpperCase() + withoutPrefix.slice(1);
}

function containsChinese(value) {
  return /[\u3400-\u9fff]/.test(value);
}

function localizedTitle(subject, files = []) {
  const override = titleOverrides.get(subject);
  if (override) return override;
  const cleaned = cleanSubject(subject);
  if (containsChinese(cleaned)) return cleaned;
  return cleanSubject(inferStagedSubject(files));
}

function defaultChanges(subject, title) {
  const type = changeType(subject);
  return changeOverrides.get(subject) ?? [{ type, text: `本次提交完成：${title}。` }];
}

function localizedChanges(subject, title, previousChanges) {
  const override = changeOverrides.get(subject);
  if (override) return override;
  if (!Array.isArray(previousChanges) || previousChanges.length === 0) {
    return defaultChanges(subject, title);
  }
  return previousChanges.map((change) => containsChinese(change.text)
    ? change
    : { ...change, text: `${title}。` });
}

function readExisting() {
  if (!existsSync(outputPath)) return [];
  try {
    return JSON.parse(readFileSync(outputPath, "utf8"));
  } catch {
    return [];
  }
}

function getStagedFiles() {
  return git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean)
    .filter((file) => file !== "client/src/changelog-data.json");
}

function parseLineStatsDetails(output) {
  const files = new Set();
  let additions = 0;
  let deletions = 0;
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [added, deleted, ...pathParts] = line.split("\t");
    const file = pathParts.join("\t").trim();
    if (!file || file === "client/src/changelog-data.json") continue;
    files.add(file);
    additions += /^\d+$/.test(added) ? Number(added) : 0;
    deletions += /^\d+$/.test(deleted) ? Number(deleted) : 0;
  }
  return {
    filePaths: [...files],
    stats: {
      files: files.size,
      additions,
      deletions,
      total: additions + deletions
    }
  };
}

function getCommitDetails(hash) {
  return parseLineStatsDetails(git([
    "show",
    "--first-parent",
    "--format=",
    "--numstat",
    "--diff-filter=ACMR",
    hash
  ]));
}

function getStagedLineStats() {
  return parseLineStatsDetails(
    git(["diff", "--cached", "--numstat", "--diff-filter=ACMR"])
  ).stats;
}

function inferStagedSubject(files) {
  if (
    files.includes("client/src/components/KnowledgeGraph.tsx")
    && files.includes("server/src/discoveryRoutes.ts")
  ) {
    return "feat: 完善知识图谱下钻与时间探索";
  }
  if (
    files.includes("client/src/components/PlayerModal.tsx")
    && files.includes("client/src/components/PlaylistDrawer.tsx")
  ) {
    return "fix: 修复播放兼容与片单收藏流程";
  }
  if (files.some((file) => /actor-alias|actorAliases|repair-actor/.test(file))) {
    return "feat: 更新演员别名与翻译归一化";
  }
  const hasClient = files.some((file) => file.startsWith("client/"));
  const hasServer = files.some((file) => file.startsWith("server/"));
  if (hasClient && hasServer) return "feat: 更新产品功能与前后端体验";
  if (hasClient) return "feat: 优化前端页面与交互体验";
  if (hasServer) return "feat: 优化后端服务与数据处理";
  if (files.some((file) => file.startsWith("scripts/"))) return "chore: 完善自动化脚本与任务流程";
  if (files.some((file) => /README|spec\.md|\.agents\/|skills\//i.test(file))) return "docs: 更新项目文档与开发规范";
  return "chore: 更新项目内容";
}

function stagedChanges(subject, files = getStagedFiles()) {
  const override = changeOverrides.get(subject);
  if (override) return override;

  const changes = [];
  const type = changeType(subject);

  if (files.some((file) => file.startsWith("client/"))) {
    changes.push({ type, text: "更新前端页面、交互或视觉体验。" });
  }
  if (files.some((file) => file.startsWith("server/"))) {
    changes.push({ type, text: "更新后端接口、数据处理或服务能力。" });
  }
  if (files.some((file) => file.startsWith("scripts/"))) {
    changes.push({ type: "优化", text: "同步完善自动化脚本与任务流程。" });
  }
  if (files.some((file) => file.startsWith("tests/") || /(?:^|\/).*test\./.test(file))) {
    changes.push({ type: "优化", text: "补充自动化验证，降低后续版本回归风险。" });
  }
  if (files.some((file) => /Dockerfile|docker-compose|\.dockerignore/.test(file))) {
    changes.push({ type: "优化", text: "同步更新 Docker 部署配置。" });
  }
  if (files.some((file) => /README|spec\.md|design\.md|\.agents\//i.test(file))) {
    changes.push({ type: "优化", text: "同步更新项目说明与开发约束。" });
  }

  const title = localizedTitle(subject, files);
  if (changes.length === 0) return defaultChanges(subject, title);
  return [{ type, text: `${title}。` }, ...changes].slice(0, 4);
}

const existing = readExisting();
const existingByCommit = new Map(existing
  .filter((entry) => entry.commit && entry.commit !== "当前版本" && entry.commit !== "待提交")
  .map((entry) => [entry.commit, entry]));
const existingBySubjectDate = new Map(existing.map((entry) => [`${entry.date}\u0000${entry.subject}`, entry]));
const log = git(["log", "--date=format-local:%Y-%m-%d %H:%M:%S", "--pretty=format:%H%x1f%ad%x1f%s", "-60"]);
const entries = log
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [hash, date, subject] = line.split("\u001f");
    const commit = hash.slice(0, 7);
    const details = getCommitDetails(hash);
    const previous = existingByCommit.get(commit) ?? existingBySubjectDate.get(`${date}\u0000${subject}`);
    const title = localizedTitle(subject, details.filePaths);
    return {
      id: hash,
      date,
      commit,
      subject,
      title,
      stats: details.stats,
      changes: localizedChanges(subject, title, previous?.changes)
    };
  });

if (args.has("--staged")) {
  const messageIndex = process.argv.indexOf("--message-file");
  const messagePath = messageIndex >= 0 ? process.argv[messageIndex + 1] : "";
  const messageSubject = messagePath && existsSync(messagePath)
    ? readFileSync(messagePath, "utf8").split("\n").find((line) => line.trim() && !line.startsWith("#"))?.trim()
    : "";
  const stagedFiles = getStagedFiles();
  const subject = messageSubject || inferStagedSubject(stagedFiles);
  if (stagedFiles.length > 0) {
    const now = new Date();
    const date = [
      [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-"),
      [String(now.getHours()).padStart(2, "0"), String(now.getMinutes()).padStart(2, "0"), String(now.getSeconds()).padStart(2, "0")].join(":")
    ].join(" ");
    const duplicateIndex = entries.findIndex((entry) => entry.date === date && entry.subject === subject);
    if (duplicateIndex >= 0) entries.splice(duplicateIndex, 1);
    entries.unshift({
      id: `pending:${date}:${subject}`,
      date,
      commit: "当前版本",
      subject,
      title: localizedTitle(subject, stagedFiles),
      stats: getStagedLineStats(),
      changes: stagedChanges(subject, stagedFiles)
    });
  }
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(entries, null, 2)}\n`);
console.log(`Changelog updated: ${entries.length} commit entries`);
