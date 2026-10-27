# 配置与使用

[文档导航](README.md) · [功能操作步骤](USER_GUIDE.md) · [最新介绍视频与章节](VIDEO.md)

首次接入已有影库建议从[上手指南](GETTING_STARTED.md)开始。安装、运行与 Docker 命令见主 README。只需要查看效果时优先使用 `pnpm demo:start`，不必接入个人媒体。

## 媒体与目录

复制 `.env.example` 为 `.env`，设置 `MEDIA_SOURCES=LOCAL:Library=/absolute/path/to/media`。多个媒体源以分号分隔，目录使用系统可读的绝对路径；路径不会写入公开源码。先挂载 NAS / SMB / NFS，再把挂载点加入媒体源。

运行后点击首页“接入媒体库”，也可从“更多工具 → 资源路径”打开。检查预览，确认可读性与保留记录数，再保存。目录为空时需要明确确认，扫描不自动删除失联媒体的个人记录。

默认 API / 生产页面端口 4310；开发前端 4311，转发到 API。配置 `AMW_LAN_MODE=true` 允许局域网访问，并保留 `AMW_LAN_AUTH=true`，使用本机启动日志里的配对码。

如果通过可信的 HTTPS 反向代理访问，可设置 `AMW_TRUST_PROXY=true`，并让代理覆盖转发的 Host 与协议头。此时外部播放器链接会使用公开的 HTTPS 地址；直连部署保持默认关闭。

## 界面语言

首页顶部可切换中文、English 和日本語，默认中文，选择保存在当前浏览器。界面语言、资料的中文 / 日文显示与字幕语言独立管理。

## 可选本地馆长

默认不启用模型，不占用模型内存。未连接时显示“固定示例 · 非 AI 回答”，不把占位卡片写入馆藏或对话。

在自己的 `.env` 中配置：

```dotenv
AMW_AGENT_ENABLED=true
AMW_AGENT_OLLAMA_URL=http://127.0.0.1:11435
AMW_AGENT_CHAT_MODEL=qwen3.5:9b
AMW_AGENT_EMBEDDING_MODEL=qwen3-embedding:0.6b
```

Ollama 需要由部署者自行安装、启动并安装所选模型；地址和模型名称必须与本机服务一致。默认馆长数据位于 `DATA_DIR/external-ai`；自定义外部目录时仍使用存储身份校验，避免磁盘断开后写入错误位置。模型就绪后点击“重新检测连接”；真实对话需要手动加载模型并完成馆藏索引。

启用馆长会向配置的 Ollama 服务发送提问及相关馆藏片段。模型服务如果不在本机，数据会离开当前主机，请按自己的用途配置。字幕识别 / 翻译模型与元数据服务另行配置，未配置时不宣称可用。

## 元数据与图片

本地 NFO / JSON 和海报无需联网。`METADATA_SERVER_URL`、`METADATA_FALLBACK_SERVER_URL`、`METADATA_AUTO_ENRICH` 控制用户自行配置的元数据服务；启用外部资料补全时会产生网络查询。公开版本不打包私人站点目录和真实演员图片缓存。

本机运行时，可以选择由 Alexandria 18+ 自动启动自己安装的 MetaTube 兼容服务。在自己的 `.env` 中配置：

```dotenv
METADATA_SERVER_URL=http://127.0.0.1:8080
METADATA_MANAGE_METATUBE=true
METADATA_METATUBE_COMMAND=/absolute/path/to/metatube-server
METADATA_METATUBE_DB=/absolute/path/to/metatube.db
METADATA_AUTO_ENRICH=true
# 需要认证时另行设置 METADATA_TOKEN；备用服务可设置 METADATA_FALLBACK_SERVER_URL。
```

服务程序由用户自行安装，项目不下载程序或附带数据库。只接受明确配置的本机 HTTP 地址和绝对路径；数据库路径可省略，默认为数据目录内的 `metatube.db`。自定义数据库路径时，其父目录需要事先存在且可写，程序不会创建缺失的挂载目录。服务已就绪时直接复用；仅对本程序启动的进程负责停止，启动失败后会重试。关闭自动管理后，仍可连接用户自行运行的本地或远程兼容服务。Demo 不启动外部服务。Docker 部署请自行启动元数据服务，并设置容器能够访问的 `METADATA_SERVER_URL`；容器中的 `127.0.0.1` 指容器自身。

## 独立高光 worker

Docker 默认在主服务进程处理所有媒体任务。如果希望在 Apple Silicon 上使用独立的原生 ARM64 高光 worker：

```sh
pnpm docker:build:worker
docker compose -f compose.yaml -f compose.native-highlights.yaml up -d --build
```

构建脚本根据 Docker 主机架构选择 `linux/arm64` 或 `linux/amd64`，并创建 `alexandria-worker:arm64` 或 `alexandria-worker:amd64`。默认配置使用 ARM64 镜像；其他架构可在本地设置 `HIGHLIGHT_WORKER_IMAGE` 和 `HIGHLIGHT_WORKER_PLATFORM`。两个服务使用相同的数据目录及只读媒体挂载；主服务排除高光任务，独立 worker 只处理高光任务。自定义额外媒体挂载时，两个服务的容器内路径必须一致。停用此模式时使用原来的 `docker compose -f compose.yaml up -d --remove-orphans`，主服务会重新处理高光任务。

## 测试与反馈

`pnpm typecheck`、`pnpm test:unit`、`pnpm build`、`pnpm privacy:check`。测试套件使用独立临时数据库，不能与运行服务指向同一个正式库。提交日志前去掉路径、令牌、配对码和媒体记录。

发布前另运行 `pnpm privacy:history`，检查所有本地分支和标签可达的历史文本、提交身份和提交说明。当前文件已脱敏不代表历史提交已脱敏；历史图片和视频仍需单独检查。个人关键词可放入被忽略的 `.local/privacy-blocklist.json`，格式为字符串数组，不要将此文件提交。检查只报告命中对象，不打印关键词；配置损坏时会直接失败。

运行 `pnpm audit --prod` 检查锁定的生产依赖公告。依赖更新后重新执行测试和 `pnpm licenses:generate`，同步第三方许可证清单；零告警不代表没有未披露漏洞。
