import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const projectRoot = path.resolve(import.meta.dirname, "..");
const db = new Database(path.join(projectRoot, "data", "media-wall.sqlite"), { readonly: true });
const limitArgument = process.argv.find((argument) => argument.startsWith("--limit="));
const limit = Math.min(10, Math.max(1, Number.parseInt(limitArgument?.split("=")[1] ?? "3", 10) || 3));
const outputRoot = path.join(projectRoot, "data", "derivatives", "translated-subtitles");

function parseVtt(content) {
  return content.replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n{2,}/).flatMap((block) => {
    const lines = block.split("\n").filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) return [];
    return [{ timing: lines[timingIndex], text: lines.slice(timingIndex + 1).join(" ").trim() }];
  });
}

function sampleIndexes(length) {
  if (length <= 0) return [];
  return [...new Set([0, Math.floor(length * 0.2), Math.floor(length * 0.45), Math.floor(length * 0.7), length - 1])];
}

function assess(source, translated) {
  const reasons = [];
  if (!translated.trim()) reasons.push("空字幕");
  if (/^[#*._\-—–…~·•]+$/u.test(translated.trim())) reasons.push("占位符");
  if (/[ぁ-ゟ゠-ヿ]/u.test(translated)) reasons.push("残留日文");
  if (/[ぁ-ゟ゠-ヿ]/u.test(source) && source.replace(/\s/g, "") === translated.replace(/\s/g, "")) reasons.push("疑似未翻译");
  if (/(.{1,12}?)(?:[\s、，,。.!！?？・…]*\1){3,}/u.test(translated)) reasons.push("循环重复");
  if ([...translated].length > Math.max(48, [...source].length * 1.8)) reasons.push("单条过长");
  if (/(?:[”"']?\s*\}\s*,\s*\{|[”"']?\s*[}\]](?:\s*[}\]])*(?:\s*[,，。])?)\s*$/u.test(translated)) reasons.push("模型协议残片");
  const knownAsrMistranslation = (
    (/おしっこ読んで/u.test(source) && /读.*(?:小便|尿)/u.test(translated))
    || (/カメラが大きく/u.test(source) && /相机.*(?:变大|大)/u.test(translated))
    || (/おじこください/u.test(source) && /原谅/u.test(translated))
    || (/自分のはや(?:ですか|ですね)/u.test(source) && /厉害/u.test(translated))
    || (/一緒にゲームとかして/u.test(source) && /关照/u.test(translated))
    || (/兄がいるんですけど/u.test(source) && /宅男|漫画/u.test(translated))
    || (/よろしくお願いします/u.test(source) && /晚安/u.test(translated))
    || (/社長.*抜け.*抜けなさい/u.test(source) && /出去|离开|走吧/u.test(translated))
    || (/汗かいたら.*女性かわいそう/u.test(source) && /喝/u.test(translated))
    || (/スゴイヤバーちゃん/u.test(source) && /酒吧/u.test(translated))
    || (/下フェチ/u.test(source) && /足|恋足/u.test(translated))
    || (/静まで移動/u.test(source) && /搬家/u.test(translated))
    || (/今日に転勤/u.test(source) && /今天|岗位/u.test(translated))
    || (/スケジュール行ってくれ/u.test(source) && /处理|去/u.test(translated))
    || (/いいシャイン/u.test(source) && /酒/u.test(translated))
    || (/ラメ奉仕/u.test(source) && /那些人|他们/u.test(translated))
    || (/たっとりと.*かわいがって/u.test(source) && /我/u.test(translated))
    || (/起きてしまったか/u.test(source) && /发现/u.test(translated))
    || (/いや、いやですよ/u.test(source) && /不是/u.test(translated))
    || (/今度君は僕の舐めさせる/u.test(source) && /下次|味道/u.test(translated))
    || (/\*\*れちゃって\*\*/u.test(source))
    || (/上田社長の会社を潰したくない/u.test(source) && /社长把|搞垮/u.test(translated))
    || (/くるさいな/u.test(source) && /没办法/u.test(translated))
    || (/僕のいろんなところを舐めてくれたら/u.test(source) && /让我舔/u.test(translated))
    || (/クラウド慣れさせ/u.test(source) && /云/u.test(translated))
    || (/君もこのあと僕なのには/u.test(source))
    || (/首から舐めてもらおうか/u.test(source) && /你的脖子|让我尝/u.test(translated))
    || (/おはんしんぜひもなめろ/u.test(source))
    || (/波奉仕/u.test(source))
    || (/首の周りをしたり/u.test(source) && /脖子/u.test(translated))
    || (/カメラのおかげでパッパン/u.test(source) && /摄像机/u.test(translated))
    || (/�/u.test(source) || /�/u.test(translated))
    || (/思い子/u.test(source))
    || (/チンポイン/u.test(source))
    || (/拭い取るつもりで食べる/u.test(source) && /吃/u.test(translated))
    || (/自分のものの奥/u.test(source))
    || (/鍵に引っ掛かす/u.test(source) && /钥匙/u.test(translated))
    || (/このチームいっぱい/u.test(source))
    || (/私のチンプ/u.test(source))
    || (/何もやるだな/u.test(source) && /没什么/u.test(translated))
    || (/すいすわかって/u.test(source))
    || (/舌を出していらっしゃあ/u.test(source))
    || (/なめればなめる分だけ/u.test(source) && /狠/u.test(translated))
    || (/こういうの逃げ/u.test(source) && /逃/u.test(translated))
    || (/卵.*ついてください/u.test(source) && /蛋/u.test(translated))
    || (/けいれい/u.test(source) && /漂亮/u.test(translated))
    || (/しきにつかって/u.test(source))
    || (/貼ってくれたおかげ/u.test(source))
    || (/夫に俺を言っといて/u.test(source))
    || (/若社長君の身体を褒めてた/u.test(source) && /社长呢|夸了.*社长/u.test(translated))
    || (/営業の田中/u.test(source) && /小田/u.test(translated))
    || (/お取り込み中/u.test(source) && /接待/u.test(translated))
    || (/お迎えした方/u.test(source) && /接/u.test(translated))
    || (/改めてお伺いした/u.test(source) && /确认/u.test(translated))
    || (/こんなによだれたらして/u.test(source) && /做什么/u.test(translated))
    || (/契約取りそう/u.test(source) && /苛刻/u.test(translated))
    || (/歯立てるな/u.test(source) && /露/u.test(translated))
    || (/ちべたをなめる/u.test(source) && /舔狗/u.test(translated))
    || (/スズー/u.test(source))
    || (/すずはね.*釣りなんて/u.test(source))
    || (/そばにいてあげられないのか/u.test(source) && /我身边/u.test(translated))
    || (/電気が悪い/u.test(source) && /电压|电/u.test(translated))
    || (/\*\*/u.test(source))
    || (/6階分/u.test(source) && /六层/u.test(translated))
    || (/ロープしてくれる/u.test(source) && /绳/u.test(translated))
    || (/静岡.*コミュニティ/u.test(source))
    || (/社長だから大丈夫/u.test(source) && /^我/u.test(translated))
    || (/プリンサイド/u.test(source))
    || (/気づかしい人/u.test(source))
    || (/取り振り先/u.test(source))
    || (/すじゅ/u.test(source))
    || (/あるはら/u.test(source) && /原田/u.test(translated))
    || (/社長はちゃんと守ってくれる/u.test(source) && /我/u.test(translated))
    || (/一番静か可愛い/u.test(source) && /安静/u.test(translated))
    || (/暮らしのあなただけ/u.test(source))
    || (/相手にも言いなよ/u.test(source) && /对方/u.test(translated))
    || (/田舎をバカに過ごして/u.test(source) && /傻/u.test(translated))
    || (/店とかも結構ない/u.test(source) && /店里/u.test(translated))
    || (/それもう行っちゃう/u.test(source) && /结束/u.test(translated))
    || (/接待して、分けて/u.test(source) && /分开/u.test(translated))
    || (/この子、悪くない/u.test(source) && /孩子/u.test(translated))
    || (/ペルペル/u.test(source))
    || (/ケッツ様/u.test(source) && /先生/u.test(translated))
    || (/なみてくれる/u.test(source) && /看/u.test(translated))
    || (/ペラペラさせて/u.test(source) && /湿/u.test(translated))
    || (/頑張ってきない/u.test(source))
    || (/うまいできない/u.test(source) && /好吃/u.test(translated))
    || (/締まりがいい/u.test(source) && /高潮感/u.test(translated))
    || (/行く行く行く/u.test(source) && /停下/u.test(translated))
    || (/マーク使って/u.test(source) && /标记/u.test(translated))
    || (/きゃまちいい/u.test(source))
    || (/してもらうのを送る/u.test(source))
    || (/何を流してる/u.test(source) && /放/u.test(translated))
    || (/スーちゃん/u.test(source) && /苏/u.test(translated))
    || (/チームキンキン/u.test(source) && /团队/u.test(translated))
    || (/エロに対して/u.test(source) && /鞭/u.test(translated))
    || (/フリーター/u.test(source) && /自由职业/u.test(translated))
    || (/ルカは優に密着/u.test(source))
    || (/タイトルの撮影現場/u.test(source) && /标题/u.test(translated))
  );
  if (knownAsrMistranslation) reasons.push("已知ASR误译");
  return reasons;
}

const rows = db.prepare(`
  SELECT translations.media_id AS mediaId, media_files.normalized_code AS code,
    translations.output_path AS outputPath, translations.provider, translations.model,
    translations.updated_at AS updatedAt
  FROM video_subtitle_translations translations
  JOIN media_files ON media_files.id = translations.media_id
  WHERE translations.status = 'ready' AND translations.source_kind = 'speech'
  ORDER BY translations.updated_at DESC
  LIMIT ?
`).all(limit);

if (rows.length === 0) {
  console.log("当前没有可抽样的已完成语音字幕翻译。");
  process.exit(0);
}

let totalCues = 0;
let issueCues = 0;
console.log(`字幕翻译抽样：${rows.length} 部`);
for (const row of rows) {
  const sourcePath = path.join(outputRoot, `${row.mediaId}.source.vtt`);
  if (!fs.existsSync(sourcePath) || !fs.existsSync(row.outputPath)) {
    console.log(`\n${row.code}：缺少源字幕或中文字幕，无法审计`);
    continue;
  }
  const source = parseVtt(fs.readFileSync(sourcePath, "utf8"));
  const translated = parseVtt(fs.readFileSync(row.outputPath, "utf8"));
  const count = Math.min(source.length, translated.length);
  const findings = [];
  for (let index = 0; index < count; index += 1) {
    const reasons = assess(source[index].text, translated[index].text);
    totalCues += 1;
    if (reasons.length > 0) {
      issueCues += 1;
      findings.push({ index, reasons });
    }
  }
  console.log(`\n${row.code} · ${count}/${source.length} 条 · ${row.provider}`);
  console.log(`质量信号：${findings.length === 0 ? "未发现规则异常" : `${findings.length} 条需复核`}`);
  for (const finding of findings.slice(0, 5)) {
    console.log(`复核[${finding.index + 1}] 日：${source[finding.index].text}`);
    console.log(`         中：${translated[finding.index].text}  ⚠ ${finding.reasons.join("、")}`);
  }
  for (const index of sampleIndexes(count)) {
    const reasons = assess(source[index].text, translated[index].text);
    console.log(`[${index + 1}] 日：${source[index].text}`);
    console.log(`    中：${translated[index].text}${reasons.length ? `  ⚠ ${reasons.join("、")}` : ""}`);
  }
}

console.log(`\n汇总：检查 ${totalCues} 条，规则命中 ${issueCues} 条（${totalCues ? (issueCues / totalCues * 100).toFixed(2) : "0.00"}%）。`);
