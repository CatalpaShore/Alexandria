import { describe, expect, it } from "vitest";
import {
  assessSubtitleTranslationText,
  buildVtt,
  filterSpeechCuesByVad,
  normalizeSpeechRecognitionText,
  normalizeRepeatedSpeechText,
  normalizeTranslatedSpeechText,
  parseVadSpeechIntervals,
  parseVttCues,
  sanitizeSpeechCues
} from "../../server/src/services/subtitleTranslationText.js";

describe("汉化字幕时间轴", () => {
  it("读取带编号、样式标签和多行文本的 WebVTT", () => {
    const cues = parseVttCues(`WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\n<v 主演>こんにちは</v>\n二行目\n\nNOTE ignore\n\n2\n00:00:04.500 --> 00:00:06.000\n元気ですか\n`);

    expect(cues).toEqual([
      { timing: "00:00:01.000 --> 00:00:03.000", text: "こんにちは\n二行目" },
      { timing: "00:00:04.500 --> 00:00:06.000", text: "元気ですか" }
    ]);
  });

  it("生成浏览器可直接加载的 WebVTT", () => {
    const output = buildVtt([
      { timing: "00:00:01.000 --> 00:00:03.000", text: "你好" },
      { timing: "00:00:04.500 --> 00:00:06.000", text: "最近怎么样？" }
    ]);

    expect(output).toBe("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n你好\n\n00:00:04.500 --> 00:00:06.000\n最近怎么样？\n");
  });

  it("解析独立 VAD 的原始人声区间，并换算为毫秒", () => {
    const intervals = parseVadSpeechIntervals(`Detected 2 speech segments:\nSpeech segment 0: start = 13517.00, end = 13612.00\nSpeech segment 1: start = 28973.00, end = 29190.00\n`);

    expect(intervals).toEqual([
      { start: 135_170, end: 136_120 },
      { start: 289_730, end: 291_900 }
    ]);
  });

  it("用 VAD 过滤静音幻觉，同时保留正常对白的原始时间轴", () => {
    const result = filterSpeechCuesByVad([
      { timing: "00:00:58.000 --> 00:01:27.000", text: "静音中的幻觉" },
      { timing: "00:04:44.000 --> 00:04:54.000", text: "こちらメニューになります" },
      { timing: "00:09:31.000 --> 00:10:01.000", text: "长片段末尾的真实对白" }
    ], [
      { start: 289_730, end: 291_900 },
      { start: 598_000, end: 600_000 }
    ]);

    expect(result.cues).toEqual([
      { timing: "00:04:44.000 --> 00:04:54.000", text: "こちらメニューになります" },
      { timing: "00:09:57.500 --> 00:10:00.750", text: "长片段末尾的真实对白" }
    ]);
    expect(result.removedNonSpeech).toBe(1);
    expect(result.realignedTimings).toBe(1);
  });

  it("剔除浏览器无法显示的零时长识别幻觉", () => {
    const result = sanitizeSpeechCues([
      { timing: "00:45:09.840 --> 00:45:09.840", text: "立て立て立て立て" },
      { timing: "00:45:10.000 --> 00:45:12.000", text: "立って" }
    ]);

    expect(result.cues).toEqual([
      { timing: "00:45:10.000 --> 00:45:12.000", text: "立って" }
    ]);
    expect(result.removedInvalidTimings).toBe(1);
  });

  it("清理循环识别幻觉、重复字幕和异常超长时间轴", () => {
    const result = sanitizeSpeechCues([
      {
        timing: "02:20:49.530 --> 02:27:57.070",
        text: "キックスナース、キックスナース、キックスナース、キックスナース、キックスナース、まだ足が震えてる"
      },
      { timing: "02:28:00.000 --> 02:28:03.000", text: "そうです" },
      { timing: "02:28:00.500 --> 02:28:03.500", text: "そうです" }
    ]);

    expect(result.cues).toHaveLength(2);
    expect(result.cues[0].text).toBe("キックスナース、まだ足が震えてる");
    expect(result.cues[0].timing).toBe("02:20:49.530 --> 02:20:55.050");
    expect(result.collapsedRepetitions).toBe(1);
    expect(result.removedDuplicates).toBe(1);
    expect(result.repairedTimings).toBe(1);
  });

  it("清理无分隔符的长循环，并拦截未翻译日文", () => {
    const result = sanitizeSpeechCues([
      { timing: "00:00:01.000 --> 00:00:05.000", text: "一人で一人で一人で一人で一人で" },
      { timing: "00:00:06.000 --> 00:00:10.000", text: "はぁはぁはぁはぁはぁ" }
    ]);

    expect(result.cues.map((cue) => cue.text)).toEqual(["一人で…一人で", "はぁ…はぁ"]);
    expect(result.collapsedRepetitions).toBe(2);
    expect(assessSubtitleTranslationText("動かない", "動かない")).toEqual({
      okay: false,
      reasons: ["japanese-residual", "untranslated"]
    });
    expect(assessSubtitleTranslationText("動かない", "别动")).toEqual({ okay: true, reasons: [] });
    expect(assessSubtitleTranslationText("ビジネスマナー", "#")).toEqual({
      okay: false,
      reasons: ["placeholder"]
    });
    expect(assessSubtitleTranslationText("どうぞ", "请进。”}]}，")).toEqual({
      okay: false,
      reasons: ["protocol-artifact"]
    });
    expect(assessSubtitleTranslationText("どうぞ", "请进。”},{")).toEqual({
      okay: false,
      reasons: ["protocol-artifact"]
    });
    expect(assessSubtitleTranslationText("気持ちいい", "作品编号：HND-843；日文：気持ちいい")).toEqual({
      okay: false,
      reasons: ["japanese-residual", "prompt-artifact"]
    });
    expect(normalizeTranslatedSpeechText("どうぞ", "请进。”}]}，")).toBe("请进。");
    expect(normalizeTranslatedSpeechText("どうぞ", "请进。”},{")).toBe("请进。");
    expect(normalizeTranslatedSpeechText("ほら", "看”}]}。")).toBe("看吧。");
    expect(normalizeTranslatedSpeechText("やはりは?", "やはり”？")).toBe("果然是？");
    expect(normalizeRepeatedSpeechText("あ〜い、あ〜い、あ〜い、あ〜い、あ〜い")).toBe("あ〜い…あ〜い");
    expect(normalizeTranslatedSpeechText("あ〜い…あ〜い", "啊～好舒服、啊～好舒服、啊～好舒服")).toBe("啊～好舒服……啊～好舒服");
    expect(normalizeTranslatedSpeechText("カナエの言う通り、無理だけはしないでください。", "就像カナエ说的那样，千万不要勉强自己")).toBe("正如佳苗所说，请千万不要勉强自己。");
    expect(normalizeTranslatedSpeechText("あ〜〜〜〜", "啊~~~~~~~~~~~~~~~~~~~~")).toBe("啊……");
    expect(normalizeTranslatedSpeechText("あ〜〜〜〜", "啊〜〜〜〜〜〜")).toBe("啊……");
    expect(normalizeTranslatedSpeechText("うん。", "嗯，这样就够了吗？")).toBe("嗯。");
    expect(normalizeTranslatedSpeechText("奥がいい生チンプがいい", "裸体阴唇也好棒")).toBe("里面更好，我想要真鸡巴。");
  });

  it("纠正日语口语同音误识别，并限制连续相同的幻觉字幕", () => {
    const normalized = normalizeSpeechRecognitionText("足切れにしてるな。足経験するほど気持ちよかったのか。");
    expect(normalized).toEqual({
      text: "足痙攣してるな。足痙攣するほど気持ちよかったのか。",
      corrections: 2
    });

    const result = sanitizeSpeechCues([
      { timing: "00:00:01.000 --> 00:00:03.000", text: "足継連してるな" },
      { timing: "00:00:04.000 --> 00:00:06.000", text: "同じ幻覚" },
      { timing: "00:00:07.000 --> 00:00:09.000", text: "同じ幻覚" },
      { timing: "00:00:10.000 --> 00:00:12.000", text: "同じ幻覚" },
      { timing: "00:00:13.000 --> 00:00:15.000", text: "同じ幻覚" }
    ]);

    expect(result.cues.map((cue) => cue.text)).toEqual(["足痙攣してるな", "同じ幻覚", "同じ幻覚"]);
    expect(result.normalizedPhrases).toBe(1);
    expect(result.removedDuplicates).toBe(2);
  });

  it("纠正尿液场景和成人对白中的高置信度同音误识别", () => {
    expect(normalizeSpeechRecognitionText("おしっこ読んでみましょうか")).toMatchObject({
      text: "おしっこ飲んでみましょうか",
      corrections: 1
    });
    expect(normalizeSpeechRecognitionText("ごめんなさい、おじこください!")).toMatchObject({
      text: "ごめんなさい、おしっこください!",
      corrections: 1
    });
    expect(normalizeSpeechRecognitionText("自分のはやですか")).toMatchObject({
      text: "自分のは嫌ですか",
      corrections: 1
    });
    expect(normalizeSpeechRecognitionText("カメラが大きくなってしまいました。")).toMatchObject({
      text: "亀頭が大きくなってしまいました。",
      corrections: 1
    });
    expect(normalizeTranslatedSpeechText("おしっこ飲んでみましょうか", "读一下小便")).toBe("那就试着喝点尿吧。");
    expect(normalizeTranslatedSpeechText("マンコにおしっこください!", "请原谅我")).toBe("请尿在我小穴里！");
    expect(normalizeTranslatedSpeechText("亀頭が大きくなってしまいました。", "相机变大了")).toBe("龟头变大了。");
    expect(normalizeSpeechRecognitionText("生駅にせよ、日本にせよ、大駅を出してもらって飲み込むと消火器に入るわけなので、その人の体から出たものが私の体の中でもう一周すぎじゃないですか。")).toMatchObject({
      text: "精液にせよ、尿にせよ、唾液を出してもらって飲み込むと消化器に入るわけなので、その人の体から出たものが私の体の中でもう一周するじゃないですか。",
      corrections: 1
    });
    expect(normalizeTranslatedSpeechText("どれくらい体勢でやりましょうか?", "是从那里流出来的吗")).toBe("用什么姿势来做呢？");
    expect(normalizeTranslatedSpeechText("お口直しするの?", "尝尝嘴里的味道")).toBe("要换换口味吗？");
    expect(normalizeTranslatedSpeechText("入れたくなっちゃったけどさ", "虽然不想进去")).toBe("虽然忍不住想插进去……");
    expect(normalizeSpeechRecognitionText("ヒステリーとかをよく読みますかね")).toMatchObject({
      text: "ミステリーとかをよく読みますかね",
      corrections: 1
    });
    expect(normalizeSpeechRecognitionText("メッキな本とか")).toMatchObject({
      text: "エッチな本とか",
      corrections: 1
    });
    expect(normalizeSpeechRecognitionText("友達が2杯に")).toMatchObject({
      text: "友達が2人",
      corrections: 1
    });
    expect(normalizeTranslatedSpeechText("ミステリーとかをよく読みますかね", "歇斯底里")).toBe("经常读推理小说之类的。");
    expect(normalizeTranslatedSpeechText("エッチな本とか", "金属质感的书")).toBe("成人读物之类的。");
    expect(normalizeTranslatedSpeechText("友達が2人", "朋友喝两杯")).toBe("有两个朋友。");
    expect(normalizeSpeechRecognitionText("私の顧客には下フェチがたくさんいてね").text)
      .toBe("私の顧客には舌フェチがたくさんいてね");
    expect(normalizeSpeechRecognitionText("下フェチ?").text).toBe("舌フェチ?");
    expect(normalizeTranslatedSpeechText("舌フェチ?", "恋足癖？")).toBe("迷恋舌头？");
    expect(normalizeTranslatedSpeechText(
      "服従契約書にサインしてしまった私を待ち受けていたのは",
      "签下服从契约书后，等待我的却是变态社长的调教生活。"
    )).toBe("签下服从契约书后，等待着我的，");
    expect(normalizeSpeechRecognitionText("俺のせいで静まで移動になってしまった").text)
      .toBe("俺のせいで静まで異動になってしまった");
    expect(normalizeTranslatedSpeechText("俺のせいで静まで異動になってしまった", "跟着静子搬家"))
      .toBe("都怪我，害得连静也被调职了。");
    expect(normalizeSpeechRecognitionText("俺も明日からしばらく今日に転勤だ").text)
      .toBe("俺も明日からしばらく地方に転勤だ");
    expect(normalizeTranslatedSpeechText("俺も明日からしばらく地方に転勤だ", "调到今天这个岗位"))
      .toBe("我从明天起也要暂时调到外地工作。");
    expect(normalizeSpeechRecognitionText("今日のスケジュール行ってくれ").text)
      .toBe("今日のスケジュール言ってくれ");
    expect(normalizeTranslatedSpeechText("今日のスケジュール言ってくれ", "今天的日程你去处理"))
      .toBe("告诉我今天的日程。");
    expect(normalizeSpeechRecognitionText(
      "あ、ほら、君、若社長のお酒がなくなってるから、早くついてあげて"
    ).text).toBe("あ、ほら、君、若社長のお酒がなくなってるから、早く注いであげて");
    expect(normalizeTranslatedSpeechText(
      "あ、ほら、君、若社長のお酒がなくなってるから、早く注いであげて",
      "社长你的酒喝完了吗？快给我倒点吧。"
    )).toBe("你看，若社长的酒已经没了，快给他倒上。");
    expect(normalizeSpeechRecognitionText("なかなかいいシャイン").text).toBe("なかなかいい社員");
    expect(normalizeTranslatedSpeechText("なかなかいい社員", "这酒真不错啊"))
      .toBe("真是个相当不错的员工。");
    expect(normalizeSpeechRecognitionText(
      "今回こそ、ラメ奉仕したくて仕方がない人にまで、ちゃんと仕上げましょうね。"
    ).text).toBe("今回こそ、舐め奉仕したくて仕方がない人にまで、ちゃんと仕上げましょうね。");
    expect(normalizeTranslatedSpeechText(
      "今回こそ、舐め奉仕したくて仕方がない人にまで、ちゃんと仕上げましょうね。",
      "这次一定要好好伺候那些人。"
    )).toBe("这次一定要把她彻底调教成忍不住想用舌头侍奉别人的人。");
    expect(normalizeSpeechRecognitionText("たっとりと、かわいがってやってください。").text)
      .toBe("たっぷりと、かわいがってやってください。");
    expect(normalizeTranslatedSpeechText("たっぷりと、かわいがってやってください。", "请宠幸我"))
      .toBe("请尽情疼爱她吧。");
    expect(normalizeSpeechRecognitionText("おつかれさまなきゃ").text).toBe("お疲れ様でした");
    expect(normalizeTranslatedSpeechText("起きてしまったか…", "难道被发现了吗"))
      .toBe("把你弄醒了吗……");
    expect(normalizeTranslatedSpeechText("いや、いやですよ、ごめんなさい…", "不，不是的，对不起"))
      .toBe("不，我不要，对不起……");
    expect(normalizeSpeechRecognitionText("今度君は僕の舐めさせるんだよ").text)
      .toBe("今度は君に僕のを舐めさせるんだよ");
    expect(normalizeTranslatedSpeechText("今度は君に僕のを舐めさせるんだよ", "下次尝尝我的味道"))
      .toBe("这次我要让你舔我的。");
    expect(normalizeSpeechRecognitionText("ちょっと私やっぱ**れちゃって**").text)
      .toBe("ちょっと私やっぱ酔っ払っちゃって");
    expect(normalizeTranslatedSpeechText("ちょっと私やっぱ酔っ払っちゃって", "我又犯浑了"))
      .toBe("我果然还是喝醉了……");
    expect(normalizeTranslatedSpeechText("それは困ります", "那倒也无妨")).toBe("这可不行。");
    expect(normalizeTranslatedSpeechText("上田社長の会社を潰したくないだろう", "不想让社长把公司搞垮吧"))
      .toBe("你也不想让上田社长的公司倒闭吧。");
    expect(normalizeSpeechRecognitionText("くるさいな").text).toBe("うるさいな");
    expect(normalizeTranslatedSpeechText("うるさいな", "真拿你没办法"))
      .toBe("真啰嗦。");
    expect(normalizeTranslatedSpeechText(
      "僕のいろんなところを舐めてくれたらすごい気持ちいいだろうな",
      "要是让我舔遍全身，那该有多爽啊"
    )).toBe("如果你用这条舌头舔遍我身上的各个地方，一定会特别舒服吧。");
    expect(normalizeSpeechRecognitionText("君のクラウド慣れさせてくれたいんかもっと").text)
      .toBe("君の舌をもっと慣れさせてやりたいんだ");
    expect(normalizeTranslatedSpeechText("君の舌をもっと慣れさせてやりたいんだ", "习惯我的云"))
      .toBe("我要让你的舌头更加习惯。");
    expect(normalizeSpeechRecognitionText("君もこのあと僕なのには僕の体を舐めることになるんだから").text)
      .toBe("君もこのあと僕の体を舐めることになるんだから");
    expect(normalizeTranslatedSpeechText("君もこのあと僕の体を舐めることになるんだから", "习惯被我这样对待"))
      .toBe("反正接下来你也要舔我的身体。");
    expect(normalizeTranslatedSpeechText("首から舐めてもらおうか", "让我尝尝你的脖子吧"))
      .toBe("让你从我的脖子开始舔吧。");
    expect(normalizeSpeechRecognitionText("おはんしんぜひもなめろ").text).toBe("下半身全部舐めろ");
    expect(normalizeTranslatedSpeechText("下半身全部舐めろ", "好好把我也舔干净吧"))
      .toBe("把我的下半身全部舔一遍。");
    expect(normalizeSpeechRecognitionText("君がそうやって波奉仕してくれれば").text)
      .toBe("君がそうやって舐め奉仕してくれれば");
    expect(normalizeSpeechRecognitionText("首の周りをしたり、絡めたり").text)
      .toBe("舌を回したり、絡めたり");
    expect(normalizeTranslatedSpeechText("舌を回したり、絡めたり", "绕着脖子舔"))
      .toBe("用舌头绕圈、缠绕。");
    expect(normalizeSpeechRecognitionText("おー、カメラのおかげでパッパンだよ。").text)
      .toBe("おー、君のおかげでパンパンだよ。");
    expect(normalizeTranslatedSpeechText("おー、君のおかげでパンパンだよ。", "多亏摄像机，看起来真精神"))
      .toBe("哦，托你的福，已经胀得硬邦邦了。");
    expect(normalizeSpeechRecognitionText("ぷ…ぷ�")).toMatchObject({ text: "ぷ…ぷ", corrections: 1 });
    expect(normalizeSpeechRecognitionText("やっぱり僕の思い子は 君はなかなかいい").text)
      .toBe("やっぱり僕の思い通り 君はなかなかいい");
    expect(normalizeSpeechRecognitionText("チンポインついてる汚れ全部").text)
      .toBe("チンポについてる汚れ全部");
    expect(normalizeSpeechRecognitionText("拭い取るつもりで食べる").text)
      .toBe("拭い取るつもりで舐めろ");
    expect(normalizeTranslatedSpeechText("拭い取るつもりで舐めろ", "擦干净再吃"))
      .toBe("像要把它擦干净一样舔。");
    expect(normalizeSpeechRecognitionText("チンポを自分のものの奥まで突っ込めよう").text)
      .toBe("チンポを自分の喉の奥まで突っ込めよ");
    expect(normalizeTranslatedSpeechText("チンポを自分の喉の奥まで突っ込めよ", "插进自己深处"))
      .toBe("把鸡巴塞到你自己的喉咙深处。");
    expect(normalizeSpeechRecognitionText("そうそう、そこに、 鍵に引っ掛かすな").text)
      .toBe("そうそう、そこに、 歯に引っ掛けるな");
    expect(normalizeTranslatedSpeechText("そうそう、そこに、 歯に引っ掛けるな", "别把钥匙挂上去"))
      .toBe("对，就是那里，别让牙齿刮到。");
    expect(normalizeSpeechRecognitionText("君のよだれで、 このチームいっぱいにしてくれ").text)
      .toBe("君のよだれで、 このチンポをいっぱいにしてくれ");
    expect(normalizeTranslatedSpeechText("どうだ私のチンポは", "怎么样，我的小鸡鸡是"))
      .toBe("我的鸡巴怎么样？");
    expect(normalizeSpeechRecognitionText("何もやるだな").text).toBe("何でもやるんだな");
    expect(normalizeTranslatedSpeechText("何でもやるんだな", "没什么好做的"))
      .toBe("看来你什么都肯做啊。");
    expect(normalizeSpeechRecognitionText("君だってすいすわかってきてるから").text)
      .toBe("君だって少しずつ分かってきてるから");
    expect(normalizeTranslatedSpeechText("君だって少しずつ分かってきてるから", "早就知道我会这样"))
      .toBe("你也在渐渐明白该怎么做了。");
    expect(normalizeSpeechRecognitionText("セックスする時も 舌を出していらっしゃあ").text)
      .toBe("セックスする時も 舌を出していなさい");
    expect(normalizeTranslatedSpeechText("セックスする時も 舌を出していなさい", "做爱时也把舌头伸出来"))
      .toBe("做爱的时候也要一直伸着舌头。");
    expect(normalizeTranslatedSpeechText("なめればなめる分だけ", "舔得越狠"))
      .toBe("舔得越多，");
    expect(normalizeSpeechRecognitionText("こういうの逃げ").text).toBe("こういうの好き?");
    expect(normalizeTranslatedSpeechText("こういうの好き?", "这种就逃了"))
      .toBe("喜欢这样吗？");
    expect(normalizeSpeechRecognitionText("卵、いっぱいついてください").text)
      .toBe("中をいっぱい突いてください");
    expect(normalizeTranslatedSpeechText("中をいっぱい突いてください", "请多给我一些蛋液"))
      .toBe("请用力多顶顶里面。");
    expect(normalizeSpeechRecognitionText("よっ！けいれい！").text).toBe("おっ、痙攣！");
    expect(normalizeTranslatedSpeechText("おっ、痙攣！", "嗨！真漂亮"))
      .toBe("哦，抽搐了！");
    expect(normalizeSpeechRecognitionText("しきにつかってください").text)
      .toBe("好きに使ってください");
    expect(normalizeSpeechRecognitionText("貼ってくれたおかげでようやく契約が取れた").text)
      .toBe("張ってくれたおかげでようやく契約が取れた");
    expect(normalizeTranslatedSpeechText("君が体を", "你让我")).toBe("多亏你不惜牺牲身体，");
    expect(normalizeTranslatedSpeechText("張ってくれたおかげでようやく契約が取れた", "多亏你帮忙才签下合同"))
      .toBe("我们终于拿下了合同。");
    expect(normalizeSpeechRecognitionText("君から夫に俺を言っといてくれ").text)
      .toBe("君から夫にお礼を言っといてくれ");
    expect(normalizeTranslatedSpeechText("君から夫にお礼を言っといてくれ", "跟老公说我是你的"))
      .toBe("替我向你丈夫道声谢。");
    expect(normalizeTranslatedSpeechText("しかし若社長君の身体を褒めてたぞ", "夸了那位年轻的社长"))
      .toBe("不过，若社长可是夸奖了你的身体。");
    expect(normalizeTranslatedSpeechText("営業の田中です", "我是营业部的小田中"))
      .toBe("我是营业部的田中。");
    expect(normalizeTranslatedSpeechText("ですが社長は今お取り込み中ですので", "社长正在被接待"))
      .toBe("不过社长现在正忙着……");
    expect(normalizeSpeechRecognitionText("じゃあ後で改めてお迎えした方がよろしいでしょう").text)
      .toBe("じゃあ後で改めてお伺いした方がよろしいでしょうか");
    expect(normalizeTranslatedSpeechText("じゃあ後で改めてお伺いした方がよろしいでしょうか", "稍后再去接您"))
      .toBe("那我晚些时候再来拜访比较好吗？");
    expect(normalizeTranslatedSpeechText("では改めてお伺いしたほうがよろしいですよね", "重新确认一下"))
      .toBe("那我稍后再来拜访比较好，对吧？");
    expect(normalizeTranslatedSpeechText("こんなによだれたらして", "口水都流成这样还要我做什么"))
      .toBe("口水都流成这样了。");
    expect(normalizeSpeechRecognitionText("これでもっともっと契約取りそうだね").text)
      .toBe("これでもっともっと契約取れそうだね");
    expect(normalizeTranslatedSpeechText("これでもっともっと契約取れそうだね", "合同条款更苛刻"))
      .toBe("这样看来，我们还能拿下更多合同。");
    expect(normalizeTranslatedSpeechText("これ歯立てるなよ", "别把牙露出来"))
      .toBe("别让牙齿碰到。");
    expect(normalizeSpeechRecognitionText("ちべたをなめるような生活してたかもしれないものね").text)
      .toBe("地べたを舐めるような生活してたかもしれないものね");
    expect(normalizeTranslatedSpeechText("地べたを舐めるような生活してたかもしれないものね", "过着舔狗一样的生活"))
      .toBe("说不定我们现在还过着穷困潦倒的生活呢。");
    expect(normalizeSpeechRecognitionText("スズー俺はこんなんで本当に悪かったな").text)
      .toBe("静、こんなことになって本当に悪かったな");
    expect(normalizeSpeechRecognitionText("スズーもう来てもらえないな").text)
      .toBe("静、もう来てもらえないな");
    expect(normalizeSpeechRecognitionText("すずはね、こっちに、釣りなんて人は見たことない").text)
      .toBe("実はね、こっちに来るまで、釣りなんてしたこともなかった");
    expect(normalizeSpeechRecognitionText("静はね、こっちに来て、知り合いなんて一人もいない").text)
      .toBe("実はね、こっちに来るまで、釣りなんてしたこともなかった");
    expect(normalizeTranslatedSpeechText("実はね、こっちに来るまで、釣りなんてしたこともなかった", "钓男人的女人"))
      .toBe("其实，在来这里之前，我从来没有钓过鱼。");
    expect(normalizeSpeechRecognitionText("すずは、大丈夫?慣れない仕事で大変なんじゃないの?").text)
      .toBe("静は、大丈夫?慣れない仕事で大変なんじゃないの?");
    expect(normalizeSpeechRecognitionText("すずは、俺より絶対優秀だったもんな").text)
      .toBe("静は、俺より絶対優秀だったもんな");
    expect(normalizeSpeechRecognitionText("そばにいてあげられないのか、もどかしいよ").text)
      .toBe("そばにいてあげられないのが、もどかしいよ");
    expect(normalizeTranslatedSpeechText("そばにいてあげられないのが、もどかしいよ", "不能待在我身边吗"))
      .toBe("没办法陪在你身边，我心里很着急。");
    expect(normalizeSpeechRecognitionText("電気が悪いのかな").text).toBe("電波が悪いのかな");
    expect(normalizeTranslatedSpeechText("電波が悪いのかな", "是不是电压不稳"))
      .toBe("是不是信号不好？");
    expect(normalizeSpeechRecognitionText("静岡はもともとコミュニティが**作られなかった**からさ").text)
      .toBe("静はもともとコミュニケーションが得意な方だったからさ");
    expect(normalizeTranslatedSpeechText("静はもともとコミュニケーションが得意な方だったからさ", "静冈没有建立社区"))
      .toBe("静本来就很擅长与人沟通。");
    expect(normalizeSpeechRecognitionText("あ、でも、全然、なんか、6階分だから、ちょっと").text)
      .toBe("あ、でも、全然、なんか、休憩中だから、ちょっと");
    expect(normalizeTranslatedSpeechText("あ、でも、全然、なんか、休憩中だから、ちょっと", "有六层楼高"))
      .toBe("啊，不过没事，大家正在休息，所以有点吵。");
    expect(normalizeSpeechRecognitionText("その呼びをしなくても いい人ばっかだよ").text)
      .toBe("その心配をしなくても いい人ばっかだよ");
    expect(normalizeSpeechRecognitionText("ちょっと一回ロープしてくれるよ 心配してたらよさ").text)
      .toBe("ちゃんといっぱいフォローしてくれるよ 心配しなくてもさ");
    expect(normalizeTranslatedSpeechText("ちゃんといっぱいフォローしてくれるよ 心配しなくてもさ", "用绳子绑一下"))
      .toBe("大家都会好好照顾你的，不用担心。");
    expect(normalizeTranslatedSpeechText("仕事も大丈夫だとは思うんだけどさ", "工作没问题，难处马上说"))
      .toBe("工作方面我觉得应该没问题。");
    expect(normalizeTranslatedSpeechText("社長だから大丈夫だとは思うんだけどさ", "我是社长，没什么大不了"))
      .toBe("毕竟对方是社长，我想应该没事，不过……");
    expect(normalizeSpeechRecognitionText("社長の理由はプリンサイドの人とかさ").text)
      .toBe("社長の周りは取引先の人とかさ");
    expect(normalizeSpeechRecognitionText("結構気づかしい人とかそうじゃん").text)
      .toBe("結構気難しい人とかいそうじゃん");
    expect(normalizeSpeechRecognitionText("いや、取り振り先の人がさ").text)
      .toBe("いや、取引先の人がさ");
    expect(normalizeSpeechRecognitionText("あ、すじゅ、綺麗だからさ").text)
      .toBe("あ、静、綺麗だからさ");
    expect(normalizeSpeechRecognitionText("あるはらとか").text).toBe("アルハラとか");
    expect(normalizeTranslatedSpeechText("アルハラとか", "有原田之类的吗"))
      .toBe("比如强迫喝酒之类的。");
    expect(normalizeTranslatedSpeechText("社長はちゃんと守ってくれるの", "社长会保护我吗"))
      .toBe("社长会好好保护你吗？");
    expect(normalizeSpeechRecognitionText("やっぱ会社で一番静か可愛いと思うけど").text)
      .toBe("やっぱ会社で一番、静が可愛いと思うけど");
    expect(normalizeTranslatedSpeechText("やっぱ会社で一番、静が可愛いと思うけど", "公司里最安静可爱"))
      .toBe("我还是觉得静是公司里最可爱的。");
    expect(normalizeSpeechRecognitionText("そんなにそうやってるって、暮らしのあなただけよ").text)
      .toBe("そんなふうに言ってくれるの、あなただけよ");
    expect(normalizeTranslatedSpeechText("そんなふうに言ってくれるの、あなただけよ", "只有你过得清闲"))
      .toBe("会这么说我的，只有你。");
    expect(normalizeSpeechRecognitionText("でもなんかあったらすぐに相手にも言いなよ").text)
      .toBe("でもなんかあったらすぐに俺にも言いなよ");
    expect(normalizeTranslatedSpeechText("でもなんかあったらすぐに俺にも言いなよ", "告诉对方"))
      .toBe("不过，要是有什么事就马上告诉我。");
    expect(normalizeSpeechRecognitionText("田舎をバカに過ごしていきたいけどさ").text)
      .toBe("田舎をバカにするわけじゃないけどさ");
    expect(normalizeTranslatedSpeechText("田舎をバカにするわけじゃないけどさ", "傻乎乎地过下去"))
      .toBe("我不是想瞧不起乡下，不过……");
    expect(normalizeTranslatedSpeechText("店とかも結構ないしさ全然ないんだよ", "店里也没什么店"))
      .toBe("商店也不多，基本上什么都没有。");
    expect(normalizeTranslatedSpeechText("あ、ダメ、それもう行っちゃうよ", "已经要结束了"))
      .toBe("啊，不行，那样我就要高潮了。");
    expect(normalizeSpeechRecognitionText("早速接待して、分けて").text).toBe("早速接待してあげて");
    expect(normalizeTranslatedSpeechText("早速接待してあげて", "赶紧招待，分开来弄"))
      .toBe("赶快去接待他吧。");
    expect(normalizeTranslatedSpeechText("この子、悪くないね", "这孩子还不错"))
      .toBe("这个女人还不错。");
    expect(normalizeSpeechRecognitionText("何してよ、社長に早く、ペルペルしろ").text)
      .toBe("何してよ、社長に早く、ペロペロしろ");
    expect(normalizeTranslatedSpeechText("何してよ、社長に早く、ペロペロしろ", "给老板好好干"))
      .toBe("还愣着干什么，快给社长舔。");
    expect(normalizeSpeechRecognitionText("どうですか、ケッツ様。ちょっとよく見せてくれ").text)
      .toBe("どうですか、ケツは。ちょっとよく見せてくれ");
    expect(normalizeSpeechRecognitionText("うわー、そんなとこもなみてくれるのか").text)
      .toBe("うわー、そんなとこも舐めてくれるのか");
    expect(normalizeTranslatedSpeechText("うわー、そんなとこも舐めてくれるのか", "连那里也给我看吗"))
      .toBe("哇，连那里也愿意舔吗？");
    expect(normalizeSpeechRecognitionText("いっぱいペラペラさせてください").text)
      .toBe("いっぱいペロペロさせてください");
    expect(normalizeTranslatedSpeechText("いっぱいペロペロさせてください", "多弄湿一点"))
      .toBe("请让我尽情地舔。");
    expect(normalizeSpeechRecognitionText("わーもう頑張ってきないよ").text)
      .toBe("わー、もう我慢できないよ");
    expect(normalizeSpeechRecognitionText("うまいできない、ごめんなさい、ごめんなさい").text)
      .toBe("うまくできない、ごめんなさい、ごめんなさい");
    expect(normalizeTranslatedSpeechText("うまくできない、ごめんなさい、ごめんなさい", "真好吃，不行"))
      .toBe("我做不好，对不起，对不起。");
    expect(normalizeTranslatedSpeechText("あ、締まりがいいわこれ", "这高潮感真棒"))
      .toBe("啊，里面夹得真紧。");
    expect(normalizeTranslatedSpeechText("行く行く行くだめ行く", "不行，快停下"))
      .toBe("要去了、要去了……不行，要高潮了！");
    expect(normalizeSpeechRecognitionText("あのマーク使っていっぱいいってください").text)
      .toBe("あの、もっと突いて、いっぱいイってください");
    expect(normalizeTranslatedSpeechText("あの、もっと突いて、いっぱいイってください", "那个标记用完再给一些"))
      .toBe("那个，请再多顶几下，让我尽情高潮。");
    expect(normalizeSpeechRecognitionText("きゃまちいいです").text).toBe("気持ちいいです");
    expect(normalizeTranslatedSpeechText("気持ちいいです", "可以结束吗"))
      .toBe("好舒服。");
    expect(normalizeTranslatedSpeechText("もう少しお尻をください", "再稍微用力一点"))
      .toBe("请把臀部再往这边一点。");
    expect(normalizeTranslatedSpeechText("はいそれぐらい行きましょう", "好的，就到这里吧"))
      .toBe("好，就这样拍吧。");
    expect(normalizeTranslatedSpeechText("いいですねはいもう一枚行きます", "好啊，再来一次"))
      .toBe("很好，再拍一张。");
    expect(normalizeTranslatedSpeechText("微笑みという顔も入れつつ", "连笑容这样的表情也一并拍进去"))
      .toBe("同时也拍进微笑的表情。");
    expect(normalizeTranslatedSpeechText("自分の魅力をグイグイ押してくるタイプじゃなくて", "不是那种拼命推销自己魅力的类型，而是会主动配合我想法的人"))
      .toBe("她不是那种会强烈展现自身魅力的类型，");
    expect(normalizeTranslatedSpeechText("なんかこっちに合わせてくれようとするんですよね", "她总是很配合我这边呢"))
      .toBe("她总是会尽量配合我。");
    expect(normalizeTranslatedSpeechText("こっちが何撮りたいって言ったら", "我说想拍什么她就配合我"))
      .toBe("如果我说想拍什么，");
    expect(normalizeTranslatedSpeechText("持ってもらってもいいですか", "可以拿过来吗？"))
      .toBe("可以帮我拿一下吗？");
    expect(normalizeSpeechRecognitionText("何が好きなサザエさんの中では？").text)
      .toBe("何が好き？流川さんの中では？");
    expect(normalizeSpeechRecognitionText("吉那屋とか").text).toBe("吉野家とか");
    expect(normalizeTranslatedSpeechText("何が好き？流川さんの中では？", "在喜欢各种东西的沙耶小姐当中呢？"))
      .toBe("流川小姐喜欢什么？");
    expect(normalizeTranslatedSpeechText("吉野家とか", "像吉那屋之类的"))
      .toBe("像吉野家之类的。");
    expect(normalizeTranslatedSpeechText("だが彼女はデビュー当時と変わらない", "但她出道至今，风格始终未变。"))
      .toBe("但她和出道时一样。");
    expect(normalizeTranslatedSpeechText("常に笑顔で明るい彼女の流儀がある", "她始终保持着笑容，有着开朗的行事风格"))
      .toBe("她始终面带笑容、性格开朗，这就是她的风格。");
    expect(normalizeTranslatedSpeechText("何でも全力で楽しむっていうのが元なので笑ってます", "因为无论什么都要全力以赴地享受，所以才在笑"))
      .toBe("我本来就会全力享受一切，所以总是笑着。");
    expect(normalizeTranslatedSpeechText("疲れましたね、今日忙しいですねみたいな言ったら", "累了啊，今天好忙之类的（话）"))
      .toBe("如果说‘好累啊，今天真忙’之类的话，");
    expect(normalizeTranslatedSpeechText("疲れるから、言わないでって言われて", "她说‘别说了，我会累死的’。"))
      .toBe("她对我说：‘会觉得累，所以别这么说。’");
    expect(normalizeTranslatedSpeechText("なるほどって思って", "原来是这样想的。"))
      .toBe("我觉得，原来如此。");
    expect(normalizeTranslatedSpeechText("なんか無理やりそう思うんじゃなくて", "并不是硬要那样想，而是自己真正理解了之后，发自内心地认同了。"))
      .toBe("并不是勉强自己这么想，");
    expect(normalizeSpeechRecognitionText("羽ぐわいい").text).toBe("髪かわいい");
    expect(normalizeSpeechRecognitionText("すごい自信なさげる").text).toBe("すごい自信なさげ");
    expect(normalizeSpeechRecognitionText("分かつ時もありますよ").text).toBe("分かる時もありますよ");
    expect(normalizeSpeechRecognitionText("ルカワユーの新タイトルは").text).toBe("ルカワユウの新タイトルは");
    expect(normalizeTranslatedSpeechText("ソフトからハードまで多種多様なプレイ空間をご用意しております", "从软件到硬件，我们准备了多种多样的游玩空间。"))
      .toBe("从轻度到重度，我们准备了各种各样的玩法空间。");
    expect(normalizeTranslatedSpeechText("トータワーのコンシルジュのルカワユウと申します", "我是托塔大楼的康希尔珠，我叫流川夕。"))
      .toBe("我是托塔大楼的礼宾员，流川夕。");
    expect(normalizeTranslatedSpeechText("当タワーのコンシェルジュのルカワユウと申します", "我是本塔楼的礼宾员，我叫卢卡瓦优。"))
      .toBe("我是本塔楼的礼宾员，流川夕。");
    expect(normalizeTranslatedSpeechText("以前のタワーからさらにソフトからハードまで、多種多様のプレイ空間をご用意しております", "相比之前的塔楼，我们准备了从软式到硬式的各种游玩空间。"))
      .toBe("在之前的塔楼基础上，进一步提供从轻度到重度的多种玩法空间。");
    expect(normalizeTranslatedSpeechText("上へ参ります", "请往上看。"))
      .toBe("我们上楼。");
    expect(normalizeTranslatedSpeechText("ひとえ", "一惠")).toBe("全靠……");
    expect(normalizeTranslatedSpeechText("以前のタワーから", "以前的塔里")).toBe("从之前的塔楼开始，");
    expect(normalizeTranslatedSpeechText("すごい自信なさげ", "好大的自信啊。")).toBe("看起来非常没有自信。");
    expect(normalizeTranslatedSpeechText("髪かわいい", "好可爱")).toBe("发型真可爱。");
    expect(normalizeTranslatedSpeechText("分かる時もありますよ", "也有分享的时候哦")).toBe("有时也能感觉到。");
    expect(normalizeTranslatedSpeechText("セリフを覚えるときって何かコストがあったりするんですか", "学习台词时，需要付出什么代价吗？"))
      .toBe("记台词时，会有什么负担吗？");
    expect(normalizeSpeechRecognitionText("写真集とAV発電の現場って違いとかあったりしますか?").text)
      .toBe("写真集とAV撮影の現場って違いとかあったりしますか?");
    expect(normalizeTranslatedSpeechText("結構体力はじゃあ自信ある方なんですね", "看来你的体力还是很有自信的嘛。"))
      .toBe("看来你对自己的体力还挺有信心。");
    expect(normalizeTranslatedSpeechText("写真集とAV撮影の現場って違いとかあったりしますか", "摄影集和 AV 拍摄现场，两者有什么不同吗？"))
      .toBe("写真集拍摄和 AV 拍摄现场有什么不同吗？");
    expect(normalizeTranslatedSpeechText("写真集とかだとセリフとかがないじゃないですか", "像写真的话，就没有台词之类的对吧。"))
      .toBe("拍写真集时就没有台词之类的，对吧？");
    expect(normalizeSpeechRecognitionText("普通は顔を合わせして衣装合わせもするんですけど").text)
      .toBe("普通は顔を合わせて衣装合わせもするんですけど");
    expect(normalizeSpeechRecognitionText("スーパーのコーヒーのコーヒーを見ることができたのです。").text)
      .toBe("スーパーのコーヒーのコマーシャルを見ることができたのです。");
    expect(normalizeTranslatedSpeechText("彼女は苦手を克服するためにあることをしていた", "为了克服她的苦手，她做了些事。"))
      .toBe("为了克服自己的弱项，她做了一件事。");
    expect(normalizeTranslatedSpeechText("舞台を中心に活動する演出家の下", "以舞台活动为主的导演手下"))
      .toBe("在一位以舞台活动为主的导演指导下，");
    expect(normalizeTranslatedSpeechText("演技に自信のない彼女は", "对她没有自信的演技，"))
      .toBe("她对自己的演技没有信心，");
    expect(normalizeTranslatedSpeechText("スーパーのコーヒーのコマーシャルを見ることができたのです", "终于看到了超市里的咖啡了。"))
      .toBe("终于看到了超市咖啡的广告。");
    expect(normalizeSpeechRecognitionText("レビューをやっているのって今何の夢目なんですか?").text)
      .toBe("レビューをやっているのって今何年目なんですか?");
    expect(normalizeSpeechRecognitionText("一睡のしないで行ったんですか?").text)
      .toBe("一睡もせずに行ったんですか?");
    expect(normalizeSpeechRecognitionText("マジミッチだしムッチだし").text).toBe("マジ未知だし無知だし");
    expect(normalizeTranslatedSpeechText("え、せせりときのこの柚子胡椒炒め。めっちゃ美味しそうじゃない？", "诶，是拌松茸的柚子胡椒味。看起来超级好吃吧？"))
      .toBe("诶，是鸡颈肉和蘑菇的柚子胡椒炒菜。看起来超级好吃吧？");
    expect(normalizeTranslatedSpeechText("えいひれ", "哎呀，鳗鱼。"))
      .toBe("鳐鱼鳍干。");
    expect(normalizeTranslatedSpeechText("渋いですね", "真够涩的。"))
      .toBe("口味真成熟啊。");
    expect(normalizeTranslatedSpeechText("今何年目なんですか", "做评测的时候，现在是什么梦吗？"))
      .toBe("做评测现在是第几年？");
    expect(normalizeTranslatedSpeechText("緊張と不安と", "紧张和不安与"))
      .toBe("紧张和不安，");
    expect(normalizeTranslatedSpeechText("台本が届いても", "剧本也寄到了，却一点都想象不到。真是紧张又焦虑啊，而且我原本也没看过这类 AV"))
      .toBe("即使拿到剧本，");
    expect(normalizeTranslatedSpeechText("何も想像つかないし", "完全想不出是什么样子。"))
      .toBe("也完全想象不出来，");
    expect(normalizeTranslatedSpeechText("マジ未知だし無知だし", "真是紧张又期待啊。"))
      .toBe("真的既陌生又无知。");
    expect(normalizeSpeechRecognitionText("武漢さんはそのAV女優になったきっかけっていうのは?").text)
      .toBe("流川さんはAV女優になったきっかけっていうのは?");
    expect(normalizeSpeechRecognitionText("AV女優に会ってなかったら何をしてたと思いますか今").text)
      .toBe("AV女優になってなかったら何をしてたと思いますか今");
    expect(normalizeSpeechRecognitionText("普通にフリーターだと思うか").text).toBe("普通にフリーターだと思う");
    expect(normalizeTranslatedSpeechText("どんなんなんだろうみたいな", "会是什么样呢这种感觉"))
      .toBe("就觉得‘到底会是什么样呢？’");
    expect(normalizeTranslatedSpeechText("って感じで", '就是这种感觉。”}]}、corrections:[]}}]}`'))
      .toBe("就是这种感觉，");
    expect(normalizeTranslatedSpeechText("流川さんはAV女優になったきっかけっていうのは", "武汉小姐成为 AV 女优的契机是什么？"))
      .toBe("流川小姐成为 AV 女优的契机是什么？");
    expect(normalizeTranslatedSpeechText("AV女優になってなかったら何をしてたと思いますか今", "如果没遇到做 AV 女优，你觉得你现在在做什么呢？现在。"))
      .toBe("如果没有成为 AV 女优，你觉得现在会做什么？");
    expect(normalizeSpeechRecognitionText("ルカさん、AV女優になってよかったと思いますか?").text)
      .toBe("流川さん、AV女優になってよかったと思いますか?");
    expect(normalizeTranslatedSpeechText("東京に憧れ上京したが", "向往东京便来到首都，却还没找到想做的事时"))
      .toBe("向往东京来到东京，但");
    expect(normalizeTranslatedSpeechText("流川さん、AV女優になってよかったと思いますか", "露卡小姐，成为 AV 女优后觉得好吗？"))
      .toBe("流川小姐，成为 AV 女优后觉得开心吗？");
    expect(normalizeTranslatedSpeechText("こんな刺激的なお仕事はないし", "这种刺激的工作可找不到了"))
      .toBe("没有比这更刺激的工作了，");
    expect(normalizeTranslatedSpeechText("毎日を過ごしてると思う、今頃きっと", "觉得每天都在过，现在应该已经"))
      .toBe("我想现在肯定只是这样过着每一天吧，");
    expect(normalizeTranslatedSpeechText("AVのセックスは刺激的。元彼はノーマルだったから余計にそう思った。", "AV 里的性爱很刺激，因为前男友是普通模式，所以我觉得格外如此。"))
      .toBe("AV 里的性爱很刺激；因为前男友比较普通，所以我觉得格外刺激。");
    expect(normalizeTranslatedSpeechText("やる機会がない", "没机会做吗？")).toBe("没有机会做。");
    expect(normalizeSpeechRecognitionText("アル人物を呼んだ").text).toBe("ある人物を呼んだ");
    expect(normalizeTranslatedSpeechText("ある人物を呼んだ", "叫来了阿尔的人物。"))
      .toBe("叫来了一位神秘人物。");
    expect(normalizeSpeechRecognitionText("たまによく読むんですけど").text).toBe("たまに本を読むんですけど");
    expect(normalizeSpeechRecognitionText("今日は神保町に来てきました").text).toBe("今日は神保町に来ました");
    expect(normalizeSpeechRecognitionText("神保町内に書店130点").text).toBe("神保町内に書店130店");
    expect(normalizeTranslatedSpeechText("彼女の休日を取材させてもらう", "让我采访一下她的休息日。"))
      .toBe("我们来记录她的休息日。");
    expect(normalizeTranslatedSpeechText("たまに本を読むんですけど", "经常读一些书。"))
      .toBe("我偶尔会读书，");
    expect(normalizeTranslatedSpeechText("今日は神保町に来ました", "今天来到了神保町。"))
      .toBe("今天来到了神保町。");
    expect(normalizeTranslatedSpeechText("神保町内に書店130店", "神保町内就有 130 家书店"))
      .toBe("神保町内有 130 家书店。");
    expect(normalizeTranslatedSpeechText("フィーリング、人と同じです", "凭感觉，和别人一样"))
      .toBe("凭感觉，就像选择人一样。");
    expect(normalizeTranslatedSpeechText("注文は必ずブラックコーヒーとデザートのセット", "点单时请务必选择黑咖啡搭配甜点的套餐。"))
      .toBe("她总是点黑咖啡和甜点套餐。");
    expect(normalizeSpeechRecognitionText("自炊は一人暮らし始めた頃はよく知ったんで").text)
      .toBe("自炊は一人暮らし始めた頃はよくしてたんで");
    expect(normalizeSpeechRecognitionText("家にあるものが、電話へ、Uberとか頼んだりして。").text)
      .toBe("家にあるものを食べるか、Uberとか頼んだりして。");
    expect(normalizeSpeechRecognitionText("ぬかさんは自分でどんな性格だと思います?").text)
      .toBe("流川さんは自分でどんな性格だと思います?");
    expect(normalizeTranslatedSpeechText("自炊は一人暮らし始めた頃はよくしてたんで", "刚开始独居时，自己做饭的事我很熟悉"))
      .toBe("刚开始独居时经常自己做饭，");
    expect(normalizeTranslatedSpeechText("家にあるものを食べるか、Uberとか頼んだりして", "家里有什么就吃什么，或者打电话、叫 Uber 之类的。"))
      .toBe("就吃家里现有的东西，或者叫 Uber。");
    expect(normalizeTranslatedSpeechText("流川さんは自分でどんな性格だと思います", "您觉得由加小姐是个什么样的人？"))
      .toBe("流川小姐觉得自己是什么性格？");
    expect(normalizeSpeechRecognitionText("今までお付き合いした人って何で言いたくなければどうでないですか").text)
      .toBe("今までお付き合いした人って何人？言いたくなければ答えなくていいですよ");
    expect(normalizeTranslatedSpeechText("今までお付き合いした人って何人？言いたくなければ答えなくていいですよ", "以前交往过的人，如果不想说名字的话就不提了？"))
      .toBe("你交往过几个人？不想回答的话也可以不说。");
    expect(normalizeTranslatedSpeechText("気になったらもうやりたい", "一旦有了想法就再也不想做别的了。"))
      .toBe("一旦感兴趣就想马上试试。");
    expect(normalizeTranslatedSpeechText("やってダメだったらやめればいいや", "做不成就算了。"))
      .toBe("做了发现不行就放弃。");
    expect(normalizeTranslatedSpeechText("恋愛したりプライベートでセックスをしたいと思わないのか", "难道不想谈恋爱的话，也不想私下发生性关系吗？"))
      .toBe("难道不想谈恋爱或私下发生性关系吗？");
    expect(normalizeTranslatedSpeechText("人気商売のため男関係は気をつけているという", "为了维持人气，对男性关系都小心着意的。"))
      .toBe("据说因为靠人气吃饭，所以很注意与男性的关系。");
    expect(normalizeSpeechRecognitionText("全然全然やりやすいです").text).toBe("全然全然やります");
    expect(normalizeSpeechRecognitionText("いやもう持てない").text).toBe("いや、こっちは持てない");
    expect(normalizeSpeechRecognitionText("お洋服を塗るのでちょっと持ってもらって").text)
      .toBe("お洋服を脱ぐのでちょっと待ってもらって");
    expect(normalizeSpeechRecognitionText("はい赤になったら持ってます").text)
      .toBe("はい、分かりました、待ってます");
    expect(normalizeTranslatedSpeechText("全然全然やります", "完全、完全地舒服。"))
      .toBe("没事没事，我来做。");
    expect(normalizeTranslatedSpeechText("そういうとこ絶対持てるじゃないですか", "那种地方绝对能挺住吧。"))
      .toBe("这种地方你肯定拿得住吧？");
    expect(normalizeTranslatedSpeechText("いや、こっちは持てない", "不行，已经忍不住了"))
      .toBe("不，这个我拿不住。");
    expect(normalizeTranslatedSpeechText("お洋服を脱ぐのでちょっと待ってもらって", "衣服涂了，请稍微忍耐一下。"))
      .toBe("我要脱一下衣服，请稍等。");
    expect(normalizeTranslatedSpeechText("はい、分かりました、待ってます", "好的，变红了就是可以了。"))
      .toBe("好的，明白了，我等着。");
    expect(normalizeSpeechRecognitionText("ティーバッグが好きなんです").text).toBe("Tバックが好きなんです");
    expect(normalizeSpeechRecognitionText("めろくない?").text).toBe("エロくない?");
    expect(normalizeTranslatedSpeechText("あぁ、ねえ、こういうパンツ履いてるの?", "啊，姐姐，穿这种内裤吗？"))
      .toBe("啊，喂，你穿这种内裤吗？");
    expect(normalizeTranslatedSpeechText("Tバックが好きなんです", "是的，我喜欢茶包。"))
      .toBe("是的，我喜欢丁字裤。");
    expect(normalizeTranslatedSpeechText("エロくない", "不觉得爽吗？")).toBe("不觉得很色吗？");
    expect(normalizeSpeechRecognitionText("ハムスターになってるとか").text).toBe("ハンディカメラになってるわ");
    expect(normalizeSpeechRecognitionText("私たちは私たちの手を振り返しているので、私たちの手を振り返しています。").text)
      .toBe("ハンディカメラ");
    expect(normalizeTranslatedSpeechText("ハンディカメラになってるわ", "说是变成了仓鼠之类的"))
      .toBe("变成手持摄像机了。");
    expect(normalizeTranslatedSpeechText("ハンディカメラ", "我们都在拍手，所以也在跟着拍。"))
      .toBe("手持摄像机。");
    expect(normalizeTranslatedSpeechText("ねえ、見れたことがあって、ちょっとチェックしてみようかな", "昨天就弄脏了。"))
      .toBe("刚才看到过，想检查一下。");
    expect(normalizeTranslatedSpeechText("え？やんないけん？", "昨天就忍不住了。"))
      .toBe("诶？非做不可吗？");
    expect(normalizeSpeechRecognitionText("めっちゃ降参しました").text).toBe("めっちゃ興奮しました");
    expect(normalizeSpeechRecognitionText("ルカはユウにとって思い出の場所がある。").text)
      .toBe("ルカワユウにとって思い出の場所がある。");
    expect(normalizeSpeechRecognitionText("ここが、私のアナサースカイ、南新宿。").text)
      .toBe("ここが、私のアナザースカイ、南新宿。");
    expect(normalizeSpeechRecognitionText("高校生の頃学校さもったりとかして不真面目でした").text)
      .toBe("高校生の頃学校サボったりとかして不真面目でした");
    expect(normalizeTranslatedSpeechText("いや、新鮮でしたね。なんか、ベッドだけかなって思ってたんですけど、家中、いろんなところでして、めっちゃ興奮しました。", "不，很新鲜呢。本以为只是床上而已，没想到家里到处都是，彻底投降了。"))
      .toBe("不，很新鲜呢。本以为只会在床上，没想到家里各处都做了，特别兴奋。");
    expect(normalizeTranslatedSpeechText("ルカワユウにとって思い出の場所がある", "对露卡来说，这里是流川夕的回忆之地。"))
      .toBe("对流川夕来说，这里是一个充满回忆的地方。");
    expect(normalizeTranslatedSpeechText("ここが、私のアナザースカイ、南新宿", "这里是我的安身之所，南新宿。"))
      .toBe("这里就是我的‘Another Sky’，南新宿。");
    expect(normalizeTranslatedSpeechText("高校生の頃学校サボったりとかして不真面目でした", "高中时逃课什么的，很没正经。"))
      .toBe("高中时经常逃课之类的，很不认真。");
    expect(normalizeSpeechRecognitionText("お前今すぐ生徒した足ついてこいやって言って").text)
      .toBe("お前、今すぐ生徒指導室ついてこいやって言われて");
    expect(normalizeSpeechRecognitionText("妹がまともに住んでいた").text).toBe("妹がもともと住んでいた");
    expect(normalizeSpeechRecognitionText("焼肉っていう生活を一時期してました").text)
      .toBe("夜勤っていう生活を一時期してました");
    expect(normalizeSpeechRecognitionText("友達です友達普通日本な友達").text).toBe("友達です、普通に友達");
    expect(normalizeSpeechRecognitionText("フリーターだと思う普通に").text).toBe("普通にフリーターだと思う");
    expect(normalizeTranslatedSpeechText("お前、今すぐ生徒指導室ついてこいやって言われて", "你刚才不是让我马上过去给你当学生吗？"))
      .toBe("有人叫我：‘你现在马上跟我去学生指导室！’");
    expect(normalizeTranslatedSpeechText("家とかどうしたんですか", "家里怎么了？")).toBe("那住处怎么办？");
    expect(normalizeTranslatedSpeechText("家は妹がもともと住んでいたのでそこに行ったかな", "家里妹妹正正经经地住着，我就去了那里吧"))
      .toBe("我妹妹本来就住在那里，所以我就去了那里吧。");
    expect(normalizeTranslatedSpeechText("夜勤っていう生活を一時期してました", "曾经有一段时间，过着吃烤肉的生活。"))
      .toBe("有一段时间过着上夜班的生活。");
    expect(normalizeTranslatedSpeechText("友達です、普通に友達", "是朋友，就是那种普通的日本朋友"))
      .toBe("是朋友，普通朋友。");
    expect(normalizeSpeechRecognitionText("アパレル定員").text).toBe("アパレル店員");
    expect(normalizeSpeechRecognitionText("セクシー女優ルカワ優となった").text).toBe("セクシー女優ルカワユウとなった");
    expect(normalizeSpeechRecognitionText("ルカワ優はポジティブで").text).toBe("ルカワユウはポジティブで");
    expect(normalizeSpeechRecognitionText("エロに対してムチなんですよ 前もフェラーとか分かんなくて検索したりとか").text)
      .toBe("エロに対して無知なんですよ 前もフェラとか分かんなくて検索したりとか");
    expect(normalizeTranslatedSpeechText("少ない金額で長時間遊べるメダルゲームをよくやった", "经常玩那种花很少钱就能长时间游玩的弹珠机游戏。"))
      .toBe("我经常玩那种花很少钱就能玩很久的奖牌游戏。");
    expect(normalizeTranslatedSpeechText("辛いってその時思っても", "就算当时觉得很难受，也是为了自己好而积极面对。因为本来就不是那么乐观的人，但总想过得开朗一点。"))
      .toBe("即使当时觉得辛苦，");
    expect(normalizeTranslatedSpeechText("自分のためになるポジティブに", "为了让自己变得积极正面"))
      .toBe("也会积极地想，这是为了自己好。");
    expect(normalizeTranslatedSpeechText("アパレル店員を経て", "在服装店店员工作后"))
      .toBe("做过服装店店员后，");
    expect(normalizeTranslatedSpeechText("セクシー女優ルカワユウとなった", "性感女星流川夕"))
      .toBe("成为了性感女优流川夕。");
    expect(normalizeTranslatedSpeechText("ルカワユウはポジティブで", "卢卡瓦优是个积极向上的人。"))
      .toBe("流川夕是个积极向上的人，");
    expect(normalizeTranslatedSpeechText("エロに対して無知なんですよ 前もフェラとか分かんなくて検索したりとか", "我对色情片可是很挑剔的，之前根本不懂那些东西，还到处搜索呢"))
      .toBe("我对色情方面很无知，以前连口交之类的都不懂，还会去搜索。");
    expect(normalizeTranslatedSpeechText("自宅にいるという彼女にあることを伝えに向かった", "得知她独自在家后，便赶了过去。"))
      .toBe("得知她在家后，我便赶去告诉她一件事。");
    expect(normalizeSpeechRecognitionText("筋肉生活してやりませんか").text).toBe("禁欲生活してやりませんか");
    expect(normalizeSpeechRecognitionText("筋肉生活って何ですか?").text).toBe("禁欲生活って何ですか?");
    expect(normalizeTranslatedSpeechText("ちょっと1週間だけ", "稍微想让你和我一起过一周的肌肉锻炼生活，可以吗？"))
      .toBe("就一周，");
    expect(normalizeTranslatedSpeechText("禁欲生活してやりませんか", "要不要一起过一周的‘肌肉生活’？"))
      .toBe("要不要一起过一周禁欲生活？");
    expect(normalizeTranslatedSpeechText("禁欲生活", "肌肉锻炼？")).toBe("禁欲生活？");
    expect(normalizeTranslatedSpeechText("禁欲生活って何ですか", "什么叫‘肌肉生活’？"))
      .toBe("什么叫‘禁欲生活’？");
    expect(normalizeTranslatedSpeechText("むずむず", "有点痒骚骚的。"))
      .toBe("心里痒痒的。");
    expect(normalizeSpeechRecognitionText("そこのトファに座ってもらって").text).toBe("そこのソファに座ってもらって");
    expect(normalizeSpeechRecognitionText("踊ってきた").text).toBe("戻ってきた");
    expect(normalizeSpeechRecognitionText("塗れてる").text).toBe("濡れてる");
    expect(normalizeTranslatedSpeechText("戻ってきた", "跳过来。")).toBe("回来了。");
    expect(normalizeTranslatedSpeechText("濡れてる", "涂满了。"))
      .toBe("湿了。");
    expect(normalizeSpeechRecognitionText("泣いたい").text).toBe("泣きたい");
    expect(normalizeSpeechRecognitionText("正観帯聞いてみるのはいかがでしょうか").text)
      .toBe("性感帯聞いてみるのはいかがでしょうか");
    expect(normalizeSpeechRecognitionText("ペラの上手なやり方がわからない").text)
      .toBe("フェラの上手なやり方がわからない");
    expect(normalizeTranslatedSpeechText("責められることが多いってことですよねきっと", "看来是被欺负的次数比较多呢。"))
      .toBe("看来你经常被对方主动进攻。");
    expect(normalizeTranslatedSpeechText("性感帯聞いてみるのはいかがでしょうか", "试着听听关于‘正观带’的建议如何？"))
      .toBe("不如问问对方的敏感带如何？");
    expect(normalizeTranslatedSpeechText("フェラの上手なやり方がわからない", "不太懂怎么正确地使用皮肉玩具。"))
      .toBe("不知道怎么做好口交。");
    expect(normalizeTranslatedSpeechText("フェラの上手なやり方は", "不太懂怎么正确使用皮膜"))
      .toBe("至于怎么做好口交，");
    expect(normalizeSpeechRecognitionText("ルカは言うという新ジャンル").text).toBe("ルカワユウという新ジャンル");
    expect(normalizeSpeechRecognitionText("その時はお金がなくて、バイトもしてたけど、ルカが教えてるじゃないですか。").text)
      .toBe("その時はお金がなくて、バイトもしてたけど、稼ぎとかが知れているじゃないですか。");
    expect(normalizeTranslatedSpeechText("ルカワユウという新ジャンル", "露卡说这是全新的类型"))
      .toBe("一种名为‘流川夕’的全新类型。");
    expect(normalizeTranslatedSpeechText("その時はお金がなくて、バイトもしてたけど、稼ぎとかが知れているじゃないですか", "那时候没钱，还在打工呢，是露卡教我的哦。"))
      .toBe("那时候没钱，虽然也在打工，但收入也很有限。");
    expect(normalizeTranslatedSpeechText("はい、Tバックが好きなんです", "是的，我喜欢茶包。"))
      .toBe("是的，我喜欢丁字裤。");
    expect(normalizeTranslatedSpeechText("ファンの皆さんも大好きでしょ", "大家也都很喜欢吧"))
      .toBe("粉丝们也都很喜欢吧。");
    expect(normalizeTranslatedSpeechText("隠すことなんもないけど、本名ぐらい", "至少本名这种程度"))
      .toBe("没什么好隐瞒的，顶多就是本名吧。");
    expect(normalizeTranslatedSpeechText("無知なんですよ", "是鞭子呢"))
      .toBe("我对色情方面其实很无知。");
    expect(normalizeTranslatedSpeechText("AV女優じゃなかったら何をしてたと思いますか", "您觉得她在做什么"))
      .toBe("如果没有成为 AV 女优，你觉得自己会做什么？");
    expect(normalizeTranslatedSpeechText("何してるだろう", "她在做什么呢"))
      .toBe("我会在做什么呢？");
    expect(normalizeTranslatedSpeechText("普通にフリーターだと思う", "普通自由职业者"))
      .toBe("我想应该就是普通地打零工吧。");
    expect(normalizeTranslatedSpeechText("ニートはさすがいないけど", "肯定没有尼特族"))
      .toBe("不过应该还不至于当家里蹲。");
    expect(normalizeSpeechRecognitionText("ルカは優に密着").text).toBe("ルカワユウに密着");
    expect(normalizeTranslatedSpeechText("ルカワユウに密着", "露卡是优的贴身跟拍对象"))
      .toBe("贴身跟拍流川夕。");
    expect(normalizeSpeechRecognitionText("タイトルの撮影現場にお邪魔させてもらった").text)
      .toBe("とある日の撮影現場にお邪魔させてもらった");
    expect(normalizeSpeechRecognitionText("気持ちよくしてもらうのを送るよ").text)
      .toBe("気持ちよくしてもらうのを撮るよ");
    expect(normalizeTranslatedSpeechText("気持ちよくしてもらうのを撮るよ", "我会让你舒服起来"))
      .toBe("我要把你被弄舒服的样子拍下来。");
    expect(normalizeSpeechRecognitionText("何を流してるんだよ").text).toBe("何を撮ってるんだよ");
    expect(normalizeTranslatedSpeechText("何を撮ってるんだよ", "放什么片子啊"))
      .toBe("你在拍什么啊？");
    expect(normalizeSpeechRecognitionText("気持ちよくしてスーちゃん").text)
      .toBe("気持ちよくして、静ちゃん");
    expect(normalizeSpeechRecognitionText("チームキンキンさせて").text)
      .toBe("チンポギンギンにさせて");
    expect(normalizeTranslatedSpeechText("チンポギンギンにさせて", "把团队搞到硬邦邦"))
      .toBe("把鸡巴弄得硬邦邦的。");
    expect(normalizeRepeatedSpeechText("あ〜あ〜あ〜あ〜あ〜あ")).toBe("あ…あ");
    expect(normalizeTranslatedSpeechText("あ〜あ〜あ〜あ〜あ〜あ", "啊～啊～啊～啊～啊～啊"))
      .toBe("啊…啊");
    expect(normalizeTranslatedSpeechText(
      "なー俺 レディーファーストだろ ちゃんと",
      "喂，俺们不是要先女士先吗？按规矩来吧。"
    )).toBe("我可是讲究女士优先的，知道吧。");
    expect(normalizeSpeechRecognitionText(
      "社長がほら 抜けって言ってるんだ 抜けなさい"
    ).text).toBe("社長がほら 脱げって言ってるんだ 脱げなさい");
    expect(normalizeTranslatedSpeechText(
      "社長がほら 脱げって言ってるんだ 脱げなさい",
      "社长说让你出去，你就走吧"
    )).toBe("社长都说让你脱了，快脱吧。");
    expect(normalizeTranslatedSpeechText(
      "ねー 暑いし 汗かいたらほら 女性かわいそうじゃねー",
      "喂，好热啊。再喝点吧？"
    )).toBe("天气这么热，要是出汗的话，对女士也不好吧。");
    expect(normalizeSpeechRecognitionText(
      "スゴイヤバーちゃんスゴイヤバー"
    ).text).toBe("すごい、やばいじゃん、すごい、やばい");
    expect(normalizeTranslatedSpeechText(
      "すごい、やばいじゃん、すごい、やばい",
      "太棒了，酒吧姑娘，太棒了！"
    )).toBe("厉害，太夸张了，真的太厉害了！");
  });

  it("压缩带长音填充词的 Whisper 重复循环", () => {
    const normalized = normalizeSpeechRecognitionText(
      "あーやばい、あー、やばい、あー、やばい、あー、やばい、あー、やばい"
    );
    expect(normalized).toEqual({ text: "あ、やばい。", corrections: 1 });
  });

  it("结合相邻口语纠正非词误听，并对高风险短句应用翻译词汇表", () => {
    expect(normalizeSpeechRecognitionText("デッパーにして", "胸も使え、胸")).toEqual({
      text: "胸挟め",
      corrections: 1
    });
    expect(normalizeSpeechRecognitionText("足経廉してるな")).toEqual({
      text: "足痙攣してるな",
      corrections: 1
    });
    expect(normalizeTranslatedSpeechText("胸はさめ", "让它成为一个德普")).toBe("用胸夹住。");
    expect(normalizeTranslatedSpeechText("足痙攣するほど気持ちよかったのか", "伸展双腿")).toBe("舒服得腿都痉挛了吧。");
    expect(normalizeTranslatedSpeechText("質問いいですか", "有什么可以帮您")).toBe("可以问个问题吗？");
    expect(normalizeTranslatedSpeechText("ちょうどでお願いします", "请找零")).toBe("正好，不用找了。");
    expect(normalizeTranslatedSpeechText("中央駅", "中央火车站候车室，咖啡馆内")).toBe("中央车站");
    expect(normalizeTranslatedSpeechText("チンポもしごけ", "射出来吧")).toBe("鸡巴也用手撸。");
    expect(normalizeTranslatedSpeechText("お客のチンコ入れたんだろう", "肯定是被插过了吧")).toBe("让客人的鸡巴插进去了吧。");
    expect(normalizeTranslatedSpeechText("自然な会話", "自然的对话")).toBe("自然的对话");
  });
});
