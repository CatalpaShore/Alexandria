import { config } from "../server/src/config.js";
import { db } from "../server/src/db.js";
import { shouldForceEntityNameOverride } from "../server/src/entityNameLocalization.js";
import { getEntityExtendedProfile } from "../server/src/entityProfiles.js";

const LOCALIZABLE_TYPES = ["actor", "director", "maker", "label", "series"] as const;
type LocalizableType = typeof LOCALIZABLE_TYPES[number];

type Candidate = {
  type: LocalizableType;
  value: string;
  source: string;
  target: "profile" | "metadata";
  frequency: number;
  localized?: string;
  namesJson: string;
  factsJson: string;
};

function readArg(name: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? "" : "";
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function normalize(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function hasJapaneseKana(value: string): boolean {
  // Exclude shared punctuation such as the katakana middle dot in an otherwise
  // English identity (for example WILD・SEVEN).
  return /[ぁ-ゖァ-ヺ]/u.test(value);
}

function hasChineseDisplayName(value: string): boolean {
  const normalized = normalize(value);
  return /[\u3400-\u9fff]/u.test(normalized) && !hasJapaneseKana(normalized);
}

function isUsableChineseName(source: string, translated: string): boolean {
  const value = normalize(translated)
    .replace(/^[["'“‘]+|[\]"'”’]+$/gu, "")
    .replace(/^中文(?:译名|翻译)[：:]\s*/u, "");
  if (!value || !/[\u3400-\u9fff]/u.test(value) || hasJapaneseKana(value)) return false;
  const addedLatinTokens = value.match(/[A-Za-z][A-Za-z0-9._-]*/gu) ?? [];
  if (hasJapaneseKana(source) && addedLatinTokens.some((token) => !source.toLocaleLowerCase().includes(token.toLocaleLowerCase()))) {
    return false;
  }
  if (value.length > Math.max(40, source.length * 4 + 16)) return false;
  if (hasJapaneseKana(source) && /\p{Script=Han}/u.test(source) && source.length >= 5 && value.length < 3) return false;
  return !/(无法翻译|作为一个|以下是|翻译结果|抱歉|对不起)/u.test(value);
}

function typeInstruction(type: LocalizableType): string {
  if (type === "actor") return "演员艺名：优先使用已有常见中文名，否则做简洁稳定音译，不要改变人物身份";
  if (type === "director") return "导演署名：优先使用已知中文名，否则做简洁音译，不要把人名扩写成句子";
  if (type === "maker") return "影视厂商名：保留品牌身份，片假名品牌做简洁中文音译或意译";
  if (type === "label") return "影视厂牌名：保留品牌身份，片假名品牌做简洁中文音译或意译";
  return "系列名称：忠实翻译原意，保持为简洁标题，不增加原文没有的情节";
}

const AUTONOMOUS_NAME_OVERRIDES = new Map<string, string>(([
  ["actor:千石もなか", "千石萌奈香"],
  ["actor:妃ひかり", "妃光"],
  ["actor:Harumayuka", "瑶真由香"],
  ["actor:瑶真由香", "瑶真由香"],
  ["actor:Imaikanna", "今井栞菜"],
  ["actor:Shiorina Imai", "今井栞菜"],
  ["actor:今井栞菜", "今井栞菜"],
  ["actor:鈴音杏夏", "铃音杏夏"],
  ["actor:Anatsu Suzune", "铃音杏夏"],
  ["actor:Suzune Anka", "铃音杏夏"],
  ["actor:月城りり香", "月城莉莉香"],
  ["actor:Tsukishiroririka", "月城莉莉香"],
  ["actor:あかね麗", "茜丽"],
  ["actor:あかね麗（二階堂麗）", "茜丽"],
  ["actor:土屋かなで", "土屋奏"],
  ["actor:新井リマ", "新井莉玛"],
  ["actor:新井莉玛", "新井莉玛"],
  ["actor:倉本すみれ", "仓本堇"],
  ["actor:新ありな", "新有菜"],
  ["actor:一条みお", "一条澪"],
  ["actor:鳳カレン", "凤凯伦"],
  ["actor:佐野秋帆", "佐野秋帆"],
  ["actor:倖月セラ", "幸月塞拉"],
  ["actor:蘭華", "兰华"],
  ["actor:目黒ひな実", "目黑雏实"],
  ["actor:Soa", "藤崎初爱"],
  ["actor:藤崎そあ", "藤崎初爱"],
  ["actor:山口菜穂", "山口菜穗"],
  ["actor:山口奈穂", "山口菜穗"],
  ["actor:Naho Yamaguchi", "山口菜穗"],
  ["actor:桐原あずさ", "桐原梓"],
  ["actor:伊藤あずさ", "伊藤梓"],
  ["actor:Azusa Kirihara", "桐原梓"],
  ["actor:Azusa Kirihara (Azusa Ito)", "桐原梓"],
  ["actor:宇筒ゆめ", "宇筒梦"],
  ["actor:宇佐美みおん", "宇筒梦"],
  ["actor:Yume Utsutsu", "宇筒梦"],
  ["label:NATURAL HIGH", "NATURAL HIGH"],
  ["label:ナチュラルハイ", "NATURAL HIGH"],
  ["actor:篠咲らら", "筱咲拉拉"],
  ["actor:東実果", "东实果"],
  ["actor:叶芽遥希", "叶芽遥希"],
  ["actor:しじみ", "持田茜（蚬）"],
  ["actor:ちなみん", "千奈樱"],
  ["actor:藤井シェリー", "藤井雪莉"],
  ["actor:早坂ひとみ", "早坂瞳"],
  ["actor:川上なな実", "川上奈奈美"],
  ["actor:南野あかり", "南野明里"],
  ["actor:凰華りん", "凰华凛"],
  ["actor:持田茜（しじみ）", "持田茜（蚬）"],
  ["actor:桜ちなみ", "千奈樱"],
  ["actor:雨村梨花", "雨村莉香"],
  ["actor:湊波流", "凑晴"],
  ["actor:佐久間つな", "佐久间津奈"],
  ["actor:市来まひろ", "市来真寻"],
  ["actor:美木ひなの", "美希日菜乃"],
  ["actor:羽咲みはる", "羽咲美晴"],
  ["actor:雛形みくる", "雏形美玖"],
  ["actor:藍澤りく", "蓝泽陆"],
  ["actor:初美なのか", "初美七夏"],
  ["actor:架乃ゆら", "架乃由罗"],
  ["actor:桐香ゆうり", "桐山结羽"],
  ["actor:三崎なな", "三崎奈奈"],
  ["actor:すみれ美香", "堇美香"],
  ["actor:七瀬温", "七濑温"],
  ["actor:七堂蓮未", "七堂莲未"],
  ["actor:はるか悠", "遥悠"],
  ["actor:丹羽すみれ", "丹羽堇"],
  ["actor:三舩みすず", "三船美铃"],
  ["actor:上園ゆりか", "上园由里香"],
  ["actor:上原まみ", "上原真美"],
  ["actor:丸山れおな", "丸山玲奈"],
  ["actor:中森玲子", "中森玲子"],
  ["actor:中森心々奈", "中森心心奈"],
  ["actor:中澤チュリン", "中泽秋琳"],
  ["actor:久須美亜優", "久须美亚优"],
  ["actor:乙都さきの", "乙都咲乃"],
  ["actor:五十嵐なつ", "五十岚夏"],
  ["actor:乙羽あむ", "乙羽亚梦"],
  ["actor:天音ちか", "天音千佳"],
  ["actor:山瀬美紀", "山濑美纪"],
  ["actor:亜佐倉みんと", "亚佐仓敏托"],
  ["actor:今井もも", "今井桃"],
  ["actor:井上もも", "井上桃"],
  ["actor:五十嵐潤", "五十岚润"],
  ["actor:五十嵐美月", "五十岚美月"],
  ["actor:伊東紅", "伊东红"],
  ["actor:百合川雅", "百合川雅"],
  ["actor:仲丘たまき", "仲丘玉纪"],
  ["actor:夏原カレン", "夏原可怜"],
  ["actor:初美りん", "初美铃"],
  ["actor:初乃ふみか", "初乃文香"],
  ["actor:優希絵理奈", "优希绘里奈"],
  ["actor:優木なお", "优木奈绪"],
  ["actor:田中美矢", "田中美矢"],
  ["actor:北山憂", "北山忧"],
  ["actor:初美沙希", "初美沙希"],
  ["actor:加美杏奈", "加美杏奈"],
  ["actor:前田桃杏", "前田桃杏"],
  ["actor:奥井千晴", "奥井千晴"],
  ["actor:坂口れな", "坂口丽奈"],
  ["actor:城山若菜", "城山若菜"],
  ["actor:千鶴えま", "千鹤绘麻"],
  ["actor:大場ゆい", "大场唯"],
  ["actor:吉川蓮", "吉川莲"],
  ["actor:吉岡ひより", "吉冈日和"],
  ["actor:吉永あかね", "吉永茜"],
  ["actor:坂井美桜", "坂井美樱"],
  ["actor:帆志科南", "帆志科南"],
  ["actor:富井美帆", "帆志科南"],
  ["actor:姫川かのん", "姬川花音"],
  ["actor:岸永みりな", "岸永美里奈"],
  ["actor:宮瀬リコ", "宫濑理子"],
  ["actor:南涼", "南凉"],
  ["actor:穂花あいり", "穗花爱理"],
  ["actor:籠咲茜", "笼崎茜"],
  ["actor:愛沢あかり", "相泽明里"],
  ["actor:希咲アリス", "木崎爱丽丝"],
  ["actor:七瀬アリス", "七濑爱丽丝"],
  ["actor:花宮あむ", "花宫亚梦"],
  ["actor:皆瀬杏樹", "水濑杏珠"],
  ["actor:水谷あおい", "水谷葵"],
  ["actor:坂本りお", "坂本莉绪"],
  ["actor:武田エレナ", "武田艾莲娜"],
  ["actor:西野絵美", "西野绘美"],
  ["actor:丘咲エミリ", "冈崎艾米丽"],
  ["actor:神納花", "加乃花"],
  ["actor:山口葉瑠", "山口春"],
  ["actor:梓ヒカリ", "梓光莉"],
  ["actor:瀬戸ひなこ", "濑户雏子"],
  ["actor:伊織ひなの", "伊织日菜乃"],
  ["actor:早瀬すみれ", "早濑堇"],
  ["actor:平井花音", "平井花音"],
  ["actor:椎名寛子", "椎名宽子"],
  ["actor:早坂ひとみ", "早坂瞳"],
  ["actor:芦名ほのか", "芦名穗香"],
  ["actor:星冬香", "星冬香"],
  ["actor:神波多一花", "神波多一花"],
  ["actor:池内遥", "池内遥"],
  ["actor:林芽依", "林芽衣"],
  ["actor:双葉くるみ", "双叶胡桃"],
  ["actor:目黒ひな実", "目黑雏实"],
  ["actor:Soa", "藤崎初爱"],
  ["actor:藤崎そあ", "藤崎初爱"],
  ["director:イナバール", "伊纳巴尔"],
  ["director:ナブル", "纳布鲁"],
  ["director:ブーマー44", "布玛44"],
  ["director:溜池ゴロー", "溜池五郎"],
  ["director:スガ・パチーノ", "菅·帕西诺"],
  ["director:タイガー小堺", "小堺虎"],
  ["director:キャプテン江原", "江原船长"],
  ["director:氷馬サブロー", "冰马三郎"],
  ["director:ヴェルベット長田", "维尔维特长田"],
  ["director:さもあり", "萨莫阿里"],
  ["director:紋℃", "纹℃"],
  ["director:かわ", "卡瓦"],
  ["director:ラムチョップ", "兰姆乔普"],
  ["director:前田文豪", "前田文豪"],
  ["director:沢庵", "泽庵"],
  ["director:きとるね川口", "基托鲁内川口"],
  ["director:トレンディ山口", "特伦迪山口"],
  ["director:豆沢豆太郎", "豆泽豆太郎"],
  ["director:薄刃紫翠", "薄刃紫翠"],
  ["director:ひむろっく", "冰室洛克"],
  ["director:太宰珍歩", "太宰珍步"],
  ["director:うさぴょん。", "兔蹦。"],
  ["director:マサルパンサー", "胜豹"],
  ["director:矢澤レシーブ", "矢泽接球"],
  ["director:イラマっちょ", "伊拉玛乔"],
  ["director:豊彦", "丰彦"],
  ["director:大崎広浩治", "大崎广浩治"],
  ["director:小松セブンティーン", "小松十七"],
  ["director:鎖羅鬼", "锁罗鬼"],
  ["director:魁", "魁"],
  ["director:コンニャック神野", "干邑神野"],
  ["director:あばしり一姦", "网走一奸"],
  ["director:朝霧浄", "朝雾净"],
  ["director:千一休", "千一休"],
  ["director:宝瀬博教", "宝濑博教"],
  ["director:馨", "馨"],
  ["director:ぬまモン", "沼门"],
  ["director:昇天シロー", "升天四郎"],
  ["director:加州夏", "加州夏"],
  ["director:K.C.武田", "K.C.武田"],
  ["director:犬神涼", "犬神凉"],
  ["director:ノーマルKIM", "普通KIM"],
  ["director:ビバ☆ゴンゾ", "万岁☆Gonzo"],
  ["director:島村雪彦", "岛村雪彦"],
  ["series:脅迫スイートルーム", "胁迫套房"],
  ["series:Coercion Suite", "胁迫套房"],
  ["series:Hunter Black", "Hunter Black"],
  ["series:ハンターブラック", "黑色猎人"],
  ["series:～喉奥貫通～（KLEIN）", "～深喉贯通～（KLEIN）"],
  ["series:初生中解禁", "初次中出解禁"],
  ["series:【初撮り】ネットでAV応募→AV体験撮影", "【初拍】网上报名AV→AV体验拍摄"],
  ["series:濃厚オヤジの追撃種付けプレス20連発大乱交", "浓厚大叔的追击播种体位20连发大乱交"],
  ["series:とある男", "某个男人"],
  ["series:喉マ●コ中出し", "深喉中出"],
  ["series:Slut Substitution", "Slut Substitution"],
  ["series:アイアンクリムゾン", "钢铁深红"],
  ["series:初体験○本番スペシャル", "初体验○实战特别篇"],
  ["series:Throat Interview", "Throat Interview"],
  ["series:S&M Unbanned", "S&M Unbanned"],
  ["series:緊縛解禁", "紧缚解禁"],
  ["series:身代わり肉便器", "替身肉便器"],
  ["series:喉姦面接", "深喉面试"],
  ["series:脅迫（CHoBitcH）", "胁迫（CHoBitcH）"],
  ["series:喉奥鬼調教", "深喉残酷调教"],
  ["series:変態インストール覚醒ダッチワイフ", "变态植入：觉醒充气娃娃"],
  ["series:アナル喉奥マ○コ 最狂贅沢3穴フルコース", "肛门、深喉、阴部 最狂奢华三穴全套"],
  ["series:裸神", "裸神"],
  ["series:～喉奥貫通～", "～深喉贯通～"],
  ["series:イ●スタやりたガール。", "想约的Ins女孩。"],
  ["series:スペンス乳腺開発クリニック", "斯彭斯乳腺开发诊所"],
  ["series:リミットブレイクSEX 絶対的美少女の殻をブチ破るドM覚醒3性交", "极限突破SEX：打破绝对美少女外壳的抖M觉醒3次性交"],
  ["series:神イカせ 完全ガチ拘束強●アクメ", "神级高潮：完全强制拘束高潮"],
  ["series:はじめての大・痙・攣スペシャル", "初次大痉挛特别篇"],
  ["series:女子校生孕ませレ●プ中出し○連発", "女学生受孕强奸中出○连发"],
  ["series:I'm Going To Expose My Proud Wife.", "I'm Going To Expose My Proud Wife."],
  ["maker:しろハメVR", "白色实拍VR"],
  ["maker:うさぎ/妄想族", "兔子/妄想族"],
  ["maker:アロマ企画", "芳香企划"],
  ["maker:ヴァンアソシエイツ", "万恩联合"],
  ["maker:プラネットプラス", "星球加"],
  ["maker:マックスエー", "麦克斯A"],
  ["maker:ケイ・エム・プロデュース", "凯艾姆制作"],
  ["maker:溜池ゴロー", "溜池五郎"],
  ["maker:ベビー・エンターテインメント", "宝贝娱乐"],
  ["maker:プレミアム", "精品"],
  ["maker:ワンズファクトリー", "万兹工厂"],
  ["maker:SODクリエイト", "SOD Create"],
  ["maker:アタッカーズ", "ATTACKERS"],
  ["maker:アップス", "阿普斯"],
  ["maker:エスワン ナンバーワンスタイル", "S1 NO.1 STYLE"],
  ["maker:エスワンナンバーワンスタイル", "S1 NO.1 STYLE"],
  ["maker:エムズビデオグループ", "M氏影像集团"],
  ["maker:グローバルメディアアネックス", "环球媒体附属"],
  ["maker:グローリークエスト", "GLORY QUEST"],
  ["maker:ゲスヤミ", "卑暗"],
  ["maker:セレブの友", "名流之友"],
  ["maker:タカラ映像", "宝映像"],
  ["maker:ダスッ！", "达斯！"],
  ["maker:ドグマ", "教条"],
  ["maker:ドリームチケット", "Dream Ticket"],
  ["maker:ナチュラルハイ", "自然兴奋"],
  ["maker:ビビアン", "薇薇安"],
  ["maker:プレステージ", "PRESTIGE"],
  ["maker:プレステージプレミアム(PRESTIGE PREMIUM)", "声望精品(PRESTIGE PREMIUM)"],
  ["maker:マドンナ", "麦当娜"],
  ["maker:ミル", "米尔"],
  ["maker:ムーディーズ", "MOODYZ"],
  ["maker:メンヘラコリック(´・-・。)", "心病迷恋"],
  ["maker:レアルワークス", "Real Works"],
  ["maker:ロイヤル", "皇家"],
  ["maker:ワープエンタテインメント", "跃迁娱乐"],
  ["maker:ヴィ", "维"],
  ["maker:シロウトTV", "素人TV"],
  ["maker:ナンパTV", "搭讪TV"],
  ["maker:はじめ企画", "初企划"],
  ["maker:ドキュメンTV", "纪实TV"],
  ["maker:クリスタル映像", "水晶映像"],
  ["maker:ナンパJAPAN", "搭讪JAPAN"],
  ["maker:美尻ちゃんねる", "美臀频道"],
  ["label:えむっ娘ラボ", "M娘实验室"],
  ["maker:えむっ娘ラボ", "M娘实验室"],
  ["maker:ボニータ/妄想族", "波尼塔/妄想族"],
  ["maker:山と空/妄想族", "山与天空/妄想族"],
  ["label:ボニータ/妄想族", "波尼塔/妄想族"],
  ["label:マゾマン", "受虐男"],
  ["label:ジェントルマン（ジェントルマン/妄想族）", "绅士（绅士/妄想族）"],
  ["label:ソフト・オン・デマンド", "软体点播（SOD）"],
  ["label:ゲスヤミ", "卑暗"],
  ["label:グローバルメディアアネックス", "环球媒体附属"],
  ["label:こりゃヌケる！", "这下能爽出来！"],
  ["label:BEATLE（HMNダイナマイト！！/妄想族）", "披头士（HMN炸药！！/妄想族）"],
  ["label:SODクリエイト", "SOD Create"],
  ["label:セレブの友", "名流之友"],
  ["label:ダスッ！", "达斯！"],
  ["label:ドグマ", "教条"],
  ["label:ドリームチケット", "Dream Ticket"],
  ["label:ビビアン", "薇薇安"],
  ["label:プレステージ", "PRESTIGE"],
  ["label:ミル", "米尔"],
  ["label:溜池ゴロー", "溜池五郎"],
  ["label:ティッシュ", "TISSUE（纸巾）"],
  ["maker:ファインピクチャーズ", "精美影业"],
  ["label:みんなのキカタン", "大家的企划单体女优"],
  ["label:COSMOSPICTURES（ソフト・オン・デマンド）", "COSMOSPICTURES（SOD旗下）"],
  ["label:マニアックス（Fitch）", "狂热者（Fitch）"],
  ["label:素人バラエティー", "素人综艺"],
  ["label:秋のシコシコ強化月間", "秋季自慰强化月"],
  ["label:はじめ企画", "初企划"],
  ["series:アイデアポケットBEST", "Idea Pocket精选"],
  ["series:学級委員の僕だけが知る生徒指導・○○先生の裏の顔。", "只有身为班委的我才知道：某某老师在学生指导背后的另一面。"],
  ["series:愛液だらだらおマ〇コを濃厚クンニと絶倫チ〇ポで満たす叔父の逆PtoM性交", "叔父的逆向PtoM性交：以浓厚爱抚与绝伦阳具填满爱液淋漓的私处"],
  ["series:W秘書　どM社長を芯まで操る過密なブラック搾精スケジューリング", "W秘书：彻底操控受虐社长的高密度黑心榨精日程"],
  ["series:午後の人妻たち", "午后的人妻们"],
  ["series:夫の上司に弱みを握られ脅され新築マイホームで犯●れ続けるいいなり性処理新婚妻", "被丈夫上司抓住把柄，在新家中持续遭胁迫的任人摆布的新婚妻"],
  ["series:日常に膨らむ着衣おっぱいのたわわな誘惑", "日常中丰盈胀起的着衣胸部诱惑"],
  ["series:Wセレブ妻 抑えられない衝動、性欲", "W名流妻：无法抑制的冲动与欲望"],
  ["series:たちんぼ 夜の街に佇む美女に本気で交渉", "街头候客：与伫立夜街的美女认真交涉"],
  ["series:ミル", "米尔"],
  ["series:優等生J○は全裸露出がお好き", "优等生J○喜欢全裸暴露"]
] as Array<[string, string]>).map(([key, value]) => [normalize(key), value]));

async function translateBatch(candidates: Candidate[]): Promise<Map<string, string>> {
  const response = await fetch(`${config.externalAi.ollamaUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.externalAi.chatModel,
      stream: false,
      think: false,
      format: "json",
      messages: [{
        role: "system",
        content: [
          "你是 Alexandria 日本成人视频资料库的中文本地化编辑。",
          "只翻译名称，不扩写、不解释、不审查内容。英文品牌保持原样；本批输入均含日文。",
          typeInstruction(candidates[0]!.type),
          "输出 JSON 对象，键 translations 对应数组；每项严格包含 source 和 zh，顺序与输入一致。",
          "中文必须使用简体字，不得残留平假名或片假名。片假名对应外文时也要中文音译或意译，不得新增原文没有的拉丁字母；原文已有英文品牌可原样保留。"
        ].join("\n")
      }, {
        role: "user",
        content: JSON.stringify(candidates.map((candidate) => ({ source: candidate.source })))
      }],
      options: { temperature: 0, num_predict: Math.max(512, candidates.length * 120) }
    }),
    signal: AbortSignal.timeout(120_000)
  });
  if (!response.ok) throw new Error(`Ollama name localization failed: ${response.status}`);
  const payload = await response.json() as { message?: { content?: string } };
  const parsed = parseJson<{ translations?: Array<{ source?: string; zh?: string }> }>(payload.message?.content ?? "", {});
  const result = new Map<string, string>();
  for (const item of parsed.translations ?? []) {
    const source = normalize(item.source);
    const translated = normalize(item.zh);
    if (source && isUsableChineseName(source, translated)) result.set(source, translated);
  }
  return result;
}

const requestedType = readArg("--type") as LocalizableType | "";
if (requestedType && !LOCALIZABLE_TYPES.includes(requestedType)) {
  throw new Error(`Unsupported entity type: ${requestedType}`);
}
const limit = Math.max(1, Number.parseInt(readArg("--limit") || "50", 10));
const batchSize = Math.min(12, Math.max(1, Number.parseInt(readArg("--batch-size") || "8", 10)));
const requestedEntity = normalize(readArg("--entity"));
const execute = !process.argv.includes("--dry-run");
const profileRows = (db.prepare(`
  SELECT profiles.facet_type AS type, profiles.facet_value AS value, profiles.display_name AS source,
    profiles.names_json AS namesJson, profiles.facts_json AS factsJson,
    COALESCE((
      SELECT COUNT(DISTINCT facets.normalized_code)
      FROM media_metadata_facets facets
      WHERE facets.facet_type = profiles.facet_type
        AND (
          facets.facet_value = profiles.facet_value
          OR EXISTS (
            SELECT 1 FROM json_each(profiles.aliases_json) alias
            WHERE TRIM(CAST(alias.value AS TEXT)) = facets.facet_value
          )
        )
    ), 0) AS frequency
  FROM entity_profiles profiles
  WHERE profiles.facet_type IN ('actor', 'director', 'maker', 'label', 'series')
    AND profiles.source_status != 'unverified'
    ${requestedType ? "AND profiles.facet_type = @requestedType" : ""}
`).all({ requestedType }) as Omit<Candidate, "target">[]).map((row) => ({ ...row, target: "profile" as const }));

const metadataRows = (db.prepare(`
  SELECT type, value, source, localized, COUNT(*) AS frequency,
    '{}' AS namesJson, '{}' AS factsJson
  FROM (
    SELECT 'actor' AS type, TRIM(CAST(source.value AS TEXT)) AS value,
      TRIM(CAST(source.value AS TEXT)) AS source,
      TRIM(COALESCE(CAST(translated.value AS TEXT), '')) AS localized
    FROM media_metadata metadata
    JOIN json_each(metadata.actors_json) source
    LEFT JOIN json_each(metadata.actors_zh_json) translated ON translated.key = source.key
    UNION ALL SELECT 'director', director, director, director_zh FROM media_metadata
    UNION ALL SELECT 'maker', maker, maker, maker_zh FROM media_metadata
    UNION ALL SELECT 'label', label, label, label_zh FROM media_metadata
    UNION ALL SELECT 'series', series, series, series_zh FROM media_metadata
  )
  WHERE TRIM(source) != ''
    ${requestedType ? "AND type = @requestedType" : ""}
  GROUP BY type, value, source, localized
  ORDER BY CASE WHEN type = 'actor' THEN 0 ELSE 1 END,
    frequency DESC,
    CASE type WHEN 'actor' THEN 0 WHEN 'director' THEN 1 WHEN 'maker' THEN 2 WHEN 'label' THEN 3 ELSE 4 END,
    source COLLATE NOCASE ASC
`).all({ requestedType }) as Omit<Candidate, "target">[]).map((row) => ({ ...row, target: "metadata" as const }));

const candidates = [...profileRows, ...metadataRows].filter((row) => {
  if (requestedEntity && normalize(row.source) !== requestedEntity) return false;
  const override = AUTONOMOUS_NAME_OVERRIDES.get(normalize(`${row.type}:${row.source}`));
  const resolved = row.target === "profile" ? getEntityExtendedProfile(row.type, row.value) : null;
  const storedProfileNames = row.target === "profile"
    ? parseJson<Record<string, string>>(row.namesJson, {})
    : {};
  const shouldForceOverride = shouldForceEntityNameOverride({
    override,
    target: row.target,
    localized: row.localized,
    // A computed display name may already be repaired by metadata aliases while
    // names_json.zh still contains an old machine translation. Curated overrides
    // must repair the persisted profile field so Agent evidence and every client
    // consume the same name instead of relying on the UI fallback.
    resolvedDisplayName: row.target === "profile" ? storedProfileNames.zh : resolved?.displayName
  });
  // An explicit override may intentionally be an English brand name. Once the
  // stored value matches it, do not send that row back through the generic
  // "must contain Chinese" fallback on every run.
  if (override) return shouldForceOverride;
  if (!hasJapaneseKana(row.source)) return false;
  if (row.target === "metadata") {
    return !hasChineseDisplayName(normalize(row.localized));
  }
  return resolved != null && !hasChineseDisplayName(resolved.displayName);
}).sort((left, right) => {
  const actorPriority = Number(right.type === "actor") - Number(left.type === "actor");
  if (actorPriority !== 0) return actorPriority;
  if (left.frequency !== right.frequency) return right.frequency - left.frequency;
  const typePriority = LOCALIZABLE_TYPES.indexOf(left.type) - LOCALIZABLE_TYPES.indexOf(right.type);
  if (typePriority !== 0) return typePriority;
  if (left.target !== right.target) return left.target === "profile" ? -1 : 1;
  return left.source.localeCompare(right.source, "ja");
}).slice(0, limit);

console.log(`${execute ? "自动写入" : "只读演练"}专题中文名：${candidates.length} 条`);
const update = db.prepare(`
  UPDATE entity_profiles
  SET names_json = @namesJson, facts_json = @factsJson, updated_at = @updatedAt
  WHERE facet_type = @type AND facet_value = @value AND names_json = @previousNamesJson
`);
const metadataUpdates = {
  actor: db.prepare(`
    UPDATE media_metadata
    SET actors_zh_json = (
      SELECT json_group_array(CASE
        WHEN TRIM(CAST(source.value AS TEXT)) = @source THEN @translated
        ELSE COALESCE(CAST(translated.value AS TEXT), CAST(source.value AS TEXT))
      END)
      FROM json_each(media_metadata.actors_json) source
      LEFT JOIN json_each(media_metadata.actors_zh_json) translated ON translated.key = source.key
    ), updated_at = @updatedAt
    WHERE EXISTS (
      SELECT 1 FROM json_each(media_metadata.actors_json) source
      WHERE TRIM(CAST(source.value AS TEXT)) = @source
    )
  `),
  director: db.prepare("UPDATE media_metadata SET director_zh = @translated, updated_at = @updatedAt WHERE director = @source"),
  maker: db.prepare("UPDATE media_metadata SET maker_zh = @translated, updated_at = @updatedAt WHERE maker = @source"),
  label: db.prepare("UPDATE media_metadata SET label_zh = @translated, updated_at = @updatedAt WHERE label = @source"),
  series: db.prepare("UPDATE media_metadata SET series_zh = @translated, updated_at = @updatedAt WHERE series = @source")
};
let written = 0;
let rejected = 0;
let processed = 0;
const batches = LOCALIZABLE_TYPES.flatMap((type) => {
  const typedCandidates = candidates.filter((candidate) => candidate.type === type);
  return Array.from({ length: Math.ceil(typedCandidates.length / batchSize) }, (_, index) =>
    typedCandidates.slice(index * batchSize, (index + 1) * batchSize));
});
for (const batch of batches) {
  const translations = new Map<string, string>();
  for (const candidate of batch) {
    const override = AUTONOMOUS_NAME_OVERRIDES.get(normalize(`${candidate.type}:${candidate.source}`));
    if (override) translations.set(normalize(candidate.source), override);
  }
  const unresolved = batch.filter((candidate) => !translations.has(normalize(candidate.source)));
  if (unresolved.length) {
    for (const [source, translated] of await translateBatch(unresolved)) translations.set(source, translated);
  }
  for (const candidate of batch) {
    if (translations.has(normalize(candidate.source))) continue;
    try {
      const retry = await translateBatch([candidate]);
      const translated = retry.get(normalize(candidate.source));
      if (translated) translations.set(normalize(candidate.source), translated);
    } catch {
      // A single malformed name remains rejected without blocking the batch.
    }
  }
  const now = new Date().toISOString();
  for (const candidate of batch) {
    processed += 1;
    const translated = translations.get(normalize(candidate.source));
    if (!translated) {
      rejected += 1;
      console.log(`[${processed}/${candidates.length}] ${candidate.type}:${candidate.source} · ${candidate.target} · rejected`);
      continue;
    }
    console.log(`[${processed}/${candidates.length}] ${candidate.type}:${candidate.source} · ${candidate.target} → ${translated}`);
    if (!execute) continue;
    if (candidate.target === "metadata") {
      const result = metadataUpdates[candidate.type].run({ source: candidate.source, translated, updatedAt: now });
      if (result.changes > 0) written += 1;
      else rejected += 1;
      continue;
    }
    const names = parseJson<Record<string, string>>(candidate.namesJson, {});
    const facts = parseJson<Record<string, unknown>>(candidate.factsJson, {});
    const result = update.run({
      type: candidate.type,
      value: candidate.value,
      previousNamesJson: candidate.namesJson,
      namesJson: JSON.stringify({ ...names, zh: translated }),
      factsJson: JSON.stringify({
        ...facts,
        localizedNameSource: `local-${config.externalAi.chatModel}`,
        localizedNameUpdatedAt: now
      }),
      updatedAt: now
    });
    if (result.changes === 1) written += 1;
    else rejected += 1;
  }
}
if (execute && written > 0) {
  const revision = new Date().toISOString();
  db.transaction(() => {
    db.prepare("DELETE FROM app_cache_state WHERE cache_key LIKE 'topic-stats:%'").run();
    db.prepare(`
      INSERT INTO app_cache_state (cache_key, source_signature, updated_at)
      VALUES ('topic-localizations', @revision, @revision)
      ON CONFLICT(cache_key) DO UPDATE SET
        source_signature = excluded.source_signature,
        updated_at = excluded.updated_at
    `).run({ revision });
  })();
}
console.log(`完成：候选 ${candidates.length} · 写入 ${written} · 拒绝 ${rejected}`);
