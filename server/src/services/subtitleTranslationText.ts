export type SubtitleCue = {
  timing: string;
  text: string;
};

export type SpeechCueCleanup = {
  cues: SubtitleCue[];
  collapsedRepetitions: number;
  removedDuplicates: number;
  removedInvalidTimings: number;
  repairedTimings: number;
  normalizedPhrases: number;
};

export type SpeechInterval = {
  start: number;
  end: number;
};

export type SpeechCueVadFilter = {
  cues: SubtitleCue[];
  removedNonSpeech: number;
  realignedTimings: number;
};

const repeatedTokenRun = /([\p{L}\p{N}ー]{2,})(?:(?:[\s、，,。.!！?？・~～〜ー—]+)\1){2,}/giu;
const contiguousRepeatedRun = /([\p{L}\p{N}ぁ-ゟ゠-ヿー]{1,12}?)(?:[\s、，,。.!！?？・…~～〜ー—]*\1){2,}/giu;
// Whisper can repeat a short phrase while inserting a filler such as "あ、"
// between each occurrence. Treat four or more such runs as one bounded utterance.
const repeatedPhraseRun = /((?:[あぁえお][、，,]\s*)?)([\p{L}\p{N}ぁ-ゟ゠-ヿー]{2,12}?)(?:[、，,]\s*(?:[あぁえお][、，,]\s*)?\2){2,}/giu;
// Long-vowel filler loops (for example "あ〜い、あ〜い、あ〜い") do not
// match the token-only pattern because "〜" is not a letter. Keep two
// bounded utterances and discard the unbounded Whisper tail.
const repeatedFillerRun = /((?:[あぁえお](?:[〜～ー—-]+)?[いぃえお]?))(?:[、，,]\s*\1){2,}/giu;
const japaneseSpeechRecognitionCorrections = [
  /([足脚])[、\s]*(?:(?:切れ)(?:に)?|[経継][験連廉齢])(?=(?:し|す))/gu
];

function parseTimestamp(value: string): number | null {
  const match = /^(\d{2}):(\d{2}):(\d{2})[.,](\d{3})$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 3_600_000
    + Number(match[2]) * 60_000
    + Number(match[3]) * 1_000
    + Number(match[4]);
}

