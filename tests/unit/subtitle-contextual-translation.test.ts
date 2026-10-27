import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildContextualCueAnchor,
  buildContextualTranslationPrompt,
  correctJapaneseCuesWithOllama,
  correctJapaneseRecognitionWithContext,
  isLikelyOverlongSubtitleTranslation,
  parseContextualTranslationResponse,
  shouldAcceptJapaneseCorrection,
  shouldUseStandaloneAsrCorrection,
  translateContextualCuesIndividually,
  translateContextuallyWithOllama,
  translateWithDedicatedOllama
} from "../../server/src/services/subtitleContextualTranslation.js";

afterEach(() => vi.unstubAllGlobals());

describe("上下文字幕翻译", () => {
  it("上下文翻译开启时复用同一响应中的 ASR 纠错", () => {
    expect(shouldUseStandaloneAsrCorrection({
      enabled: true,
      contextualTranslation: true,
      dedicatedTranslation: false
    })).toBe(false);
    expect(shouldUseStandaloneAsrCorrection({
      enabled: true,
      contextualTranslation: true,
      dedicatedTranslation: true
    })).toBe(true);
    expect(shouldUseStandaloneAsrCorrection({
      enabled: true,
      contextualTranslation: false,
      dedicatedTranslation: false
    })).toBe(true);
  });

  it("按字幕 id 解析结构化结果并保留安全的日语纠错", () => {
    const cues = [
      { id: 10, text: "質問いいですか" },
      { id: 11, text: "かしこまりました" }
    ];
    const result = parseContextualTranslationResponse(JSON.stringify({
      cues: [
        { id: 11, anchor: buildContextualCueAnchor("かしこまりました"), zh: "好的。" },
        { id: 10, anchor: buildContextualCueAnchor("質問いいですか"), zh: "可以问个问题吗？" }
      ],
      corrections: [{ id: 10, correctedJa: "質問いいですか", confidence: 0.95 }]
    }), cues);

    expect(result.translations).toEqual(["可以问个问题吗？", "好的。"]);
    expect(result.correctedSources).toEqual(["質問いいですか", "かしこまりました"]);
  });

  it("拒绝上下文模型返回的日文残留", () => {
    expect(() => parseContextualTranslationResponse(JSON.stringify({
      cues: [{ id: 1, anchor: buildContextualCueAnchor("まだ動かない"), zh: "まだ動かない" }],
      corrections: []
    }), [{ id: 1, text: "まだ動かない" }])).toThrow("字幕质量检查失败 1: japanese-residual");
  });

  it("拒绝重复编号或错误的日文原文回显", () => {
    const cues = [{ id: 1, text: "最初の字幕" }, { id: 2, text: "次の字幕" }];
    expect(() => parseContextualTranslationResponse(JSON.stringify({ cues: [
      { id: 1, anchor: buildContextualCueAnchor("最初の字幕"), zh: "第一条" },
      { id: 1, anchor: buildContextualCueAnchor("最初の字幕"), zh: "第二条" }
    ] }), cues)).toThrow("编号或原文回显不匹配");
    expect(() => parseContextualTranslationResponse(JSON.stringify({ cues: [
      { id: 1, anchor: buildContextualCueAnchor("最初の字幕"), zh: "第一条" },
      { id: 2, anchor: buildContextualCueAnchor("被串位的原文"), zh: "第二条" }
    ] }), cues)).toThrow("编号或原文回显不匹配");
  });

  it("拒绝把相邻字幕合并到单条译文", () => {
    expect(isLikelyOverlongSubtitleTranslation("週1日登校のスタンダードスタイルの1年生クラスと", "我负责的是每周到校一天的标准模式一年级班级和每月到校一次的基础模式二年级班级，授课大约每周八节课，学生进行报告作业学习时我会针对他们不懂的地方提供个别辅导，这基本上是我的教学模式。"))
      .toBe(true);
    expect(isLikelyOverlongSubtitleTranslation("どうぞ", "请进。"))
      .toBe(false);
  });

  it("拒绝低置信度或改动过大的日语重写", () => {
    expect(shouldAcceptJapaneseCorrection("すいません", "すみません", 0.92)).toBe(true);
    expect(shouldAcceptJapaneseCorrection("すいません", "すみません", 0.6)).toBe(false);
    expect(shouldAcceptJapaneseCorrection("はい", "今日は別の話をします", 0.99)).toBe(false);
  });

  it("结合相邻对白纠正常见服务场景误听", () => {
    expect(correctJapaneseRecognitionWithContext("気温いいですか", "すいません", "はい")).toBe("質問いいですか");
    expect(correctJapaneseRecognitionWithContext("おかげで550円になります")).toBe("お会計は550円になります");
    expect(correctJapaneseRecognitionWithContext("ちょうどいっておきます", "お会計は550円になります")).toBe("ちょうどでお願いします");
    expect(correctJapaneseRecognitionWithContext("ジンポもしごけ")).toBe("チンポもしごけ");
    expect(correctJapaneseRecognitionWithContext("気温いいですか", "今日は暑いですね", "そうですね")).toBe("気温いいですか");
    expect(correctJapaneseRecognitionWithContext("お尻尾", "この三つの穴に", "たくさんください")).toBe("おチンポ");
    expect(correctJapaneseRecognitionWithContext(
      "それは困りません",
      "じゃあ君の会社との取引を停止する",
      "そうだよな"
    )).toBe("それは困ります");
    expect(correctJapaneseRecognitionWithContext("もっと出しなさい", "やっぱりいい舌だ", "柔らかくて肉厚で"))
      .toBe("もっと舌を出しなさい");
    expect(correctJapaneseRecognitionWithContext("ムチなんですよ", "私ってエロに対して", "フリースタイルで"))
      .toBe("無知なんですよ");
    expect(correctJapaneseRecognitionWithContext("きのうまくなってしまった", "ねえ", "きのうまくなってしまった"))
      .toBe("ねえ、見れたことがあって、ちょっとチェックしてみようかな");
    expect(correctJapaneseRecognitionWithContext("きのうまくなってしまった", "ねえ、見れたことがあって、ちょっとチェックしてみようかな", "わからん"))
      .toBe("え？やんないけん？");
  });

  it("将作品信息和前后字幕写入上下文提示", () => {
    const prompt = buildContextualTranslationPrompt([{ id: 3, text: "ブラック?" }], {
      code: "SDAM-171",
      title: "咖啡店场景",
      genres: ["剧情"],
      previous: ["コーヒーはブラックでよろしいですか?"],
      next: ["はい"]
    });

    expect(prompt).toContain("SDAM-171");
    expect(prompt).toContain("コーヒーはブラック");
    expect(prompt).toContain("ブラック?");
  });

  it("按编号解析专用翻译模型的批量结果", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      response: "__AMW_CUE_8__\n好的。\n__AMW_CUE_9__\n黑咖啡？"
    }), { status: 200 })));
    const result = await translateWithDedicatedOllama({
      url: "http://localhost:11434",
      model: "translategemma:12b",
      timeoutMs: 1000,
      cues: [{ id: 8, text: "かしこまりました" }, { id: 9, text: "ブラック?" }]
    });
    expect(result.translations).toEqual(["好的。", "黑咖啡？"]);
  });

  it("只接受高置信度且改动受限的 ASR 纠错", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: { content: JSON.stringify({
        corrections: [
          { id: 1, correctedJa: "すみません", confidence: 0.95 },
          { id: 2, correctedJa: "完全に別の文章", confidence: 0.99 }
        ]
      }) }
    }), { status: 200 })));
    const result = await correctJapaneseCuesWithOllama({
      url: "http://localhost:11434",
      model: "qwen2.5:7b",
      timeoutMs: 1000,
      cues: [{ id: 1, text: "すいません" }, { id: 2, text: "はい" }],
      context: { code: "TEST", title: "", genres: [], previous: [], next: [] }
    });
    expect(result).toEqual({ correctedSources: ["すみません", "はい"], correctionCount: 1 });
  });

  it("ASR 纠错 JSON 截断时拆小批次重试", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: { content: "{\"corrections\":[" } }), { status: 200 }))
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
        message: { content: "{\"corrections\":[]}" }
      }), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const cues = Array.from({ length: 6 }, (_value, id) => ({ id, text: `字幕${id}` }));
    const result = await correctJapaneseCuesWithOllama({
      url: "http://localhost:11434",
      model: "qwen3.5:9b",
      timeoutMs: 1000,
      cues,
      context: { code: "TEST", title: "", genres: [], previous: [], next: [] }
    });
    expect(result).toEqual({ correctedSources: cues.map((cue) => cue.text), correctionCount: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("单条上下文 JSON 损坏时改用纯文本本地翻译", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        message: { content: "{\"cues\":[{\"id\":1,\"zh\":\"没结束" }
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: "别动。" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await translateContextuallyWithOllama({
      url: "http://localhost:11434",
      model: "qwen3.5:9b",
      timeoutMs: 1000,
      cues: [{ id: 1, text: "動かないで" }],
      context: { code: "TEST", title: "", genres: [], previous: [], next: [] }
    });
    expect(result.translations).toEqual(["别动。"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("模型遗漏非语言喘息时使用保守中文占位，不让整部字幕失败", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        message: { content: JSON.stringify({ cues: [{ id: 179, anchor: buildContextualCueAnchor("はあ…はあは"), zh: "" }] }) }
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: "" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await translateContextuallyWithOllama({
      url: "http://localhost:11434",
      model: "qwen3.5:9b",
      timeoutMs: 1000,
      cues: [{ id: 179, text: "はあ…はあは" }],
      context: { code: "MVSD-332", title: "", genres: [], previous: [], next: [] }
    });
    expect(result.translations).toEqual(["啊……"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("逐条绑定上下文翻译，禁止相邻字幕在批量结果中串位", async () => {
    const translations = new Map([
      ["兄がいるんですけど", "我有个哥哥。"],
      ["兄が結構オタクで", "哥哥是个重度宅男。"],
      ["一緒にゲームとかして", "一起玩游戏之类的。"]
    ]);
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = JSON.parse(request.messages[1].content) as { cues: Array<{ id: number; anchor: string; ja: string }> };
      const cue = prompt.cues[0];
      return new Response(JSON.stringify({
        message: { content: JSON.stringify({ cues: [{ id: cue.id, anchor: cue.anchor, zh: translations.get(cue.ja) }] }) }
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await translateContextualCuesIndividually({
      url: "http://localhost:11434",
      model: "qwen3.5:9b",
      timeoutMs: 1000,
      cues: [
        { id: 14, text: "兄がいるんですけど" },
        { id: 15, text: "兄が結構オタクで" },
        { id: 20, text: "一緒にゲームとかして" }
      ],
      context: { code: "GKOK-002", title: "", genres: [], previous: [], next: [] }
    });
    expect(result.translations).toEqual(["我有个哥哥。", "哥哥是个重度宅男。", "一起玩游戏之类的。"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("在显式批量配置下合并本地模型请求，并按编号保持结果顺序", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = JSON.parse(request.messages[1].content) as { cues: Array<{ id: number; anchor: string; ja: string }> };
      return new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            cues: prompt.cues.map((cue) => ({ id: cue.id, anchor: cue.anchor, zh: `中文${cue.id}` }))
          })
        }
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await translateContextualCuesIndividually({
      url: "http://localhost:11434",
      model: "qwen3.5:9b",
      timeoutMs: 1000,
      batchSize: 2,
      cues: [
        { id: 1, text: "第一句" },
        { id: 2, text: "第二句" },
        { id: 3, text: "第三句" }
      ],
      context: { code: "TEST", title: "", genres: [], previous: [], next: [] }
    });
    expect(result.translations).toEqual(["中文1", "中文2", "中文3"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("并行拆分一个翻译波次后仍按原始字幕顺序合并", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const prompt = JSON.parse(request.messages[1].content) as { cues: Array<{ id: number; anchor: string; ja: string }> };
      await new Promise((resolve) => setTimeout(resolve, prompt.cues[0].id === 1 ? 8 : 1));
      return new Response(JSON.stringify({
        message: {
          content: JSON.stringify({
            cues: prompt.cues.map((cue) => ({ id: cue.id, anchor: cue.anchor, zh: `中文${cue.id}` }))
          })
        }
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await translateContextualCuesIndividually({
      url: "http://localhost:11434",
      model: "qwen3.5:9b",
      timeoutMs: 1000,
      batchSize: 4,
      requestConcurrency: 2,
      cues: [
        { id: 1, text: "第一句" },
        { id: 2, text: "第二句" },
        { id: 3, text: "第三句" },
        { id: 4, text: "第四句" }
      ],
      context: { code: "TEST", title: "", genres: [], previous: [], next: [] }
    });
    expect(result.translations).toEqual(["中文1", "中文2", "中文3", "中文4"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("普通对白的单条兜底为空时重试一次，不把空字幕写入结果", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        message: { content: JSON.stringify({ cues: [{ id: 329, anchor: buildContextualCueAnchor("なー俺 レディーファーストだろ ちゃんと"), zh: "" }] }) }
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: "" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: "我可是会女士优先的。" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await translateContextuallyWithOllama({
      url: "http://localhost:11434",
      model: "qwen3.5:9b",
      timeoutMs: 1000,
      cues: [{ id: 329, text: "なー俺 レディーファーストだろ ちゃんと" }],
      context: {
        code: "HUBLK-062",
        title: "",
        genres: [],
        previous: ["女性かわいそうじゃねー"],
        next: ["ほら早く脱いで"]
      }
    });
    expect(result.translations).toEqual(["我可是会女士优先的。"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retryBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as { prompt: string };
    expect(retryBody.prompt).toContain("必须输出非空的中文译文");
  });

  it("单条兜底超长时用严格长度提示重试，而不是让整部字幕失败", async () => {
    const overlong = "这是一段错误合并了相邻对白的超长译文，不能把后面的台词一起写进来，请只保留当前这一句的意思，不要继续扩写。";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        message: { content: JSON.stringify({
          cues: [{ id: 72, anchor: buildContextualCueAnchor("困りますか"), zh: overlong }]
        }) }
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: overlong }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: "你为难吗？" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await translateContextuallyWithOllama({
      url: "http://localhost:11434",
      model: "qwen3.5:9b",
      fallbackModel: "hy-mt1.5:7b-q4",
      timeoutMs: 1000,
      cues: [{ id: 72, text: "困りますか" }],
      context: { code: "VDD-104", title: "", genres: [], previous: [], next: [] }
    });
    expect(result.translations).toEqual(["你为难吗？"]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retryBody = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as { prompt: string };
    expect(retryBody.prompt).toContain("超过单条字幕合理长度");
    expect(retryBody.prompt).toContain("最多 48 个汉字");
  });

  it("普通对白连续为空时改用无上下文极简提示完成第三次重试", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        message: { content: JSON.stringify({ cues: [{ id: 303, anchor: buildContextualCueAnchor("そっとおっしゃってさ"), zh: "" }] }) }
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: "" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: "" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: "还轻声说了呢。" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await translateContextuallyWithOllama({
      url: "http://localhost:11434",
      model: "qwen3.5:9b",
      timeoutMs: 1000,
      cues: [{ id: 303, text: "そっとおっしゃってさ" }],
      context: { code: "HUBLK-062", title: "", genres: [], previous: [], next: [] }
    });
    expect(result.translations).toEqual(["还轻声说了呢。"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const finalRetryBody = JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)) as { prompt: string };
    expect(finalRetryBody.prompt).toContain("原句口语化、残缺或含糊");
    expect(finalRetryBody.prompt).not.toContain("前文：");
  });

  it("主模型三次仍为空时只对该句使用专用翻译模型兜底", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        message: { content: JSON.stringify({ cues: [{ id: 329, anchor: buildContextualCueAnchor("なー俺 レディーファーストだろ ちゃんと"), zh: "" }] }) }
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: "" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: "" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: "" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ response: "我可是会女士优先的。" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await translateContextuallyWithOllama({
      url: "http://localhost:11434",
      model: "qwen3.5:9b",
      fallbackModel: "hy-mt1.5:7b-q4",
      timeoutMs: 1000,
      cues: [{ id: 329, text: "なー俺 レディーファーストだろ ちゃんと" }],
      context: { code: "HUBLK-062", title: "", genres: [], previous: [], next: [] }
    });
    expect(result.translations).toEqual(["我可是会女士优先的。"]);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const fallbackBody = JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)) as { model: string; prompt: string };
    expect(fallbackBody.model).toBe("hy-mt1.5:7b-q4");
    expect(fallbackBody.prompt).toContain("日文：なー俺 レディーファーストだろ ちゃんと");
  });
});
