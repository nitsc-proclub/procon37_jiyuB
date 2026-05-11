import React, { useEffect, useRef, useState } from "react";
import PaintCanvas from "./components/PaintCanvas";
import { getDemoRecord, listDemoRecords, saveDemoRecord } from "./services/demoRecordService";
import { generateEkakiUta } from "./services/geminiService";
import { buildSingingScore, createSingingSeed } from "./services/melodyService";
import { synthesizeSingingVoice, VoicevoxProgressStage } from "./services/voicevoxService";
import { DemoRecordSummary, DrawingData, LyricsResponse, SingingScore } from "./types";

const isBlobUrl = (value: string | null) => !!value && value.startsWith("blob:");

type AppView = "maker" | "demoRecords" | "melodyExperiment";
type DemoBrowseMode = "drawings" | "songs";

const EXPERIMENT_LYRICS: LyricsResponse = {
  title: "ネコの絵描き歌",
  lines: [
    "お山が二つ ありました",
    "縦棒二本 目が出てね",
    "なみなみお口 描いたなら",
    "おヒゲをぴっぴで ネコですよ",
  ],
  singingKanaLines: [
    "おやまがふたつ ありました",
    "たてぼうにほん めがでてね",
    "なみなみおくち かいたなら",
    "おひげをぴっぴで ねこですよ",
  ],
  identifiedObject: "ネコ",
  modelName: "fixed-experiment-lyrics",
};

const getProgressTickDelay = (currentValue: number) => {
  if (currentValue < 50) {
    return 180;
  }

  if (currentValue < 75) {
    return 90;
  }

  if (currentValue < 92) {
    return 130;
  }

  if (currentValue < 97) {
    return 700;
  }

  return 900;
};

const getProgressStep = (currentValue: number, targetValue: number) => {
  const difference = targetValue - currentValue;

  if (currentValue < 50) {
    return 1;
  }

  if (currentValue < 75) {
    return difference > 8 ? 2 : 1;
  }

  return 1;
};