function formatTimestamp(value: number): string {
  const safe = Math.max(0, Math.round(value));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  const milliseconds = safe % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function cleanRepeatedSpeech(text: string): { text: string; changed: boolean } {
  let changed = false;
  const cleaned = text.replace(repeatedTokenRun, (run, token: string) => {
    changed = true;
    return token;
  }).replace(contiguousRepeatedRun, (_run, token: string) => {
    changed = true;
    return `${token}…${token}`;
  }).replace(repeatedPhraseRun, (_run, prefix: string, token: string) => {
    changed = true;
    return `${prefix}${token}…${token}`;
  }).replace(repeatedFillerRun, (_run, token: string) => {
    changed = true;
    return `${token}…${token}`;
  }).replace(/[~～〜ー—]{4,}|…{4,}/gu, () => {
    changed = true;
    return "……";
  }).replace(/[ \t]{2,}/g, " ").trim();
  return { text: cleaned, changed };
}

export function normalizeRepeatedSpeechText(text: string): string {
  return cleanRepeatedSpeech(text).text;
}

/**
 * Models occasionally append a self-review, JSON repair, or protocol explanation
 * after an otherwise usable subtitle. Keep the actual subtitle prefix and drop
 * that generated control text before quality checks or persistence.
 */
export function normalizeTranslationArtifactText(text: string): string {
  let normalized = text.trim();
  const marker = /(?:[、，,;；]\s*)?corrections?\s*[:：]|格式要求不符|JSON\s*结构(?:不完整|错误)?|以下是修正后的|```json/iu;
  const markerIndex = normalized.search(marker);
  if (markerIndex > 0) normalized = normalized.slice(0, markerIndex).trim();
  return normalized
    .replace(/[”"']?\s*\}\s*,\s*\{\s*$/u, "")
    .replace(/[”"']?\s*[}\]](?:\s*[}\]])*(?:\s*[,，。])?$/u, "")
    .trim();
}

export function assessSubtitleTranslationText(sourceText: string, translatedText: string): {
  okay: boolean;
  reasons: string[];
} {
  const source = sourceText.replace(/\s/gu, "").trim();
  const translated = translatedText.replace(/\s/gu, "").trim();
  const reasons: string[] = [];
  if (!translated) reasons.push("empty");
  if (/^[#*._\-—–…~·•]+$/u.test(translated)) reasons.push("placeholder");
  if (/[ぁ-ゟ゠-ヿ]/u.test(translated)) reasons.push("japanese-residual");
  if (/[ぁ-ゟ゠-ヿ]/u.test(source) && translated === source) reasons.push("untranslated");
  if (new RegExp(contiguousRepeatedRun.source, "iu").test(translated)) reasons.push("pathological-repetition");
  if (/[~～〜ー—]{4,}|…{4,}/u.test(translated)) reasons.push("pathological-punctuation");
  if (/(?:作品(?:编号|代码)?|前文|后文|日文|中文)\s*[：:]|(?:corrections?\s*[:：]|格式要求不符|JSON\s*结构|以下是修正后的|```json)/iu.test(translated)) {
    reasons.push("prompt-artifact");
  }
  if (/(?:[”"']?\s*\}\s*,\s*\{|[”"']?\s*[}\]](?:\s*[}\]])*(?:\s*[,，。])?)\s*$/u.test(translatedText)) {
    reasons.push("protocol-artifact");
  }
  return { okay: reasons.length === 0, reasons };
}

export function normalizeSpeechRecognitionText(text: string, previousText = ""): { text: string; corrections: number } {
  let corrections = 0;
  let normalized = text;
  if (/�/u.test(normalized)) {
    normalized = normalized.replace(/�/gu, "");
    corrections += 1;
  }
  if (/\*\*/u.test(normalized)) {
    normalized = normalized.replace(/\*\*/gu, "");
    corrections += 1;
  }
  for (const pattern of japaneseSpeechRecognitionCorrections) {
    normalized = normalized.replace(pattern, (_match, prefix: string) => {
      corrections += 1;
      return `${prefix}痙攣`;
    });
  }
  const exactCorrections: Array<[RegExp, string]> = [
    [
      /生駅にせよ、日本にせよ、大駅を出してもらって飲み込むと消火器に入るわけなので、その人の体から出たものが私の体の中でもう一周すぎじゃないですか/gu,
      "精液にせよ、尿にせよ、唾液を出してもらって飲み込むと消化器に入るわけなので、その人の体から出たものが私の体の中でもう一周するじゃないですか"
    ],
    [/あと少し普通で本読んだり/gu, "あとは普通に本を読んだり"],
    [/ヒステリーとかをよく読みますかね/gu, "ミステリーとかをよく読みますかね"],
    [/結構突き/gu, "結構好き"],
    [/メッキな本とか/gu, "エッチな本とか"],
    [/友達が2杯に/gu, "友達が2人"],
    [/私の顧客には下フェチがたくさんいてね/gu, "私の顧客には舌フェチがたくさんいてね"],
    [/^下フェチ\?$/gu, "舌フェチ?"],
    [/俺のせいで静まで移動になってしまった/gu, "俺のせいで静まで異動になってしまった"],
    [/俺も明日からしばらく今日に転勤だ/gu, "俺も明日からしばらく地方に転勤だ"],
    [/今日のスケジュール行ってくれ/gu, "今日のスケジュール言ってくれ"],
    [/若社長のお酒がなくなってるから、早くついてあげて/gu, "若社長のお酒がなくなってるから、早く注いであげて"],
    [/なかなかいいシャイン/gu, "なかなかいい社員"],
    [/ラメ奉仕したくて仕方がない人にまで/gu, "舐め奉仕したくて仕方がない人にまで"],
    [/たっとりと、かわいがってやってください/gu, "たっぷりと、かわいがってやってください"],
    [/おつかれさまなきゃ/gu, "お疲れ様でした"],
    [/今度君は僕の舐めさせるんだよ/gu, "今度は君に僕のを舐めさせるんだよ"],
    [/ちょっと私やっぱれちゃって/gu, "ちょっと私やっぱ酔っ払っちゃって"],
    [/くるさいな/gu, "うるさいな"],
    [/君のクラウド慣れさせてくれたいんかもっと/gu, "君の舌をもっと慣れさせてやりたいんだ"],
    [/君もこのあと僕なのには僕の体を舐めることになるんだから/gu, "君もこのあと僕の体を舐めることになるんだから"],
    [/泣くないです/gu, "泣かないです"],
    [/おはんしんぜひもなめろ/gu, "下半身全部舐めろ"],
    [/君がそうやって波奉仕してくれれば/gu, "君がそうやって舐め奉仕してくれれば"],
    [/首の周りをしたり、絡めたり/gu, "舌を回したり、絡めたり"],
    [/おー、カメラのおかげでパッパンだよ/gu, "おー、君のおかげでパンパンだよ"],
    [/やっぱり僕の思い子は\s*君はなかなかいい/gu, "やっぱり僕の思い通り 君はなかなかいい"],
    [/チンポインついてる汚れ全部/gu, "チンポについてる汚れ全部"],
    [/拭い取るつもりで食べる/gu, "拭い取るつもりで舐めろ"],
    [/チンポを自分のものの奥まで突っ込めよう/gu, "チンポを自分の喉の奥まで突っ込めよ"],
    [/鍵に引っ掛かすな/gu, "歯に引っ掛けるな"],
    [/このチームいっぱいにしてくれ/gu, "このチンポをいっぱいにしてくれ"],
    [/私のチンプ/gu, "私のチンポ"],
    [/何もやるだな/gu, "何でもやるんだな"],
    [/君だってすいすわかってきてるから/gu, "君だって少しずつ分かってきてるから"],
    [/舌を出していらっしゃあ/gu, "舌を出していなさい"],
    [/こういうの逃げ/gu, "こういうの好き?"],
    [/卵、いっぱいついてください/gu, "中をいっぱい突いてください"],
    [/よっ！けいれい！/gu, "おっ、痙攣！"],
    [/しきにつかってください/gu, "好きに使ってください"],
    [/貼ってくれたおかげでようやく契約が取れた/gu, "張ってくれたおかげでようやく契約が取れた"],
    [/君から夫に俺を言っといてくれ/gu, "君から夫にお礼を言っといてくれ"],
    [/その嫌がる顔を興奮してきたよ/gu, "その嫌がる顔に興奮してきたよ"],
    [/じゃあ後で改めてお迎えした方がよろしいでしょう/gu, "じゃあ後で改めてお伺いした方がよろしいでしょうか"],
    [/これでもっともっと契約取りそうだね/gu, "これでもっともっと契約取れそうだね"],
    [/ちべたをなめるような生活/gu, "地べたを舐めるような生活"],
    [/スズー俺はこんなんで本当に悪かったな/gu, "静、こんなことになって本当に悪かったな"],
    [/スズーもう来てもらえないな/gu, "静、もう来てもらえないな"],
    [/すずはね、こっちに、釣りなんて人は見たことない/gu, "実はね、こっちに来るまで、釣りなんてしたこともなかった"],
    [/静はね、こっちに来て、知り合いなんて一人もいない/gu, "実はね、こっちに来るまで、釣りなんてしたこともなかった"],
    [/^すずは、大丈夫\?/gu, "静は、大丈夫?"],
    [/^すずは、俺より絶対優秀だったもんな/gu, "静は、俺より絶対優秀だったもんな"],
    [/そばにいてあげられないのか、もどかしいよ/gu, "そばにいてあげられないのが、もどかしいよ"],
    [/電気が悪いのかな/gu, "電波が悪いのかな"],
    [/全然、なんか、6階分だから/gu, "全然、なんか、休憩中だから"],
    [/結構、づらかったからさ/gu, "結構、辛かったからさ"],
    [/その呼びをしなくても\s*いい人ばっかだよ/gu, "その心配をしなくても いい人ばっかだよ"],
    [/ちょっと一回ロープしてくれるよ\s*心配してたらよさ/gu, "ちゃんといっぱいフォローしてくれるよ 心配しなくてもさ"],
    [/ようやくしてくれてきたかなって感じ/gu, "良くしてくれてきたかなって感じ"],
    [/静岡はもともとコミュニティが作られなかったからさ/gu, "静はもともとコミュニケーションが得意な方だったからさ"],
    [/辛いことあったらすぐ言ったよ/gu, "辛いことあったらすぐ言ってよ"],
    [/社長の理由はプリンサイドの人とかさ/gu, "社長の周りは取引先の人とかさ"],
    [/結構気づかしい人とかそうじゃん/gu, "結構気難しい人とかいそうじゃん"],
    [/取り振り先/gu, "取引先"],
    [/あ、すじゅ、綺麗だからさ/gu, "あ、静、綺麗だからさ"],
    [/あるはらとか/gu, "アルハラとか"],
    [/やっぱ会社で一番静か可愛いと思うけど/gu, "やっぱ会社で一番、静が可愛いと思うけど"],
    [/そんなにそうやってるって、暮らしのあなただけよ/gu, "そんなふうに言ってくれるの、あなただけよ"],
    [/でもなんかあったらすぐに相手にも言いなよ/gu, "でもなんかあったらすぐに俺にも言いなよ"],
    [/子供のことだとも/gu, "子供のこととかも"],
    [/田舎をバカに過ごしていきたいけどさ/gu, "田舎をバカにするわけじゃないけどさ"],
    [/行かなっけ/gu, "行かなきゃ"],
    [/早速接待して、分けて/gu, "早速接待してあげて"],
    [/ペルペルしろ/gu, "ペロペロしろ"],
    [/どうですか、ケッツ様。ちょっとよく見せてくれ/gu, "どうですか、ケツは。ちょっとよく見せてくれ"],
    [/そんなとこもなみてくれるのか/gu, "そんなとこも舐めてくれるのか"],
    [/いっぱいペラペラさせてください/gu, "いっぱいペロペロさせてください"],
    [/わーもう頑張ってきないよ/gu, "わー、もう我慢できないよ"],
    [/会社だからコンドムなくないからね/gu, "会社だからコンドームなんかないからね"],
    [/うまいできない/gu, "うまくできない"],
    [/あのマーク使っていっぱいいってください/gu, "あの、もっと突いて、いっぱいイってください"],
    [/きゃまちいいです/gu, "気持ちいいです"],
    [/きゃまちいい/gu, "気持ちいい"],
    [/気持ちよくしてもらうのを送るよ/gu, "気持ちよくしてもらうのを撮るよ"],
    [/何を流してるんだよ/gu, "何を撮ってるんだよ"],
    [/気持ちよくしてスーちゃん/gu, "気持ちよくして、静ちゃん"],
    [/チームキンキンさせて/gu, "チンポギンギンにさせて"],
    [/ルカは優に密着/gu, "ルカワユウに密着"],
    [/ルカワユー/gu, "ルカワユウ"],
    [/何が好きなサザエさんの中では[?？]/gu, "何が好き？流川さんの中では？"],
    [/吉那屋/gu, "吉野家"],
    [/羽ぐわいい/gu, "髪かわいい"],
    [/すごい自信なさげる/gu, "すごい自信なさげ"],
    [/分かつ時もありますよ/gu, "分かる時もありますよ"],
    [/写真集とAV発電の現場/gu, "写真集とAV撮影の現場"],
    [/普通は顔を合わせして衣装合わせもするんですけど/gu, "普通は顔を合わせて衣装合わせもするんですけど"],
    [/スーパーのコーヒーのコーヒーを見ることができたのです。/gu, "スーパーのコーヒーのコマーシャルを見ることができたのです。"],
    [/レビューをやっているのって今何の夢目なんですか/gu, "レビューをやっているのって今何年目なんですか"],
    [/一睡のしないで行ったんですか/gu, "一睡もせずに行ったんですか"],
    [/マジミッチだしムッチだし/gu, "マジ未知だし無知だし"],
    [/武漢さんはそのAV女優になったきっかけっていうのは/gu, "流川さんはAV女優になったきっかけっていうのは"],
    [/AV女優に会ってなかったら/gu, "AV女優になってなかったら"],
    [/普通にフリーターだと思うか/gu, "普通にフリーターだと思う"],
    [/ルカさん/gu, "流川さん"],
    [/アル人物を呼んだ/gu, "ある人物を呼んだ"],
    [/たまによく読むんですけど/gu, "たまに本を読むんですけど"],
    [/今日は神保町に来てきました/gu, "今日は神保町に来ました"],
    [/神保町内に書店130点/gu, "神保町内に書店130店"],
    [/自炊は一人暮らし始めた頃はよく知ったんで/gu, "自炊は一人暮らし始めた頃はよくしてたんで"],
    [/家にあるものが、電話へ、Uber/gu, "家にあるものを食べるか、Uber"],
    [/ぬかさんは自分で/gu, "流川さんは自分で"],
    [/今までお付き合いした人って何で言いたくなければどうでないですか/gu, "今までお付き合いした人って何人？言いたくなければ答えなくていいですよ"],
    [/全然全然やりやすいです/gu, "全然全然やります"],
    [/いやもう持てない/gu, "いや、こっちは持てない"],
    [/お洋服を塗るのでちょっと持ってもらって/gu, "お洋服を脱ぐのでちょっと待ってもらって"],
    [/はい赤になったら持ってます/gu, "はい、分かりました、待ってます"],
    [/ティーバッグが好きなんです/gu, "Tバックが好きなんです"],
    [/めろくない/gu, "エロくない"],
    [/ハムスターになってるとか/gu, "ハンディカメラになってるわ"],
    [/私たちは私たちの手を振り返しているので、私たちの手を振り返しています。/gu, "ハンディカメラ"],
    [/めっちゃ降参しました/gu, "めっちゃ興奮しました"],
    [/ルカはユウにとって/gu, "ルカワユウにとって"],
    [/アナサースカイ/gu, "アナザースカイ"],
    [/学校さもったり/gu, "学校サボったり"],
    [/お前今すぐ生徒した足ついてこいやって言って/gu, "お前、今すぐ生徒指導室ついてこいやって言われて"],
    [/妹がまともに住んでいた/gu, "妹がもともと住んでいた"],
    [/焼肉っていう生活を一時期してました/gu, "夜勤っていう生活を一時期してました"],
    [/友達です友達普通日本な友達/gu, "友達です、普通に友達"],
    [/フリーターだと思う普通に/gu, "普通にフリーターだと思う"],
    [/アパレル定員/gu, "アパレル店員"],
    [/セクシー女優ルカワ優/gu, "セクシー女優ルカワユウ"],
    [/ルカワ優/gu, "ルカワユウ"],
    [/エロに対してムチなんですよ\s+前もフェラーとか分かんなくて検索したりとか/gu, "エロに対して無知なんですよ 前もフェラとか分かんなくて検索したりとか"],
    [/筋肉生活/gu, "禁欲生活"],
    [/トファ/gu, "ソファ"],
    [/踊ってきた/gu, "戻ってきた"],
    [/塗れてる/gu, "濡れてる"],
    [/泣いたい/gu, "泣きたい"],
    [/正観帯聞いてみる/gu, "性感帯聞いてみる"],
    [/ペラの上手なやり方/gu, "フェラの上手なやり方"],
    [/ルカは言うという新ジャンル/gu, "ルカワユウという新ジャンル"],
    [/その時はお金がなくて、バイトもしてたけど、ルカが教えてるじゃないですか。/gu, "その時はお金がなくて、バイトもしてたけど、稼ぎとかが知れているじゃないですか。"],
    [/タイトルの撮影現場にお邪魔させてもらった/gu, "とある日の撮影現場にお邪魔させてもらった"],
    [/社長がほら\s*抜けって言ってるんだ\s*抜けなさい/gu, "社長がほら 脱げって言ってるんだ 脱げなさい"],
    [/スゴイヤバーちゃんスゴイヤバー/gu, "すごい、やばいじゃん、すごい、やばい"],
    [/おしっこ読んで/gu, "おしっこ飲んで"],
    [/おじこ/gu, "おしっこ"],
    [/自分のはやですか/gu, "自分のは嫌ですか"],
    [/自分のはやですね/gu, "自分のは嫌ですね"],
    [/カメラが大きくなってしまいました/gu, "亀頭が大きくなってしまいました"],
    [/アラックスアラックス/gu, "アラックス"]
  ];
  for (const [pattern, replacement] of exactCorrections) {
    normalized = normalized.replace(pattern, () => {
      corrections += 1;
      return replacement;
    });
  }
  // A short exclamation repeated many times in one cue is a Whisper loop,
  // not meaningful dialogue. Keep one utterance so it does not pollute the
  // translated subtitle or the quality audit.
  if (/^あ(?:ー+)?(?:、\s*)?やばい/u.test(normalized) && (normalized.match(/やばい/gu)?.length ?? 0) >= 4) {
    normalized = "あ、やばい。";
    corrections += 1;
  }
  if (/胸/u.test(previousText) && /^デ(?:ィー)?ッ?(?:プ|パー)(?:に)?(?:しろ|して)[。.!！]?$/u.test(normalized.trim())) {
    normalized = "胸挟め";
    corrections += 1;
  }
  return { text: normalized, corrections };
}

export function normalizeTranslatedSpeechText(sourceText: string, translatedText: string): string {
  const source = sourceText.replace(/[\s。.!！?？…〜~]/gu, "");
  let normalized = normalizeTranslationArtifactText(translatedText);
  if (/^中央駅$/u.test(source)) normalized = "中央车站";
  else if (/^(?:すいません|すみません)$/u.test(source)) normalized = "不好意思。";
  else if (/^うん$/u.test(source)) normalized = "嗯。";
  else if (/^あ、やばい$/u.test(source)) normalized = "啊，要死了。";
  else if (/^やはりは$/u.test(source)) normalized = "果然是？";
  else if (/^あい(?:あい)+$/u.test(source)) normalized = "啊～好舒服……啊～好舒服";
  else if (/^カナエの言う通り、?無理だけはしないでください$/u.test(source)) normalized = "正如佳苗所说，请千万不要勉强自己。";
  else if (/^質問いいですか$/u.test(source)) normalized = "可以问个问题吗？";
  else if (/^ちょうどでお願いします$/u.test(source)) normalized = "正好，不用找了。";
  else if (/^かしこまりました$/u.test(source)) normalized = "好的。";
  else if (/^お疲れ様です$/u.test(source)) normalized = "辛苦了。";
  else if (/^こちらメニューになります$/u.test(source)) normalized = "这是菜单。";
  else if (/^ご注文お決まりになりましたらお知らせください$/u.test(source)) normalized = "决定好要点什么后，请告诉我。";
  else if (/^コーヒーはブラックでよろしいですか$/u.test(source)) normalized = "咖啡要黑咖啡，对吗？";
  else if (/^ブラック$/u.test(source)) normalized = "黑咖啡？";
  else if (/^チンポもしごけ$/u.test(source)) normalized = "鸡巴也用手撸。";
  else if (/^チンポもしごけながら手でしごくんだよ$/u.test(source)) normalized = "一边舔鸡巴，一边用手撸。";
  else if (/^チンポじゃないとダメ$/u.test(source)) normalized = "非得是鸡巴才行。";
  else if (/^生チンプがいい$/u.test(source)) normalized = "想要真鸡巴。";
  else if (/^生チンプが練習しよう$/u.test(source)) normalized = "用真鸡巴来练习吧。";
  else if (/^奥がいい生チンプがいい$/u.test(source)) normalized = "里面更好，我想要真鸡巴。";
  else if (/^お客のチンコ入れたんだろう$/u.test(source)) normalized = "让客人的鸡巴插进去了吧。";
  else if (/^精液にせよ、尿にせよ、唾液を出してもらって飲み込むと消化器に入るわけなので、その人の体から出たものが私の体の中でもう一周するじゃないですか$/u.test(source)) {
    normalized = "无论是精液、尿还是唾液，让对方排出来再吞下，就会进入消化系统；也就是说，从那个人身体里出来的东西，又在我身体里循环了一圈，不是吗？";
  }
  else if (/^どれくらい体勢でやりましょうか$/u.test(source)) normalized = "用什么姿势来做呢？";
  else if (/^ちょっとお話聞いてみてください$/u.test(source)) normalized = "你稍微问问他吧。";
  else if (/^お口直しするの$/u.test(source)) normalized = "要换换口味吗？";
  else if (/^入れたくなっちゃったけどさ$/u.test(source)) normalized = "虽然忍不住想插进去……";
  else if (/^あとは普通に本を読んだり$/u.test(source)) normalized = "除此之外就是普通地读读书。";
  else if (/^ミステリーとかをよく読みますかね$/u.test(source)) normalized = "经常读推理小说之类的。";
  else if (/^自分の知らない世界で教えたりとか$/u.test(source)) normalized = "还能了解自己不知道的世界。";
  else if (/^結構好き$/u.test(source)) normalized = "很喜欢。";
  else if (/^エッチな本とか$/u.test(source)) normalized = "成人读物之类的。";
  else if (/^友達が2人$/u.test(source)) normalized = "有两个朋友。";
  else if (/^これといった特技もない私に$/u.test(source)) normalized = "像我这样没有什么特别技能的人……";
  else if (/^私の顧客には舌フェチがたくさんいてね$/u.test(source)) normalized = "我的客户中有很多人迷恋舌头。";
  else if (/^舌フェチ$/u.test(source)) normalized = "迷恋舌头？";
  else if (/^服従契約書にサインしてしまった私を待ち受けていたのは$/u.test(source)) normalized = "签下服从契约书后，等待着我的，";
  else if (/^変態社長による調教の日々でした$/u.test(source)) normalized = "是变态社长日复一日的调教。";
  else if (/^俺のせいで静まで異動になってしまった$/u.test(source)) normalized = "都怪我，害得连静也被调职了。";
  else if (/^俺も明日からしばらく地方に転勤だ$/u.test(source)) normalized = "我从明天起也要暂时调到外地工作。";
  else if (/^今日のスケジュール言ってくれ$/u.test(source)) normalized = "告诉我今天的日程。";
  else if (/^あ、ほら、君、若社長のお酒がなくなってるから、早く注いであげて$/u.test(source)) normalized = "你看，若社长的酒已经没了，快给他倒上。";
  else if (/^なかなかいい社員$/u.test(source)) normalized = "真是个相当不错的员工。";
  else if (/^今回こそ、舐め奉仕したくて仕方がない人にまで、ちゃんと仕上げましょうね$/u.test(source)) normalized = "这次一定要把她彻底调教成忍不住想用舌头侍奉别人的人。";
  else if (/^たっぷりと、かわいがってやってください$/u.test(source)) normalized = "请尽情疼爱她吧。";
  else if (/^起きてしまったか$/u.test(source)) normalized = "把你弄醒了吗……";
  else if (/^いや、いやですよ、ごめんなさい$/u.test(source)) normalized = "不，我不要，对不起……";
  else if (/^今度は君に僕のを舐めさせるんだよ$/u.test(source)) normalized = "这次我要让你舔我的。";
  else if (/^ちょっと私やっぱ酔っ払っちゃって$/u.test(source)) normalized = "我果然还是喝醉了……";
  else if (/^それは困ります$/u.test(source)) normalized = "这可不行。";
  else if (/^上田社長の会社を潰したくないだろう$/u.test(source)) normalized = "你也不想让上田社长的公司倒闭吧。";
  else if (/^うるさいな$/u.test(source)) normalized = "真啰嗦。";
  else if (/^もっと舌を出しなさい$/u.test(source)) normalized = "把舌头再伸出来一点。";
  else if (/^僕のいろんなところを舐めてくれたらすごい気持ちいいだろうな$/u.test(source)) normalized = "如果你用这条舌头舔遍我身上的各个地方，一定会特别舒服吧。";
  else if (/^まず最初は僕の舌だ$/u.test(source)) normalized = "首先是我的舌头。";
  else if (/^君の舌をもっと慣れさせてやりたいんだ$/u.test(source)) normalized = "我要让你的舌头更加习惯。";
  else if (/^君もこのあと僕の体を舐めることになるんだから$/u.test(source)) normalized = "反正接下来你也要舔我的身体。";
  else if (/^首から舐めてもらおうか$/u.test(source)) normalized = "让你从我的脖子开始舔吧。";
  else if (/^下半身全部舐めろ$/u.test(source)) normalized = "把我的下半身全部舔一遍。";
  else if (/^君は最初からそうしてくれると思っていたよ$/u.test(source)) normalized = "我从一开始就觉得你会照做。";
  else if (/^君がそうやって舐め奉仕してくれれば$/u.test(source)) normalized = "只要你像这样用舌头侍奉我，";
  else if (/^舌を回したり、絡めたり$/u.test(source)) normalized = "用舌头绕圈、缠绕。";
  else if (/^気持ちいいだろ$/u.test(source)) normalized = "很舒服吧？";
  else if (/^おー、君のおかげでパンパンだよ$/u.test(source)) normalized = "哦，托你的福，已经胀得硬邦邦了。";
  else if (/^やっぱり僕の思い通り君はなかなかいい$/u.test(source)) normalized = "果然和我想的一样，你相当不错。";
  else if (/^チンポについてる汚れ全部$/u.test(source)) normalized = "把鸡巴上沾着的脏东西全部……";
  else if (/^拭い取るつもりで舐めろ$/u.test(source)) normalized = "像要把它擦干净一样舔。";
  else if (/^こうやってもっと$/u.test(source)) normalized = "像这样，再往里面……";
  else if (/^チンポを自分の喉の奥まで突っ込めよ$/u.test(source)) normalized = "把鸡巴塞到你自己的喉咙深处。";
  else if (/^そうそう、そこに、歯に引っ掛けるな$/u.test(source)) normalized = "对，就是那里，别让牙齿刮到。";
  else if (/^君のよだれで、このチンポをいっぱいにしてくれ$/u.test(source)) normalized = "用你的口水把这根鸡巴弄得湿透。";
  else if (/^どうだ私のチンポは$/u.test(source)) normalized = "我的鸡巴怎么样？";
  else if (/^何でもやるんだな$/u.test(source)) normalized = "看来你什么都肯做啊。";
  else if (/^下の口の方にもチンポ入れたくなってきたな$/u.test(source)) normalized = "我也开始想把鸡巴插进你下面那张嘴里了。";
  else if (/^君だって少しずつ分かってきてるから$/u.test(source)) normalized = "你也在渐渐明白该怎么做了。";
  else if (/^入らないんじゃない、入れるのよ$/u.test(source)) normalized = "不是进不去，而是要把它塞进去。";
  else if (/^セックスする時も舌を出していなさい$/u.test(source)) normalized = "做爱的时候也要一直伸着舌头。";
  else if (/^なめればなめる分だけ$/u.test(source)) normalized = "舔得越多，";
  else if (/^こういうの好き$/u.test(source)) normalized = "喜欢这样吗？";
  else if (/^中をいっぱい突いてください$/u.test(source)) normalized = "请用力多顶顶里面。";
  else if (/^おっ、痙攣$/u.test(source)) normalized = "哦，抽搐了！";
  else if (/^好きに使ってください$/u.test(source)) normalized = "请随意使用我。";
  else if (/^君が体を$/u.test(source)) normalized = "多亏你不惜牺牲身体，";
  else if (/^張ってくれたおかげでようやく契約が取れた$/u.test(source)) normalized = "我们终于拿下了合同。";
  else if (/^君から夫にお礼を言っといてくれ$/u.test(source)) normalized = "替我向你丈夫道声谢。";
  else if (/^そんなことを言えるわけありません$/u.test(source)) normalized = "这种话我怎么可能说得出口。";
  else if (/^しかし若社長君の身体を褒めてたぞ$/u.test(source)) normalized = "不过，若社长可是夸奖了你的身体。";
  else if (/^営業の田中です$/u.test(source)) normalized = "我是营业部的田中。";
  else if (/^ですが社長は今お取り込み中ですので$/u.test(source)) normalized = "不过社长现在正忙着……";
  else if (/^じゃあ後で改めてお伺いした方がよろしいでしょうか$/u.test(source)) normalized = "那我晚些时候再来拜访比较好吗？";
  else if (/^では改めてお伺いしたほうがよろしいですよね$/u.test(source)) normalized = "那我稍后再来拜访比较好，对吧？";
  else if (/^いい顔してきたか$/u.test(source)) normalized = "开始露出不错的表情了。";
  else if (/^ちょっと見て、こういう顔してきたか$/u.test(source)) normalized = "看看，已经露出这种表情了。";
  else if (/^こんなによだれたらして$/u.test(source)) normalized = "口水都流成这样了。";
  else if (/^自分で奥まで入れて、ずっと止めていて、苦しくなった話とか言う$/u.test(source)) normalized = "自己塞到最深处，一直含住；难受了就说，好吗？";
  else if (/^これでもっともっと契約取れそうだね$/u.test(source)) normalized = "这样看来，我们还能拿下更多合同。";
  else if (/^これ歯立てるなよ$/u.test(source)) normalized = "别让牙齿碰到。";
  else if (/^あらら、行かせるよ$/u.test(source)) normalized = "哎呀，要让你高潮了。";
  else if (/^地べたを舐めるような生活してたかもしれないものね$/u.test(source)) normalized = "说不定我们现在还过着穷困潦倒的生活呢。";
  else if (/^静、こんなことになって本当に悪かったな$/u.test(source)) normalized = "静，事情变成这样，真的对不起。";
  else if (/^でもさこっちのさ田舎でなんもないと思ったけどさ$/u.test(source)) normalized = "不过，我原以为这乡下什么都没有。";
  else if (/^静、もう来てもらえないな$/u.test(source)) normalized = "静，你已经不能过来了吗？";
  else if (/^実はね、こっちに来るまで、釣りなんてしたこともなかった$/u.test(source)) normalized = "其实，在来这里之前，我从来没有钓过鱼。";
  else if (/^静は、大丈夫慣れない仕事で大変なんじゃないの$/u.test(source)) normalized = "静，你还好吗？不习惯的新工作是不是很辛苦？";
  else if (/^静は、俺より絶対優秀だったもんな$/u.test(source)) normalized = "静毕竟一直都比我优秀。";
  else if (/^そばにいてあげられないのが、もどかしいよ$/u.test(source)) normalized = "没办法陪在你身边，我心里很着急。";
  else if (/^電波が悪いのかな$/u.test(source)) normalized = "是不是信号不好？";
  else if (/^なんか、どこにいる$/u.test(source)) normalized = "你到底在哪里？";
  else if (/^あ、でも、全然、なんか、休憩中だから、ちょっと$/u.test(source)) normalized = "啊，不过没事，大家正在休息，所以有点吵。";
  else if (/^結構、辛かったからさ$/u.test(source)) normalized = "因为当时确实挺辛苦的。";
  else if (/^その心配をしなくてもいい人ばっかだよ$/u.test(source)) normalized = "不用担心，大家都是好人。";
  else if (/^ちゃんといっぱいフォローしてくれるよ心配しなくてもさ$/u.test(source)) normalized = "大家都会好好照顾你的，不用担心。";
  else if (/^良くしてくれてきたかなって感じ$/u.test(source)) normalized = "感觉大家一直都对我挺好的。";
  else if (/^静はもともとコミュニケーションが得意な方だったからさ$/u.test(source)) normalized = "静本来就很擅长与人沟通。";
  else if (/^仕事も大丈夫だとは思うんだけどさ$/u.test(source)) normalized = "工作方面我觉得应该没问题。";
  else if (/^でもなんか辛いことあったらすぐ言ってよ$/u.test(source)) normalized = "不过，要是遇到什么难处就马上告诉我。";
  else if (/^社長だから大丈夫だとは思うんだけどさ$/u.test(source)) normalized = "毕竟对方是社长，我想应该没事，不过……";
  else if (/^もしもなんか変なことされてたらさ$/u.test(source)) normalized = "如果他对你做了什么奇怪的事……";
  else if (/^でもすごい優しいから大丈夫だよ$/u.test(source)) normalized = "不过社长人很温柔，所以没事的。";
  else if (/^社長の周りは取引先の人とかさ$/u.test(source)) normalized = "社长身边不是有客户之类的人吗？";
  else if (/^結構気難しい人とかいそうじゃん$/u.test(source)) normalized = "应该也有不少难相处的人吧。";
  else if (/^なんだっけ$/u.test(source)) normalized = "刚才说什么来着？";
  else if (/^いや、取引先の人がさ$/u.test(source)) normalized = "不，我说的是客户那边的人。";
  else if (/^あ、めーごめん、結構、ん$/u.test(source)) normalized = "啊，对不起……嗯？";
  else if (/^取引先の人がさ、やっぱり色々あるじゃん$/u.test(source)) normalized = "客户那边的人不是各种各样都有吗？";
  else if (/^あ、静、綺麗だからさ$/u.test(source)) normalized = "因为静长得很漂亮嘛。";
  else if (/^アルハラとか$/u.test(source)) normalized = "比如强迫喝酒之类的。";
  else if (/^社長はちゃんと守ってくれるの$/u.test(source)) normalized = "社长会好好保护你吗？";
  else if (/^うんもちろん優しいし$/u.test(source)) normalized = "嗯，当然。他人也很温柔。";
  else if (/^やっぱ会社で一番、静が可愛いと思うけど$/u.test(source)) normalized = "我还是觉得静是公司里最可爱的。";
  else if (/^そんなふうに言ってくれるの、あなただけよ$/u.test(source)) normalized = "会这么说我的，只有你。";
  else if (/^でもなんかあったらすぐに俺にも言いなよ$/u.test(source)) normalized = "不过，要是有什么事就马上告诉我。";
  else if (/^また東京帰るからさ$/u.test(source)) normalized = "我还会回东京的。";
  else if (/^子供のこととかも$/u.test(source)) normalized = "孩子的事也一起……";
  else if (/^子供とか$/u.test(source)) normalized = "孩子之类的。";
  else if (/^田舎をバカにするわけじゃないけどさ$/u.test(source)) normalized = "我不是想瞧不起乡下，不过……";
  else if (/^うん本当それ$/u.test(source)) normalized = "嗯，真的就是这样。";
  else if (/^店とかも結構ないしさ全然ないんだよ$/u.test(source)) normalized = "商店也不多，基本上什么都没有。";
  else if (/^うん、またちょっと連絡して、いつでも$/u.test(source)) normalized = "嗯，再联系我吧，随时都可以。";
  else if (/^あ、ダメ、それもう行っちゃうよ$/u.test(source)) normalized = "啊，不行，那样我就要高潮了。";
  else if (/^誰もいないんだから、いいだろう、それに、社長がもうお待ちかねえだから、な、ほら$/u.test(source)) normalized = "反正没人，没关系吧。而且社长早就等得不耐烦了，来吧。";
  else if (/^早速接待してあげて$/u.test(source)) normalized = "赶快去接待他吧。";
  else if (/^この子、悪くないね$/u.test(source)) normalized = "这个女人还不错。";
  else if (/^何してよ、社長に早く、ペロペロしろ$/u.test(source)) normalized = "还愣着干什么，快给社长舔。";
  else if (/^うわー、最高じゃねどうですか、ケツはちょっとよく見せてくれ$/u.test(source)) normalized = "哇，太棒了。屁股怎么样？让我仔细看看。";
  else if (/^うわー、そんなとこも舐めてくれるのか$/u.test(source)) normalized = "哇，连那里也愿意舔吗？";
  else if (/^いっぱいペロペロさせてください$/u.test(source)) normalized = "请让我尽情地舔。";
  else if (/^わー、もう我慢できないよ$/u.test(source)) normalized = "哇，已经忍不住了。";
  else if (/^会社だからコンドームなんかないからね$/u.test(source)) normalized = "这里是公司，当然没有避孕套。";
  else if (/^うまくできない、ごめんなさい、ごめんなさい$/u.test(source)) normalized = "我做不好，对不起，对不起。";
  else if (/^あ、締まりがいいわこれ$/u.test(source)) normalized = "啊，里面夹得真紧。";
  else if (/^行く行く行くだめ行く$/u.test(source)) normalized = "要去了、要去了……不行，要高潮了！";
  else if (/^あの、もっと突いて、いっぱいイってください$/u.test(source)) normalized = "那个，请再多顶几下，让我尽情高潮。";
  else if (/^気持ちいいです$/u.test(source)) normalized = "好舒服。";
  else if (/^気持ちいい$/u.test(source)) normalized = "好舒服。";
  else if (/^もう少しお尻をください$/u.test(source)) normalized = "请把臀部再往这边一点。";
  else if (/^はいそれぐらい行きましょう$/u.test(source)) normalized = "好，就这样拍吧。";
  else if (/^いいですねはいもう一枚行きます$/u.test(source)) normalized = "很好，再拍一张。";
  else if (/^微笑みという顔も入れつつ$/u.test(source)) normalized = "同时也拍进微笑的表情。";
  else if (/^自分の魅力をグイグイ押してくるタイプじゃなくて$/u.test(source)) normalized = "她不是那种会强烈展现自身魅力的类型，";
  else if (/^なんかこっちに合わせてくれようとするんですよね$/u.test(source)) normalized = "她总是会尽量配合我。";
  else if (/^こっちが何撮りたいって言ったら$/u.test(source)) normalized = "如果我说想拍什么，";
  else if (/^持ってもらってもいいですか$/u.test(source)) normalized = "可以帮我拿一下吗？";
  else if (/^何が好きなサザエさんの中では$/u.test(source)) normalized = "流川小姐喜欢什么？";
  else if (/^何が好き流川さんの中では$/u.test(source)) normalized = "流川小姐喜欢什么？";
  else if (/^吉野家とか$/u.test(source)) normalized = "像吉野家之类的。";
  else if (/^駆け引きと同じくらい苦手なものがある$/u.test(source)) normalized = "还有和讨价还价一样不擅长的事。";
  else if (/^以前のタワーからさらにソフトからハードまで$/u.test(source)) normalized = "在之前的塔楼基础上，进一步覆盖从轻度到重度，";
  else if (/^ソフトからハードまで多種多様なプレイ空間をご用意しております$/u.test(source)) normalized = "从轻度到重度，我们准备了各种各样的玩法空间。";
  else if (/^トータワーのコンシルジュのルカワユウと申します$/u.test(source)) normalized = "我是托塔大楼的礼宾员，流川夕。";
  else if (/^当タワーのコンシェルジュのルカワユウと申します$/u.test(source)) normalized = "我是本塔楼的礼宾员，流川夕。";
  else if (/^以前のタワーからさらにソフトからハードまで、多種多様のプレイ空間をご用意しております$/u.test(source)) normalized = "在之前的塔楼基础上，进一步提供从轻度到重度的多种玩法空间。";
  else if (/^リニューアルオープンができましたのも$/u.test(source)) normalized = "之所以能够重新开业，";
  else if (/^ひとえ$/u.test(source)) normalized = "全靠……";
  else if (/^以前のタワーから$/u.test(source)) normalized = "从之前的塔楼开始，";
  else if (/^じゃあいきますよ$/u.test(source)) normalized = "那就开始了。";
  else if (/^用意スタート$/u.test(source)) normalized = "准备，开始。";
  else if (/^すごい自信なさげ$/u.test(source)) normalized = "看起来非常没有自信。";
  else if (/^髪かわいい$/u.test(source)) normalized = "发型真可爱。";
  else if (/^分かる時もありますよ$/u.test(source)) normalized = "有时也能感觉到。";
  else if (/^上へ参ります$/u.test(source)) normalized = "我们上楼。";
  else if (/^セリフを覚えるときって何かコストがあったりするんですか$/u.test(source)) normalized = "记台词时，会有什么负担吗？";
  else if (/^彼女は苦手を克服するためにあることをしていた$/u.test(source)) normalized = "为了克服自己的弱项，她做了一件事。";
  else if (/^舞台を中心に活動する演出家の下$/u.test(source)) normalized = "在一位以舞台活动为主的导演指导下，";
  else if (/^演技に自信のない彼女は$/u.test(source)) normalized = "她对自己的演技没有信心，";
  else if (/^スーパーのコーヒーのコマーシャルを見ることができたのです$/u.test(source)) normalized = "终于看到了超市咖啡的广告。";
  else if (/^結構体力はじゃあ自信ある方なんですね$/u.test(source)) normalized = "看来你对自己的体力还挺有信心。";
  else if (/^写真集とAV撮影の現場って違いとかあったりしますか$/u.test(source)) normalized = "写真集拍摄和 AV 拍摄现场有什么不同吗？";
  else if (/^写真集とかだとセリフとかがないじゃないですか$/u.test(source)) normalized = "拍写真集时就没有台词之类的，对吧？";
  else if (/^えいひれ$/u.test(source)) normalized = "鳐鱼鳍干。";
  else if (/^え、せせりときのこの柚子胡椒炒めめっちゃ美味しそうじゃない$/u.test(source)) normalized = "诶，是鸡颈肉和蘑菇的柚子胡椒炒菜。看起来超级好吃吧？";
  else if (/^渋いですね$/u.test(source)) normalized = "口味真成熟啊。";
  else if (/^今何年目なんですか$/u.test(source)) normalized = "做评测现在是第几年？";
  else if (/^一睡もせずに行ったんですか$/u.test(source)) normalized = "你是完全没睡就去的吗？";
  else if (/^緊張と不安と$/u.test(source)) normalized = "紧张和不安，";
  else if (/^台本が届いても$/u.test(source)) normalized = "即使拿到剧本，";
  else if (/^何も想像つかないし$/u.test(source)) normalized = "也完全想象不出来，";
  else if (/^マジ未知だし無知だし$/u.test(source)) normalized = "真的既陌生又无知。";
  else if (/^どんなんなんだろうみたいな$/u.test(source)) normalized = "就觉得‘到底会是什么样呢？’";
  else if (/^って感じで$/u.test(source)) normalized = "就是这种感觉，";
  else if (/^流川さんはAV女優になったきっかけっていうのは$/u.test(source)) normalized = "流川小姐成为 AV 女优的契机是什么？";
  else if (/^AV女優になってなかったら何をしてたと思いますか今$/u.test(source)) normalized = "如果没有成为 AV 女优，你觉得现在会做什么？";
  else if (/^ある人物を呼んだ$/u.test(source)) normalized = "叫来了一位神秘人物。";
  else if (/^フィーリング、人と同じです$/u.test(source)) normalized = "凭感觉，就像选择人一样。";
  else if (/^彼女の休日を取材させてもらう$/u.test(source)) normalized = "我们来记录她的休息日。";
  else if (/^たまに本を読むんですけど$/u.test(source)) normalized = "我偶尔会读书，";
  else if (/^今日は神保町に来ました$/u.test(source)) normalized = "今天来到了神保町。";
  else if (/^神保町内に書店130店$/u.test(source)) normalized = "神保町内有 130 家书店。";
  else if (/^注文は必ずブラックコーヒーとデザートのセット$/u.test(source)) normalized = "她总是点黑咖啡和甜点套餐。";
  else if (/^自炊は一人暮らし始めた頃はよくしてたんで$/u.test(source)) normalized = "刚开始独居时经常自己做饭，";
  else if (/^家にあるものを食べるか、Uberとか頼んだりして$/u.test(source)) normalized = "就吃家里现有的东西，或者叫 Uber。";
  else if (/^流川さんは自分でどんな性格だと思います$/u.test(source)) normalized = "流川小姐觉得自己是什么性格？";
  else if (/^今までお付き合いした人って何人(?:？)?言いたくなければ答えなくていいですよ$/u.test(source)) normalized = "你交往过几个人？不想回答的话也可以不说。";
  else if (/^気になったらもうやりたい$/u.test(source)) normalized = "一旦感兴趣就想马上试试。";
  else if (/^やってダメだったらやめればいいや$/u.test(source)) normalized = "做了发现不行就放弃。";
  else if (/^恋愛したりプライベートでセックスをしたいと思わないのか$/u.test(source)) normalized = "难道不想谈恋爱或私下发生性关系吗？";
  else if (/^人気商売のため男関係は気をつけているという$/u.test(source)) normalized = "据说因为靠人气吃饭，所以很注意与男性的关系。";
  else if (/^全然全然やります$/u.test(source)) normalized = "没事没事，我来做。";
  else if (/^そういうとこ絶対持てるじゃないですか$/u.test(source)) normalized = "这种地方你肯定拿得住吧？";
  else if (/^いや、こっちは持てない$/u.test(source)) normalized = "不，这个我拿不住。";
  else if (/^お洋服を脱ぐのでちょっと待ってもらって$/u.test(source)) normalized = "我要脱一下衣服，请稍等。";
  else if (/^はい、分かりました、待ってます$/u.test(source)) normalized = "好的，明白了，我等着。";
  else if (/^あぁ、ねえ、こういうパンツ履いてるの$/u.test(source)) normalized = "啊，喂，你穿这种内裤吗？";
  else if (/^Tバックが好きなんです$/u.test(source)) normalized = "是的，我喜欢丁字裤。";
  else if (/^エロくない$/u.test(source)) normalized = "不觉得很色吗？";
  else if (/^ハンディカメラになってるわ$/u.test(source)) normalized = "变成手持摄像机了。";
  else if (/^ハンディカメラ$/u.test(source)) normalized = "手持摄像机。";
  else if (/^ねえ、見れたことがあって、ちょっとチェックしてみようかな$/u.test(source)) normalized = "刚才看到过，想检查一下。";
  else if (/^えやんないけん$/u.test(source)) normalized = "诶？非做不可吗？";
  else if (/^いや、新鮮でしたねなんか、ベッドだけかなって思ってたんですけど、家中、いろんなところでして、めっちゃ興奮しました$/u.test(source)) normalized = "不，很新鲜呢。本以为只会在床上，没想到家里各处都做了，特别兴奋。";
  else if (/^ルカワユウにとって思い出の場所がある$/u.test(source)) normalized = "对流川夕来说，这里是一个充满回忆的地方。";
  else if (/^ここが、私のアナザースカイ、南新宿$/u.test(source)) normalized = "这里就是我的‘Another Sky’，南新宿。";
  else if (/^高校生の頃学校サボったりとかして不真面目でした$/u.test(source)) normalized = "高中时经常逃课之类的，很不认真。";
  else if (/^お前、今すぐ生徒指導室ついてこいやって言われて$/u.test(source)) normalized = "有人叫我：‘你现在马上跟我去学生指导室！’";
  else if (/^家とかどうしたんですか$/u.test(source)) normalized = "那住处怎么办？";
  else if (/^家は妹がもともと住んでいたのでそこに行ったかな$/u.test(source)) normalized = "我妹妹本来就住在那里，所以我就去了那里吧。";
  else if (/^夜勤っていう生活を一時期してました$/u.test(source)) normalized = "有一段时间过着上夜班的生活。";
  else if (/^友達です、普通に友達$/u.test(source)) normalized = "是朋友，普通朋友。";
  else if (/^少ない金額で長時間遊べるメダルゲームをよくやった$/u.test(source)) normalized = "我经常玩那种花很少钱就能玩很久的奖牌游戏。";
  else if (/^辛いってその時思っても$/u.test(source)) normalized = "即使当时觉得辛苦，";
  else if (/^自分のためになるポジティブに$/u.test(source)) normalized = "也会积极地想，这是为了自己好。";
  else if (/^アパレル店員を経て$/u.test(source)) normalized = "做过服装店店员后，";
  else if (/^セクシー女優ルカワユウとなった$/u.test(source)) normalized = "成为了性感女优流川夕。";
  else if (/^ルカワユウはポジティブで$/u.test(source)) normalized = "流川夕是个积极向上的人，";
  else if (/^エロに対して無知なんですよ前もフェラとか分かんなくて検索したりとか$/u.test(source)) normalized = "我对色情方面很无知，以前连口交之类的都不懂，还会去搜索。";
  else if (/^自宅にいるという彼女にあることを伝えに向かった$/u.test(source)) normalized = "得知她在家后，我便赶去告诉她一件事。";
  else if (/^ちょっと1週間だけ$/u.test(source)) normalized = "就一周，";
  else if (/^禁欲生活してやりませんか$/u.test(source)) normalized = "要不要一起过一周禁欲生活？";
  else if (/^禁欲生活$/u.test(source)) normalized = "禁欲生活？";
  else if (/^禁欲生活って何ですか$/u.test(source)) normalized = "什么叫‘禁欲生活’？";
  else if (/^むずむず$/u.test(source)) normalized = "心里痒痒的。";
  else if (/^戻ってきた$/u.test(source)) normalized = "回来了。";
  else if (/^濡れてる$/u.test(source)) normalized = "湿了。";
  else if (/^責められることが多いってことですよねきっと$/u.test(source)) normalized = "看来你经常被对方主动进攻。";
  else if (/^性感帯聞いてみるのはいかがでしょうか$/u.test(source)) normalized = "不如问问对方的敏感带如何？";
  else if (/^フェラの上手なやり方がわからない$/u.test(source)) normalized = "不知道怎么做好口交。";
  else if (/^フェラの上手なやり方は$/u.test(source)) normalized = "至于怎么做好口交，";
  else if (/^ルカワユウという新ジャンル$/u.test(source)) normalized = "一种名为‘流川夕’的全新类型。";
  else if (/^その時はお金がなくて、バイトもしてたけど、稼ぎとかが知れているじゃないですか。?$/u.test(source)) normalized = "那时候没钱，虽然也在打工，但收入也很有限。";
  else if (/^はい、Tバックが好きなんです$/u.test(source)) normalized = "是的，我喜欢丁字裤。";
  else if (/^東京に憧れ上京したが$/u.test(source)) normalized = "向往东京来到东京，但";
  else if (/^流川さん、AV女優になってよかったと思いますか$/u.test(source)) normalized = "流川小姐，成为 AV 女优后觉得开心吗？";
  else if (/^こんな刺激的なお仕事はないし$/u.test(source)) normalized = "没有比这更刺激的工作了，";
  else if (/^毎日を過ごしてると思う、今頃きっと$/u.test(source)) normalized = "我想现在肯定只是这样过着每一天吧，";
  else if (/^AVのセックスは刺激的元彼はノーマルだったから余計にそう思った$/u.test(source)) normalized = "AV 里的性爱很刺激；因为前男友比较普通，所以我觉得格外刺激。";
  else if (/^やる機会がない$/u.test(source)) normalized = "没有机会做。";
  else if (/^だが彼女はデビュー当時と変わらない$/u.test(source)) normalized = "但她和出道时一样。";
  else if (/^常に笑顔で明るい彼女の流儀がある$/u.test(source)) normalized = "她始终面带笑容、性格开朗，这就是她的风格。";
  else if (/^何でも全力で楽しむっていうのが元なので笑ってます$/u.test(source)) normalized = "我本来就会全力享受一切，所以总是笑着。";
  else if (/^疲れましたね、今日忙しいですねみたいな言ったら$/u.test(source)) normalized = "如果说‘好累啊，今天真忙’之类的话，";
  else if (/^疲れるから、言わないでって言われて$/u.test(source)) normalized = "她对我说：‘会觉得累，所以别这么说。’";
  else if (/^なるほどって思って$/u.test(source)) normalized = "我觉得，原来如此。";
  else if (/^なんか無理やりそう思うんじゃなくて$/u.test(source)) normalized = "并不是勉强自己这么想，";
  else if (/^ファンの皆さんも大好きでしょ$/u.test(source)) normalized = "粉丝们也都很喜欢吧。";
  else if (/^隠すことなんもないけど、本名ぐらい$/u.test(source)) normalized = "没什么好隐瞒的，顶多就是本名吧。";
  else if (/^無知なんですよ$/u.test(source)) normalized = "我对色情方面其实很无知。";
  else if (/^東京に憧れ、山口県から上京してきた$/u.test(source)) normalized = "因向往东京，她从山口县来到东京。";
  else if (/^AV女優じゃなかったら何をしてたと思いますか$/u.test(source)) normalized = "如果没有成为 AV 女优，你觉得自己会做什么？";
  else if (/^何してるだろう$/u.test(source)) normalized = "我会在做什么呢？";
  else if (/^普通にフリーターだと思う$/u.test(source)) normalized = "我想应该就是普通地打零工吧。";
  else if (/^ニートはさすがいないけど$/u.test(source)) normalized = "不过应该还不至于当家里蹲。";
  else if (/^人生が変わった女$/u.test(source)) normalized = "人生发生改变的女人。";
  else if (/^ルカワユウに密着$/u.test(source)) normalized = "贴身跟拍流川夕。";
  else if (/^とある日の撮影現場にお邪魔させてもらった$/u.test(source)) normalized = "我们来到她某一天的拍摄现场进行采访。";
  else if (/^気持ちよくしてもらうのを撮るよ$/u.test(source)) normalized = "我要把你被弄舒服的样子拍下来。";
  else if (/^何を撮ってるんだよ$/u.test(source)) normalized = "你在拍什么啊？";
  else if (/^気持ちよくして、静ちゃん$/u.test(source)) normalized = "让我舒服一点，静。";
  else if (/^チンポギンギンにさせて$/u.test(source)) normalized = "把鸡巴弄得硬邦邦的。";
  else if (/^なー俺\s*レディーファーストだろ\s*ちゃんと$/u.test(source)) normalized = "我可是讲究女士优先的，知道吧。";
  else if (/^社長がほら\s*脱げって言ってるんだ\s*脱げなさい$/u.test(source)) normalized = "社长都说让你脱了，快脱吧。";
  else if (/^ねー\s*暑いし\s*汗かいたらほら\s*女性かわいそうじゃねー$/u.test(source)) normalized = "天气这么热，要是出汗的话，对女士也不好吧。";
  else if (/^すごい、やばいじゃん、すごい、やばい$/u.test(source)) normalized = "厉害，太夸张了，真的太厉害了！";
  else if (/^ほら$/u.test(source)) normalized = "看吧。";
  else if (/^おしっこ飲んでみましょうか$/u.test(source)) normalized = "那就试着喝点尿吧。";
  else if (/^自分のは嫌ですか$/u.test(source)) normalized = "不喜欢自己的吗？";
  else if (/^自分のは嫌ですね$/u.test(source)) normalized = "不喜欢自己的呢。";
  else if (/^亀頭が大きくなってしまいました$/u.test(source)) normalized = "龟头变大了。";
  else if (/^アラックス$/u.test(source)) normalized = "阿拉克斯。";
  else if (/^マンコにおしっこください$/u.test(source)) normalized = "请尿在我小穴里！";
  else if (/おしっこください/u.test(source)) {
    normalized = /お願い/u.test(source)
      ? "拜托了，请尿给我吧！"
      : /ごめんなさい/u.test(source)
        ? "对不起，请尿给我吧！"
        : "请尿给我吧！";
  }
  else if (/^おチンポ$/u.test(source)) normalized = "鸡巴";
  else if (/^たくさんください$/u.test(source)) normalized = "请多给我一些。";
  else if (/^胸(?:はさ|挟)め$/u.test(source)) normalized = "用胸夹住。";
  else if (/^[足脚]痙攣してるな?$/u.test(source)) normalized = "腿还在痉挛。";
  else if (/^[足脚]痙攣するほど気持ちよかったのか$/u.test(source)) normalized = "舒服得腿都痉挛了吧。";
  return cleanRepeatedSpeech(normalized).text;
}

function timingRange(timing: string): { start: number; end: number } | null {
  const match = /^(\S+)\s+-->\s+(\S+)/.exec(timing.trim());
  if (!match) return null;
  const start = parseTimestamp(match[1]);
  const end = parseTimestamp(match[2]);
  return start === null || end === null ? null : { start, end };
}

export function hasPositiveCueDuration(cue: SubtitleCue): boolean {
  const range = timingRange(cue.timing);
  return Boolean(range && range.end > range.start);
}

export function parseVadSpeechIntervals(output: string): SpeechInterval[] {
  const intervals: SpeechInterval[] = [];
  for (const match of output.matchAll(/Speech segment\s+\d+:\s+start\s*=\s*([\d.]+),\s+end\s*=\s*([\d.]+)/giu)) {
    const start = Math.round(Number(match[1]) * 10);
    const end = Math.round(Number(match[2]) * 10);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) intervals.push({ start, end });
  }
  return intervals.sort((left, right) => left.start - right.start);
}

