import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { checkTools, initializeLibrary, planSetup } from "./lib/setupLibrary.mjs";

const copy = {
  "zh-CN": {
    title: "Alexandria 18+ · 已有媒体库接入", help: "用法：pnpm setup:library [--source /absolute/path]... [--dry-run | --write] [--lang zh-CN|en|ja]\n默认仅预览。首次安装可用 --write 写入私有配置；已有影库请使用首页的接入媒体库入口。",
    prompt: "媒体目录的绝对路径（留空结束）：", need: "请提供至少一个 --source 绝对路径。", tools: "依赖检查", invalidTools: "请先安装缺失依赖，再运行此脚本。", preview: "只读抽样预览（最多 300 个目录项，并非完整扫描）", counts: "视频 / 字幕 / 本地资料", limited: "样本已达上限", noVideo: "样本未找到视频；请确认目录，正式扫描会递归索引。", dry: "预览结束，未写入任何配置，也未改动媒体。确认后添加 --write；或使用首页接入向导。", saved: "私有配置已创建；原媒体未改动。", next: "下一步：\npnpm build\npnpm start\n打开 http://127.0.0.1:4310（如配置其他 PORT，以实际端口为准）。首次启动会扫描资料；随后检查播放与字幕。", ABSOLUTE_PATH_REQUIRED: "目录必须是服务器上的绝对路径。", DIRECTORY_REQUIRED: "路径必须是目录。", SOURCE_COUNT: "请提供 1–32 个目录。", DUPLICATE_SOURCE: "同一实际目录不能重复添加。", DATA_INSIDE_SOURCE: "媒体目录不能包含平台的数据目录；请仅选择实际影片目录。", EXISTING_LIBRARY: "检测到已有影库、媒体源配置或 Demo 模式，未覆盖。启动服务后使用首页“接入媒体库”，预览、备份后再保存。", failed: "未完成：", unknown: "未知参数或语言；使用 --help 查看用法。"
  },
  en: {
    title: "Alexandria 18+ · Connect an existing collection", help: "Usage: pnpm setup:library [--source /absolute/path]... [--dry-run | --write] [--lang zh-CN|en|ja]\nPreview is the default. --write creates private settings for a fresh installation. For existing libraries, use Connect library on the home page.",
    prompt: "Absolute media folder path (blank to finish): ", need: "Provide at least one absolute --source path.", tools: "Dependency check", invalidTools: "Install the missing dependencies before continuing.", preview: "Read-only sample (up to 300 directory entries; not a full scan)", counts: "videos / subtitles / local metadata", limited: "sample limit reached", noVideo: "No videos found in the sample. Check the folder; the full scan is recursive.", dry: "Preview finished. No settings or media were changed. Add --write to confirm, or use the home-page wizard.", saved: "Private settings created. Source media was not changed.", next: "Next:\npnpm build\npnpm start\nOpen http://127.0.0.1:4310 (use your configured PORT if different). The first startup scans metadata; then check playback and subtitles.", ABSOLUTE_PATH_REQUIRED: "Use an absolute folder path on the server.", DIRECTORY_REQUIRED: "The path must be a directory.", SOURCE_COUNT: "Provide 1–32 folders.", DUPLICATE_SOURCE: "The same real folder cannot be added twice.", DATA_INSIDE_SOURCE: "Media sources must not contain application data. Select only your media folders.", EXISTING_LIBRARY: "An existing library, source configuration, or demo mode was detected. Nothing was overwritten. Start the app and use Connect library to preview, back up, and save changes.", failed: "Not completed: ", unknown: "Unknown option or language; use --help."
  },
  ja: {
    title: "Alexandria 18+ · 既存ライブラリを接続", help: "使い方：pnpm setup:library [--source /absolute/path]... [--dry-run | --write] [--lang zh-CN|en|ja]\n既定はプレビューのみです。新規環境では --write で個人設定を作成します。既存ライブラリはホームの接続画面から変更してください。",
    prompt: "メディアフォルダの絶対パス（空欄で終了）：", need: "絶対パスの --source を1つ以上指定してください。", tools: "依存関係の確認", invalidTools: "不足している依存関係をインストールしてください。", preview: "読み取り専用サンプル（最大300項目・全体スキャンではありません）", counts: "動画 / 字幕 / ローカル資料", limited: "サンプル上限に到達", noVideo: "サンプル内に動画がありません。フォルダを確認してください。本スキャンは再帰的に行います。", dry: "プレビュー完了。設定やメディアは変更していません。確認後に --write を付けるか、ホームの接続画面を使用してください。", saved: "個人設定を作成しました。元メディアは変更していません。", next: "次の手順：\npnpm build\npnpm start\nhttp://127.0.0.1:4310 を開きます（PORT を変更した場合はその値を使用）。初回起動で資料をスキャンした後、再生と字幕を確認してください。", ABSOLUTE_PATH_REQUIRED: "サーバー上の絶対パスを指定してください。", DIRECTORY_REQUIRED: "フォルダを指定してください。", SOURCE_COUNT: "1〜32個のフォルダを指定してください。", DUPLICATE_SOURCE: "同じ実体のフォルダは重複登録できません。", DATA_INSIDE_SOURCE: "アプリのデータを含まない、メディア専用のフォルダを選択してください。", EXISTING_LIBRARY: "既存ライブラリ・ソース設定またはデモモードを検出したため、上書きしていません。アプリを起動し、ホームの接続画面でプレビュー・バックアップ後に保存してください。", failed: "未完了：", unknown: "不明な引数または言語です。--help を確認してください。"
  }
};

const args = process.argv.slice(2), inputs = [];
let lang = "zh-CN", write = false, dry = false, help = false;
try {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--lang" && args[i + 1]) lang = args[++i];
    else if (args[i] === "--source" && args[i + 1] && !args[i + 1].startsWith("--")) inputs.push(args[++i]);
    else if (args[i] === "--write") write = true;
    else if (args[i] === "--dry-run") dry = true;
    else if (args[i] === "--help" || args[i] === "-h") help = true;
    else throw new Error("Unknown argument: " + args[i]);
  }
  if (!Object.hasOwn(copy, lang) || (write && dry)) throw new Error("Invalid options");
  const text = copy[lang];
  if (help) { console.log(text.help); process.exit(0); }
  console.log(text.title + "\n" + text.tools);
  const tools = checkTools();
  for (const tool of tools) console.log(`${tool.ok ? "✓" : "✗"} ${tool.name}`);
  if (tools.some(tool => !tool.ok)) throw new Error(text.invalidTools);
  if (!inputs.length && stdin.isTTY) {
    const terminal = createInterface({ input: stdin, output: stdout });
    try { for (;;) { const value = (await terminal.question(text.prompt)).trim(); if (!value) break; inputs.push(value); } }
    finally { terminal.close(); }
  }
  if (!inputs.length) throw new Error(text.need);
  const plan = await planSetup(process.cwd(), inputs);
  console.log("\n" + text.preview);
  for (const source of plan.sources) {
    console.log(`${source.root}\n  ${text.counts}: ${source.video} / ${source.subtitles} / ${source.metadata}${source.limited ? " · " + text.limited : ""}`);
    if (!source.video) console.log("  " + text.noVideo);
  }
  if (!write) { console.log("\n" + text.dry); process.exit(0); }
  await initializeLibrary(plan);
  console.log("\n" + text.saved + "\n" + text.next);
} catch (error) {
  const text = copy[lang] || copy["zh-CN"];
  console.error(text.failed + (text[error.message] || error.message));
  process.exitCode = 1;
}