const App: React.FC = () => {
  const [lyrics, setLyrics] = useState<LyricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [shouldAutoplay, setShouldAutoplay] = useState(false);
  const [progressValue, setProgressValue] = useState(0);
  const [progressTarget, setProgressTarget] = useState(0);
  const [saveToast, setSaveToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const [progressLabel, setProgressLabel] = useState("準備中...");
  const [participantAge, setParticipantAge] = useState<number | null>(6);
  const [isDataSavingEnabled, setIsDataSavingEnabled] = useState(true);
  const [appView, setAppView] = useState<AppView>("maker");
  const [demoBrowseMode, setDemoBrowseMode] = useState<DemoBrowseMode>("drawings");
  const [demoRecords, setDemoRecords] = useState<DemoRecordSummary[]>([]);
  const [isDemoRecordsLoading, setIsDemoRecordsLoading] = useState(false);
  const [demoRecordsError, setDemoRecordsError] = useState<string | null>(null);
  const [loadingDemoRecordId, setLoadingDemoRecordId] = useState<string | null>(null);
  const [selectedDemoDrawing, setSelectedDemoDrawing] = useState<DrawingData | null>(null);
  const [selectedDemoRecordId, setSelectedDemoRecordId] = useState<string | null>(null);
  const [experimentVariant, setExperimentVariant] = useState(0);
  const [experimentLyricsSource, setExperimentLyricsSource] = useState("fixed");
  const [experimentLyrics, setExperimentLyrics] = useState<LyricsResponse>(EXPERIMENT_LYRICS);
  const [experimentScore, setExperimentScore] = useState<SingingScore | null>(null);
  const [experimentAudioUrl, setExperimentAudioUrl] = useState<string | null>(null);
  const [experimentError, setExperimentError] = useState<string | null>(null);
  const [experimentProgressLabel, setExperimentProgressLabel] = useState("待機中");
  const [isExperimentGenerating, setIsExperimentGenerating] = useState(false);
  const [loadingExperimentRecordId, setLoadingExperimentRecordId] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement>(null);
  const audioUrlRef = useRef<string | null>(null);
  const experimentAudioRef = useRef<HTMLAudioElement>(null);
  const experimentAudioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (isBlobUrl(audioUrlRef.current)) {
        URL.revokeObjectURL(audioUrlRef.current);
      }

      if (isBlobUrl(experimentAudioUrlRef.current)) {
        URL.revokeObjectURL(experimentAudioUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (progressValue >= progressTarget) {
      return;
    }

    const timer = window.setTimeout(() => {
      setProgressValue((currentValue) => {
        if (currentValue >= progressTarget) {
          return currentValue;
        }

        const step = getProgressStep(currentValue, progressTarget);
        return Math.min(progressTarget, currentValue + step);
      });
    }, getProgressTickDelay(progressValue));

    return () => window.clearTimeout(timer);
  }, [progressTarget, progressValue]);

  useEffect(() => {
    if (!audioUrl || !shouldAutoplay || !audioRef.current) {
      return;
    }

    void audioRef.current.play().catch((playError) => {
      if (import.meta.env.DEV) {
        console.error("Failed to autoplay generated singing voice", playError);
      }
    });

    setShouldAutoplay(false);
  }, [audioUrl, shouldAutoplay]);

  useEffect(() => {
    if (!saveToast) {
      return;
    }

    const timer = window.setTimeout(() => setSaveToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [saveToast]);

  const loadDemoRecords = async () => {
    setIsDemoRecordsLoading(true);
    setDemoRecordsError(null);

    try {
      setDemoRecords(await listDemoRecords());
    } catch (loadError) {
      setDemoRecordsError(loadError instanceof Error ? loadError.message : "デモ記録を読み込めませんでした。");
    } finally {
      setIsDemoRecordsLoading(false);
    }
  };

  useEffect(() => {
    if ((appView !== "demoRecords" && appView !== "melodyExperiment") || demoRecords.length > 0 || isDemoRecordsLoading) {
      return;
    }

    void loadDemoRecords();
  }, [appView, demoRecords.length, isDemoRecordsLoading]);

  const replaceAudioUrl = (nextUrl: string | null) => {
    if (isBlobUrl(audioUrlRef.current)) {
      URL.revokeObjectURL(audioUrlRef.current);
    }

    audioUrlRef.current = nextUrl;
    setAudioUrl(nextUrl);
  };

  const replaceExperimentAudioUrl = (nextUrl: string | null) => {
    if (isBlobUrl(experimentAudioUrlRef.current)) {
      URL.revokeObjectURL(experimentAudioUrlRef.current);
    }

    experimentAudioUrlRef.current = nextUrl;
    setExperimentAudioUrl(nextUrl);
  };

  const stopAudioPlayback = () => {
    if (!audioRef.current) {
      return;
    }

    audioRef.current.pause();
    audioRef.current.currentTime = 0;
  };

  const stopExperimentAudioPlayback = () => {
    if (!experimentAudioRef.current) {
      return;
    }

    experimentAudioRef.current.pause();
    experimentAudioRef.current.currentTime = 0;
  };

  const resetAudioState = () => {
    stopAudioPlayback();
    replaceAudioUrl(null);
    setShouldAutoplay(false);
  };

  const handleSelectDemoRecord = async (recordId: string) => {
    setLoadingDemoRecordId(recordId);
    setDemoRecordsError(null);

    try {
      const demoRecord = await getDemoRecord(recordId);
      stopAudioPlayback();
      replaceAudioUrl(demoRecord.audioUrl);
      setShouldAutoplay(false);
      setLyrics(demoRecord.lyrics);
      setError(null);
      setProgressValue(0);
      setProgressTarget(0);
      setProgressLabel("準備中...");
      setParticipantAge(demoRecord.participantAge);
      setSelectedDemoDrawing(demoRecord.drawingData);
      setSelectedDemoRecordId(demoRecord.recordId);
      setAppView("maker");
      setSaveToast({ message: "デモ記録を読み込みました", tone: "success" });
    } catch (loadError) {
      setDemoRecordsError(loadError instanceof Error ? loadError.message : "デモ記録を読み込めませんでした。");
    } finally {
      setLoadingDemoRecordId(null);
    }
  };

  const startProgress = (label: string, target: number) => {
    setProgressValue(0);
    setProgressTarget(target);
    setProgressLabel(label);
  };

  const updateProgress = (label: string, target: number) => {
    setProgressLabel(label);
    setProgressTarget(target);
  };

  const finishProgress = async (label: string) => {
    setProgressLabel(label);
    setProgressValue(100);
    setProgressTarget(100);
    await new Promise((resolve) => window.setTimeout(resolve, 220));
  };

  const handleVoicevoxProgress = (stage: VoicevoxProgressStage) => {
    if (stage === "query_requested") {
      updateProgress("VOICEVOX に歌唱クエリを送信中...", 60);
      return;
    }

    if (stage === "query_ready") {
      updateProgress("歌唱クエリを受け取りました。音声を組み立てています...", 75);
      return;
    }

    if (stage === "synthesis_requested") {
      updateProgress("歌声を合成中...", 84);
      return;
    }

    updateProgress("仕上げ中...", 92);
  };

  const handleExperimentVoicevoxProgress = (stage: VoicevoxProgressStage) => {
    if (stage === "query_requested") {
      setExperimentProgressLabel("VOICEVOX に歌唱クエリを送信中...");
      return;
    }

    if (stage === "query_ready") {
      setExperimentProgressLabel("歌唱クエリを受け取りました。音声を組み立てています...");
      return;
    }

    if (stage === "synthesis_requested") {
      setExperimentProgressLabel("歌声を合成中...");
      return;
    }

    setExperimentProgressLabel("音声データを準備中...");
  };

  const handleGenerateExperimentVoice = async () => {
    const nextVariant = experimentVariant + 1;

    setExperimentVariant(nextVariant);
    setIsExperimentGenerating(true);
    setExperimentError(null);
    setExperimentProgressLabel("メロディを組み立てています...");
    stopExperimentAudioPlayback();
    replaceExperimentAudioUrl(null);

    try {
      const seed = createSingingSeed(experimentLyrics, nextVariant);
      const score = buildSingingScore(experimentLyrics, seed);
      setExperimentScore(score);

      const audioBlob = await synthesizeSingingVoice(score, handleExperimentVoicevoxProgress);
      const nextAudioUrl = URL.createObjectURL(audioBlob);
      replaceExperimentAudioUrl(nextAudioUrl);
      setExperimentProgressLabel("完成しました");

      window.setTimeout(() => {
        void experimentAudioRef.current?.play().catch((playError) => {
          if (import.meta.env.DEV) {
            console.error("Failed to autoplay experiment singing voice", playError);
          }
        });
      }, 0);
    } catch (generationError) {
      setExperimentError(generationError instanceof Error ? generationError.message : "実験用の歌声生成に失敗しました。");
      setExperimentProgressLabel("エラーで終了しました");
    } finally {
      setIsExperimentGenerating(false);
    }
  };

  const resetExperimentResult = () => {
    setExperimentVariant(0);
    setExperimentScore(null);
    setExperimentError(null);
    setExperimentProgressLabel("待機中");
    stopExperimentAudioPlayback();
    replaceExperimentAudioUrl(null);
  };

  const handleSelectExperimentLyrics = async (recordId: string) => {
    if (recordId === "fixed") {
      setExperimentLyricsSource("fixed");
      setExperimentLyrics(EXPERIMENT_LYRICS);
      resetExperimentResult();
      return;
    }

    setLoadingExperimentRecordId(recordId);
    setExperimentError(null);

    try {
      const demoRecord = await getDemoRecord(recordId);
      setExperimentLyricsSource(recordId);
      setExperimentLyrics(demoRecord.lyrics);
      resetExperimentResult();
    } catch (loadError) {
      setExperimentError(loadError instanceof Error ? loadError.message : "実験用の歌詞を読み込めませんでした。");
    } finally {
      setLoadingExperimentRecordId(null);
    }
  };

  const handleComplete = async (data: DrawingData) => {
    const startedAt = new Date().toISOString();
    let generatedLyrics: LyricsResponse | null = null;
    let generatedScore: SingingScore | null = null;
    let generatedAudioBlob: Blob | null = null;
    let generationErrorMessage: string | null = null;

    setIsGenerating(true);
    setError(null);
    setSaveToast(null);
    setSelectedDemoRecordId(null);
    setSelectedDemoDrawing(null);
    resetAudioState();
    startProgress("準備中...", 8);

    try {
      updateProgress("AI が絵を読み取って歌詞を考えています...", 50);
      generatedLyrics = await generateEkakiUta(data);
      setLyrics(generatedLyrics);

      updateProgress("メロディを組み立てています...", 55);
      const seed = createSingingSeed(generatedLyrics, 0);
      generatedScore = buildSingingScore(generatedLyrics, seed);

      generatedAudioBlob = await synthesizeSingingVoice(generatedScore, handleVoicevoxProgress);
      updateProgress("音声データを準備中...", 97);

      const nextAudioUrl = URL.createObjectURL(generatedAudioBlob);
      stopAudioPlayback();
      replaceAudioUrl(nextAudioUrl);
      setShouldAutoplay(true);

      await finishProgress("完成しました");
    } catch (generationError) {
      generationErrorMessage =
        generationError instanceof Error ? generationError.message : "歌の生成に失敗しました。";
      setError(generationErrorMessage);
      await finishProgress("エラーで終了しました");
    } finally {
      if (isDataSavingEnabled) {
        try {
          await saveDemoRecord({
            drawingData: data,
            lyrics: generatedLyrics,
            audioBlob: generatedAudioBlob,
            singingScore: generatedScore,
            error: generationErrorMessage,
            startedAt,
            participantAge,
            aiModel: generatedLyrics?.modelName ?? null,
          });
          setDemoRecords([]);
          setSaveToast({ message: "セーブ完了", tone: "success" });
        } catch (saveError) {
          if (import.meta.env.DEV) {
            console.error("Failed to save demo record", saveError);
          }
          setSaveToast({ message: "保存に失敗しました", tone: "error" });
        }
      } else {
        setSaveToast({ message: "保存オフ", tone: "success" });
      }

      setIsGenerating(false);
    }
  };

  const handleClear = () => {
    setLyrics(null);
    setError(null);
    setProgressValue(0);
    setProgressTarget(0);
    setSaveToast(null);
    setProgressLabel("準備中...");
    setSelectedDemoDrawing(null);
    setSelectedDemoRecordId(null);
    resetAudioState();
  };

  const experimentPitchedNotes = experimentScore?.notes.filter((note) => note.key !== null) ?? [];
  const experimentLastKey = experimentPitchedNotes.at(-1)?.key ?? null;
  const experimentTotalFrames = experimentScore?.notes.reduce((sum, note) => sum + note.frame_length, 0) ?? 0;

  return (
    <div className="min-h-screen bg-gradient-to-b from-amber-50 via-yellow-50 to-orange-100 p-4 md:p-8 flex flex-col items-center">
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="fixed left-4 top-4 z-[80] flex h-12 w-12 items-center justify-center rounded-full border border-white/70 bg-white/90 text-orange-500 shadow-lg backdrop-blur-md transition-all hover:bg-orange-50 active:scale-95"
        title="再読み込み"
        aria-label="再読み込み"
      >
        <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M20 7v5h-5"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M4 17a8 8 0 0 0 13.66 2.34L20 17"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M4 7a8 8 0 0 1 13.66-2.34L20 7"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      <div className="fixed right-4 top-4 z-40 flex items-center gap-3 rounded-full border border-white/70 bg-white/80 px-4 py-2 shadow-lg backdrop-blur-md">
        <span className="text-sm font-bold text-gray-700">データ保存</span>
        <button
          type="button"
          role="switch"
          aria-checked={isDataSavingEnabled}
          onClick={() => setIsDataSavingEnabled((enabled) => !enabled)}
          className={`relative h-8 w-14 rounded-full transition-colors ${
            isDataSavingEnabled ? "bg-orange-400" : "bg-gray-300"
          }`}
          title="データ保存オン/オフ"
        >
          <span
            className={`absolute left-0 top-1 h-6 w-6 rounded-full bg-white shadow-md transition-transform ${
              isDataSavingEnabled ? "translate-x-7" : "translate-x-1"
            }`}
          />
        </button>
        <span className="w-8 text-sm font-black text-gray-700">{isDataSavingEnabled ? "ON" : "OFF"}</span>
      </div>

      <header className="mb-4 text-center">
        <h1 className="text-2xl md:text-3xl font-bold text-orange-600 drop-shadow-sm">お絵かき歌メーカー</h1>
        <p className="text-sm text-gray-600 font-medium">絵を描くと、AI が歌詞を作り、ずんだもん（VOICEVOX）が歌ってくれます！</p>
        <div className="mt-4 inline-flex rounded-full border border-white/70 bg-white/80 p-1 shadow-md backdrop-blur-md">
          <button
            type="button"
            onClick={() => setAppView("maker")}
            className={`rounded-full px-5 py-2 text-sm font-black transition-all ${
              appView === "maker" ? "bg-orange-400 text-white shadow-sm" : "text-gray-600 hover:bg-orange-50"
            }`}
          >
            メーカー
          </button>
          <button
            type="button"
            onClick={() => setAppView("melodyExperiment")}
            className={`rounded-full px-5 py-2 text-sm font-black transition-all ${
              appView === "melodyExperiment" ? "bg-orange-400 text-white shadow-sm" : "text-gray-600 hover:bg-orange-50"
            }`}
          >
            実験
          </button>
          <button
            type="button"
            onClick={() => setAppView("demoRecords")}
            className={`rounded-full px-5 py-2 text-sm font-black transition-all ${
              appView === "demoRecords" ? "bg-orange-400 text-white shadow-sm" : "text-gray-600 hover:bg-orange-50"
            }`}
          >
            デモ記録
          </button>
        </div>
      </header>

      {appView === "demoRecords" ? (
        <main className="mb-16 w-full max-w-6xl">
          <section className="rounded-3xl border-8 border-orange-100 bg-white p-5 shadow-xl md:p-7">
            <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-2xl font-black text-gray-800">demo-records</h2>
                <p className="text-sm font-semibold text-gray-500">保存済みのお絵描き歌を選ぶと、生成後の状態でメーカー画面に開きます。</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <div className="flex rounded-full bg-orange-50 p-1">
                  <button
                    type="button"
                    onClick={() => setDemoBrowseMode("drawings")}
                    className={`rounded-full px-4 py-2 text-sm font-black transition-all ${
                      demoBrowseMode === "drawings" ? "bg-white text-orange-600 shadow-sm" : "text-gray-500"
                    }`}
                  >
                    絵の一覧
                  </button>
                  <button
                    type="button"
                    onClick={() => setDemoBrowseMode("songs")}
                    className={`rounded-full px-4 py-2 text-sm font-black transition-all ${
                      demoBrowseMode === "songs" ? "bg-white text-orange-600 shadow-sm" : "text-gray-500"
                    }`}
                  >
                    歌の一覧
                  </button>
                </div>
                <button
                  type="button"
                  onClick={loadDemoRecords}
                  disabled={isDemoRecordsLoading}
                  className="rounded-full border border-orange-100 bg-white px-4 py-2 text-sm font-black text-gray-600 shadow-sm transition-all hover:bg-orange-50 disabled:opacity-50"
                >
                  更新
                </button>
              </div>
            </div>

            {demoRecordsError && (
              <div className="mb-5 rounded-2xl border-2 border-red-200 bg-red-50 p-4 text-center font-bold text-red-700">
                {demoRecordsError}
              </div>
            )}

            {isDemoRecordsLoading ? (
              <div className="flex min-h-64 items-center justify-center text-lg font-black text-orange-400">
                読み込み中...
              </div>
            ) : demoRecords.length === 0 ? (
              <div className="flex min-h-64 items-center justify-center rounded-2xl border-4 border-dashed border-gray-200 text-center font-bold text-gray-400">
                表示できる成功デモ記録がまだありません。
              </div>
            ) : demoBrowseMode === "drawings" ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {demoRecords.map((record) => (
                  <button
                    key={record.recordId}
                    type="button"
                    onClick={() => void handleSelectDemoRecord(record.recordId)}
                    className="group overflow-hidden rounded-2xl border-2 border-yellow-100 bg-yellow-50 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-orange-200 hover:shadow-md disabled:opacity-60"
                    disabled={loadingDemoRecordId !== null}
                  >
                    <div className="aspect-square bg-white">
                      <img src={record.imageUrl} alt={record.title} className="h-full w-full object-contain" loading="lazy" />
                    </div>
                    <div className="p-3">
                      <p className="truncate text-sm font-black text-gray-800">{record.title}</p>
                      <p className="mt-1 truncate text-xs font-bold text-orange-500">{record.identifiedObject}</p>
                      {loadingDemoRecordId === record.recordId && (
                        <p className="mt-2 text-xs font-black text-gray-500">読み込み中...</p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="divide-y divide-orange-50 overflow-hidden rounded-2xl border-2 border-orange-100">
                {demoRecords.map((record) => (
                  <button
                    key={record.recordId}
                    type="button"
                    onClick={() => void handleSelectDemoRecord(record.recordId)}
                    className="flex w-full items-center justify-between gap-4 bg-white px-4 py-3 text-left transition-all hover:bg-orange-50 disabled:opacity-60"
                    disabled={loadingDemoRecordId !== null}
                  >
                    <span className="min-w-0 truncate text-base font-black text-gray-800">{record.title}</span>
                    <span className="shrink-0 text-xs font-bold text-gray-400">
                      {loadingDemoRecordId === record.recordId ? "読み込み中..." : record.identifiedObject}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </main>
      ) : appView === "melodyExperiment" ? (
        <main className="mb-16 grid w-full max-w-6xl grid-cols-1 gap-8 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          <section className="rounded-3xl border-8 border-orange-100 bg-white p-6 shadow-xl md:p-7">
            <div className="mb-5 border-b-2 border-orange-50 pb-4">
              <span className="inline-block rounded-full bg-orange-100 px-4 py-1 text-sm font-bold text-orange-600">
                {experimentLyricsSource === "fixed" ? "固定歌詞デモ" : "demo-records"}
              </span>
              <h2 className="mt-3 text-2xl font-black text-gray-800">{experimentLyrics.title}</h2>
              <p className="mt-1 text-sm font-semibold text-gray-500">
                Gemini を通さず、この歌詞だけでメロディ生成と歌声合成を試します。
              </p>
            </div>

            <label className="mb-5 block">
              <span className="mb-2 block text-sm font-black text-gray-600">実験する歌詞</span>
              <select
                value={experimentLyricsSource}
                onChange={(event) => void handleSelectExperimentLyrics(event.target.value)}
                disabled={loadingExperimentRecordId !== null || isExperimentGenerating}
                className="w-full rounded-2xl border-2 border-orange-100 bg-white px-4 py-3 text-sm font-bold text-gray-700 shadow-sm outline-none transition-all focus:border-orange-300 disabled:opacity-60"
              >
                <option value="fixed">固定デモ: {EXPERIMENT_LYRICS.title}</option>
                {demoRecords.map((record) => (
                  <option key={record.recordId} value={record.recordId}>
                    {record.title} / {record.identifiedObject}
                  </option>
                ))}
              </select>
              {loadingExperimentRecordId && (
                <span className="mt-2 block text-xs font-bold text-orange-500">読み込み中...</span>
              )}
            </label>

            <div className="space-y-4 text-center">
              {experimentLyrics.lines.map((line, index) => (
                <p key={`${line}-${index}`} className="text-xl font-bold leading-relaxed text-gray-700 md:text-2xl">
                  {line}
                </p>
              ))}
            </div>

            <div className="mt-6 rounded-2xl border-2 border-yellow-100 bg-yellow-50 p-4">
              <p className="mb-2 text-sm font-black text-gray-600">歌声合成用かな</p>
              <div className="space-y-1">
                {experimentLyrics.singingKanaLines?.map((line, index) => (
                  <p key={`${line}-${index}`} className="text-sm font-semibold text-gray-500">
                    {line}
                  </p>
                ))}
              </div>
            </div>
          </section>

          <section className="rounded-3xl border-8 border-orange-100 bg-white p-6 shadow-xl md:p-7">
            <div className="mb-5 flex flex-col gap-4 border-b-2 border-orange-50 pb-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-2xl font-black text-gray-800">メロディ実験</h2>
                <p className="text-sm font-semibold text-gray-500">押すたびに同じ歌詞の別 variant を生成します。</p>
              </div>
              <button
                type="button"
                onClick={() => void handleGenerateExperimentVoice()}
                disabled={isExperimentGenerating}
                className="rounded-full bg-orange-400 px-6 py-3 text-sm font-black text-white shadow-md transition-all hover:bg-orange-500 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isExperimentGenerating ? "生成中..." : "生成して聴く"}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="rounded-2xl bg-orange-50 p-4 text-center">
                <p className="text-xs font-black text-orange-500">variant</p>
                <p className="mt-1 text-2xl font-black text-gray-800">{experimentVariant}</p>
              </div>
              <div className="rounded-2xl bg-yellow-50 p-4 text-center">
                <p className="text-xs font-black text-orange-500">notes</p>
                <p className="mt-1 text-2xl font-black text-gray-800">{experimentScore?.notes.length ?? 0}</p>
              </div>
              <div className="rounded-2xl bg-orange-50 p-4 text-center">
                <p className="text-xs font-black text-orange-500">frames</p>
                <p className="mt-1 text-2xl font-black text-gray-800">{experimentTotalFrames}</p>
              </div>
              <div className="rounded-2xl bg-yellow-50 p-4 text-center">
                <p className="text-xs font-black text-orange-500">last key</p>
                <p className="mt-1 text-2xl font-black text-gray-800">{experimentLastKey ?? "-"}</p>
              </div>
            </div>

            <div className="mt-5 rounded-3xl border-2 border-yellow-100 bg-yellow-50/80 p-5">
              <p className="mb-3 text-sm font-black text-gray-600">{experimentProgressLabel}</p>
              <audio ref={experimentAudioRef} src={experimentAudioUrl ?? undefined} controls className="w-full" />
            </div>

            {experimentError && (
              <div className="mt-4 rounded-2xl border-2 border-red-200 bg-red-50 p-4 text-center font-bold text-red-700">
                エラー: {experimentError}
              </div>
            )}

            {experimentScore && (
              <div className="mt-5 overflow-hidden rounded-2xl border-2 border-orange-100">
                <div className="grid grid-cols-[1fr_1fr_1fr] bg-orange-50 px-4 py-2 text-xs font-black text-orange-600">
                  <span>lyric</span>
                  <span>key</span>
                  <span>frame</span>
                </div>
                <div className="max-h-72 divide-y divide-orange-50 overflow-auto bg-white">
                  {experimentScore.notes.map((note, index) => (
                    <div
                      key={`${note.lyric}-${note.key ?? "rest"}-${note.frame_length}-${index}`}
                      className="grid grid-cols-[1fr_1fr_1fr] px-4 py-2 text-sm font-semibold text-gray-600"
                    >
                      <span>{note.lyric || "休符"}</span>
                      <span>{note.key ?? "-"}</span>
                      <span>{note.frame_length}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </main>
      ) : (
      <main className="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-8 items-start mb-16">
        <section className="min-w-0">
          <PaintCanvas
            onComplete={handleComplete}
            onClear={handleClear}
            isGenerating={isGenerating}
            age={participantAge}
            onAgeChange={setParticipantAge}
            isAgeSelectorVisible={isDataSavingEnabled}
            initialDrawing={selectedDemoDrawing}
          />

          {error && (
            <div className="mt-4 p-4 bg-red-100 border-2 border-red-200 text-red-700 rounded-xl font-bold text-center">
              エラー: {error}
            </div>
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-6">
          {lyrics || isGenerating ? (
            <div className="bg-white p-8 rounded-3xl shadow-xl border-8 border-orange-100 animate-fade-in relative min-h-[400px]">
              {isGenerating ? (
                <div className="flex h-full min-h-[340px] flex-col items-center justify-center text-center">
                  <div className="mb-6 text-6xl font-black text-orange-400 tabular-nums">{progressValue}%</div>
                  <div className="h-4 w-full max-w-md overflow-hidden rounded-full bg-orange-100">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-orange-400 via-yellow-400 to-pink-400 transition-[width] duration-200 ease-out"
                      style={{ width: `${progressValue}%` }}
                    />
                  </div>
                  <p className="mt-5 text-lg font-bold text-gray-700">{progressLabel}</p>
                </div>
              ) : lyrics ? (
                <>
                  <div className="mb-6 text-center border-b-2 border-orange-50 pb-4">
                    <span className="inline-block px-4 py-1 bg-orange-100 text-orange-600 rounded-full text-sm font-bold mb-2">
                      {lyrics.identifiedObject}
                    </span>
                    <h2 className="text-3xl font-bold text-gray-800">{lyrics.title}</h2>
                    {selectedDemoRecordId && (
                      <p className="mt-2 text-xs font-bold text-gray-400">demo-records から読み込み済み</p>
                    )}
                  </div>

                  <div className="space-y-4 text-center">
                    {lyrics.lines.map((line, index) => (
                      <p key={`${line}-${index}`} className="text-xl md:text-2xl text-gray-700 leading-relaxed font-medium">
                        {line}
                      </p>
                    ))}
                  </div>

                  <div className="mt-8 rounded-3xl border-2 border-yellow-100 bg-yellow-50/80 p-5">
                    <audio ref={audioRef} src={audioUrl ?? undefined} controls className="w-full" />
                  </div>

                  {lyrics.modelName && (
                    <p className="mt-3 text-right text-xs font-bold text-gray-400">
                      model: {lyrics.modelName}
                    </p>
                  )}
                </>
              ) : null}
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center p-12 bg-white/50 border-4 border-dashed border-gray-300 rounded-3xl text-gray-400 text-center">
              <div className="text-6xl mb-4 animate-bounce">♪</div>
              <p className="text-xl font-bold">
                左のキャンバスに絵を描いてください。
                <br />
                歌詞づくりから歌声生成までまとめて進みます。
              </p>
            </div>
          )}
        </section>
      </main>
      )}

      <footer className="mt-auto text-gray-400 text-sm font-medium pb-8 text-center">
        <p>&copy; 2026 お絵かき歌メーカー</p>
      </footer>

      {saveToast && (
        <div
          className={`fixed bottom-5 left-1/2 z-[60] -translate-x-1/2 rounded-full px-5 py-2 text-sm font-bold shadow-lg backdrop-blur-md animate-save-toast ${
            saveToast.tone === "success" ? "bg-gray-900/75 text-white" : "bg-red-600/80 text-white"
          }`}
        >
          {saveToast.message}
        </div>
      )}

      <style>{`
        @keyframes fade-in {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .animate-fade-in {
          animation: fade-in 0.6s ease-out forwards;
        }

        @keyframes save-toast {
          0% {
            opacity: 0;
            transform: translate(-50%, 8px);
          }
          12%,
          82% {
            opacity: 1;
            transform: translate(-50%, 0);
          }
          100% {
            opacity: 0;
            transform: translate(-50%, 8px);
          }
        }

        .animate-save-toast {
          animation: save-toast 2.6s ease-in-out forwards;
        }
      `}</style>
    </div>
  );
};

export default App;