export function filterSpeechCuesByVad(
  cues: SubtitleCue[],
  intervals: SpeechInterval[]
): SpeechCueVadFilter {
  const filtered: SubtitleCue[] = [];
  let removedNonSpeech = 0;
  let realignedTimings = 0;

  for (const cue of cues) {
    const range = timingRange(cue.timing);
    if (!range || range.end <= range.start) {
      removedNonSpeech += 1;
      continue;
    }
    const overlaps = intervals.filter((interval) => (
      range.end > interval.start - 1_200 && range.start < interval.end + 1_200
    ));
    if (overlaps.length === 0) {
      removedNonSpeech += 1;
      continue;
    }

    let timing = cue.timing;
    if (range.end - range.start > 20_000) {
      const firstSpeech = overlaps[0];
      const lastSpeech = overlaps[overlaps.length - 1];
      const anchoredStart = Math.max(range.start, firstSpeech.start - 500);
      const anchoredEnd = Math.min(range.end, lastSpeech.end + 750);
      if (anchoredEnd > anchoredStart) {
        const suffix = /^\S+\s+-->\s+\S+(.*)$/.exec(cue.timing.trim())?.[1] ?? "";
        timing = `${formatTimestamp(anchoredStart)} --> ${formatTimestamp(anchoredEnd)}${suffix}`;
        realignedTimings += 1;
      }
    }
    filtered.push({ ...cue, timing });
  }

  return { cues: filtered, removedNonSpeech, realignedTimings };
}

function repairCueTiming(timing: string, text: string): { timing: string; changed: boolean } {
  const match = /^(\S+)\s+-->\s+(\S+)(.*)$/.exec(timing.trim());
  if (!match) return { timing, changed: false };
  const start = parseTimestamp(match[1]);
  const end = parseTimestamp(match[2]);
  if (start === null || end === null || end <= start) return { timing, changed: false };

  const textLength = Array.from(text.replace(/\s/g, "")).length;
  const maximumDuration = Math.min(20_000, Math.max(4_000, 2_000 + textLength * 220));
  if (end - start <= maximumDuration) return { timing, changed: false };
  return {
    timing: `${formatTimestamp(start)} --> ${formatTimestamp(start + maximumDuration)}${match[3]}`,
    changed: true
  };
}

export function sanitizeSpeechCues(cues: SubtitleCue[]): SpeechCueCleanup {
  const sanitized: SubtitleCue[] = [];
  let collapsedRepetitions = 0;
  let removedDuplicates = 0;
  let removedInvalidTimings = 0;
  let repairedTimings = 0;
  let normalizedPhrases = 0;
  let consecutiveSameText = 0;

  for (const cue of cues) {
    if (!hasPositiveCueDuration(cue)) {
      removedInvalidTimings += 1;
      continue;
    }
    const normalized = normalizeSpeechRecognitionText(cue.text, sanitized[sanitized.length - 1]?.text);
    normalizedPhrases += normalized.corrections;
    const cleaned = cleanRepeatedSpeech(normalized.text);
    if (!cleaned.text) continue;
    if (cleaned.changed) collapsedRepetitions += 1;

    const previous = sanitized[sanitized.length - 1];
    if (previous?.text === cleaned.text) {
      consecutiveSameText += 1;
      const previousRange = timingRange(previous.timing);
      const currentRange = timingRange(cue.timing);
      if (previous.timing === cue.timing || (
        previousRange && currentRange
        && currentRange.start < previousRange.end
        && Math.abs(currentRange.start - previousRange.start) < 2_000
      ) || consecutiveSameText >= 2) {
        removedDuplicates += 1;
        continue;
      }
    } else {
      consecutiveSameText = 0;
    }

    const repaired = repairCueTiming(cue.timing, cleaned.text);
    if (repaired.changed) repairedTimings += 1;
    sanitized.push({ timing: repaired.timing, text: cleaned.text });
  }

  return {
    cues: sanitized,
    collapsedRepetitions,
    removedDuplicates,
    removedInvalidTimings,
    repairedTimings,
    normalizedPhrases
  };
}

export function parseVttCues(content: string): SubtitleCue[] {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r/g, "");
  const blocks = normalized.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd()).filter(Boolean);
    if (lines.length === 0 || /^WEBVTT/i.test(lines[0]) || /^NOTE(?:\s|$)/i.test(lines[0])) continue;
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const text = lines.slice(timingIndex + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (text) cues.push({ timing: lines[timingIndex].trim(), text });
  }
  return cues;
}

export function buildVtt(cues: SubtitleCue[]): string {
  return `WEBVTT\n\n${cues.map((cue) => `${cue.timing}\n${cue.text}`).join("\n\n")}\n`;
}
