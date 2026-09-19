import React, { useCallback, useEffect, useRef, useState } from "react";
import PaintCanvas, { DrawingMetrics } from "./components/PaintCanvas";
import KaraokeLyricsPanel from "./components/KaraokeLyricsPanel";
import PrintLayout from "./components/PrintLayout";
import GenerationJourney from "./components/GenerationJourney";
import Turnstile, { TurnstileHandle, TurnstileStatus } from "./components/Turnstile";
import DebugExportDialog from "./components/DebugExportDialog";
import EvaluationConsentModal from "./components/EvaluationConsentModal";
import CreationArchiveManager from "./components/CreationArchiveManager";
import EvaluationFollowUpModal, { EvaluationFollowUpAnswers } from "./components/EvaluationFollowUpModal";
import DebugHistoryView from "./components/DebugHistoryView";
import VoicevoxServerSelector from "./components/VoicevoxServerSelector";
import { DrawingDisplayMode } from "./components/DrawingPlaybackCanvas";
import { appConfig, appFeatures } from "./config/appConfig";
import { appBuildId } from "./config/buildInfo";
import { getDrawingAnimationEndProgress, getScoreFrameLength, getSingingLineCount } from "./utils/playbackTiming";
import { deleteDemoRecord, getDemoRecord, getGenerationTimingEstimate, listDemoRecords, recordGeneration, saveDemoRecord, saveGenerationTiming, setDemoRecordFavorite } from "./services/demoRecordService";
import { GenerateEkakiUtaError, generateEkakiUta } from "./services/geminiService";
import { buildDebugBundleArtifacts, createDebugBundle, createDebugBundleFromArtifacts, createDebugRecordId, DebugBundleArtifacts, DebugBundleSource, downloadDebugBundle } from "./services/debugBundleService";
import { DebugHistoryRecord, saveDebugHistoryRecord } from "./services/debugHistoryDb";
import { createEvaluationDraft, createGenerationId, getInitialPreviewCandidate, isComparableCandidateSet, saveEvaluationDraft, shuffleCandidateIds, withEvaluationDraftState } from "./services/evaluationDraftDb";
import { buildEvaluationSubmission, submitEvaluation } from "./services/evaluationSubmissionService";
import { buildEvaluationFollowUpSubmission, submitEvaluationFollowUp } from "./services/evaluationFollowUpService";
import { CREATION_ARCHIVE_CONSENT_VERSION, downloadCreationArchiveDeletionReceiptBlob, startCreationArchive, type CreationArchiveSnapshot } from "./services/creationArchiveService";
import { buildSingingScore, createSingingSeed } from "./services/melodyService";
import { createSilentPlaybackAudio } from "./services/silentPlaybackService";
import { groupStrokes } from "./services/strokeGroupingService";
import { analyzeAccentLines } from "./services/voicevoxAccentService";
import {
  getDirectVoicevoxBaseUrl,
  isDevelopmentVoicevox,
  probeVoicevox,
  resetVoicevoxConnection,
  setDirectVoicevoxBaseUrl,
} from "./services/voicevoxHttp";
import { checkVoicevoxServerVersion } from "./services/voicevoxHealthService";
import {
  getVoicevoxServerLabel,
  normalizeVoicevoxServerId,
  VOICEVOX_SERVER_SELECTION_STORAGE_KEY,
  VoicevoxResolvedServerId,
  VoicevoxServerHealth,
  VoicevoxServerId,
} from "./services/voicevoxRouting";
import { synthesizeSingingVoice, VoicevoxProgressStage } from "./services/voicevoxService";
import { registerVoicevoxJobGroup, waitForVoicevoxJobs, voicevoxJobAudioUrl, cancelVoicevoxJobGroup } from "./services/voicevoxJobService";
import { DemoRecordSummary, DrawingAnalysis, DrawingData, DrawingSubjectFeedbackChoice, EvaluationCentralConsent, EvaluationDraft, EvaluationSelection, EvaluationStructuredRatings, GenerationTimingDurations, GenerationTimingEstimate, GenerationTimingPhase, LyricsCandidate, LyricsResponse, Phase1ModelInfo, SingingScore } from "./types";

const isBlobUrl = (value: string | null) => !!value && value.startsWith("blob:");

const fetchSeekableAudioUrl = async (audioUrl: string) => {
  const response = await fetch(audioUrl);
  if (!response.ok) {
    throw new Error(`Failed to load demo audio (${response.status})`);
  }

  const audioBlob = await response.blob();
  if (audioBlob.size === 0) {
    throw new Error("Demo audio was empty");
  }

  return URL.createObjectURL(audioBlob);
};

type AppView = "maker" | "demoRecords" | "debugHistory" | "melodyExperiment" | "print";
type DemoBrowseMode = "drawings" | "songs";
type PlaybackKind = "voice" | "animation-only";
type VoicevoxConnectionStatus = "idle" | "checking" | "connected" | "unavailable";
type MakerScene = "draw" | "generate" | "playback";
type GenerationFailureDisplay = {
  label: "安全確認設定" | "安全確認失敗" | "安全確認を利用できません" | "AI生成失敗";
  message: string;
  diagnosticCode: string;
};
type DebugExportSource = DebugBundleSource;
type GenerationRecordOptions = {
  shouldRecord: boolean;
  participantAge: number | null;
};

const PARTICIPANT_AGE_OPTIONS = Array.from({ length: 100 }, (_, index) => index);

const useMediaQueryAny = (queries: string[]) => {
  const getMatches = () => typeof window !== "undefined" && queries.some((query) => window.matchMedia(query).matches);
  const [matches, setMatches] = useState(getMatches);

  useEffect(() => {
    const mediaQueries = queries.map((query) => window.matchMedia(query));
    const updateMatches = () => setMatches(mediaQueries.some((mediaQuery) => mediaQuery.matches));

    updateMatches();
    mediaQueries.forEach((mediaQuery) => mediaQuery.addEventListener("change", updateMatches));
    return () => mediaQueries.forEach((mediaQuery) => mediaQuery.removeEventListener("change", updateMatches));
  }, [queries]);

  return matches;
};
type CandidatePlaybackCache = {
  score: SingingScore;
  audioBlob: Blob;
  playbackKind: PlaybackKind;
  voicevoxWarning: string | null;
  voicevoxServer: VoicevoxResolvedServerId | null;
};

const COMPACT_MAKER_LAYOUT_QUERIES = [
  "(max-width: 1023px) and (orientation: portrait)",
  "(max-width: 1023px) and (max-height: 600px)",
];
const COMPACT_PORTRAIT_LAYOUT_QUERIES = ["(max-width: 1023px) and (orientation: portrait)"];
const getGenerationFailureDisplay = (error: unknown): GenerationFailureDisplay => {
  if (error instanceof GenerateEkakiUtaError) {
    const isTurnstileStage = error.stage === "turnstile" || error.code?.startsWith("turnstile-");
    if (error.code === "turnstile-config") {
      return {
        label: "安全確認設定",
        message: "サイトの安全確認の設定に問題があります。管理する人に、この診断コードを伝えてください。",
        diagnosticCode: "TS-CONFIG",
      };
    }
    if (error.code === "turnstile-action-mismatch") {
      return {
        label: "安全確認設定",
        message: "サイトの安全確認の設定に問題があります。管理する人に、この診断コードを伝えてください。",
        diagnosticCode: "TS-ACTION",
      };
    }
    if (error.code === "turnstile-hostname-mismatch") {
      return {
        label: "安全確認設定",
        message: "サイトの安全確認の設定に問題があります。管理する人に、この診断コードを伝えてください。",
        diagnosticCode: "TS-HOST",
      };
    }
    if (error.code === "turnstile-unavailable") {
      return {
        label: "安全確認を利用できません",
        message: "少し待ってから、もう一度ためしてみてね。",
        diagnosticCode: "TS-SERVICE",
      };
    }
    if (isTurnstileStage) {
      return {
        label: "安全確認失敗",
        message: "安全確認をやりなおしてから、もう一度ためしてみてね。",
        diagnosticCode: "TS-VERIFY",
      };
    }
  }

  return {
    label: "AI生成失敗",
    message: "少し待ってから、絵にもどってもう一度ためしてみてね。",
    diagnosticCode: "AI-GENERATE",
  };
};

const VOICEVOX_BASE_URL_STORAGE_KEY = "ekaki-uta:voicevox-base-url";
const TURNSTILE_ACTION = "generate-ekaki-uta";
const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() ?? "";
const EVALUATION_EXPERIMENT_ROUND_ID = import.meta.env.VITE_EVALUATION_EXPERIMENT_ROUND_ID?.trim() || null;

const loadVoicevoxBaseUrl = () => {
  try {
    const savedBaseUrl = window.localStorage.getItem(VOICEVOX_BASE_URL_STORAGE_KEY);
    return savedBaseUrl ? setDirectVoicevoxBaseUrl(savedBaseUrl) : getDirectVoicevoxBaseUrl();
  } catch {
    return getDirectVoicevoxBaseUrl();
  }
};

const loadVoicevoxServerSelection = (): VoicevoxServerId => {
  try {
    return normalizeVoicevoxServerId(window.localStorage.getItem(VOICEVOX_SERVER_SELECTION_STORAGE_KEY));
  } catch {
    return "auto";
  }
};

type GenerationCompletionWaiter = {
  runKey: number;
  resolve: () => void;
};

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

const NOTE_LABELS: Record<number, string> = {
  60: "ド",
  64: "ミ",
  65: "ファ",
  67: "ソ",
};

const getExperimentNoteLabel = (key: number | null) => {
  if (key === null) {
    return "休符";
  }

  return NOTE_LABELS[key] ?? `key ${key}`;
};

const getExperimentNoteToneClass = (key: number | null) => {
  if (key === null) {
    return "border-gray-200 bg-gray-100 text-gray-500";
  }

  if (key === 60) {
    return "border-rose-200 bg-rose-50 text-rose-700";
  }

  if (key === 64) {
    return "border-orange-200 bg-orange-50 text-orange-700";
  }

  if (key === 65) {
    return "border-amber-200 bg-amber-50 text-amber-700";
  }

  return "border-emerald-200 bg-emerald-50 text-emerald-700";
};

const getExperimentNoteWidth = (frameLength: number) => Math.max(44, Math.min(150, frameLength * 1.85));

const serializeSingingScore = (score: SingingScore | null) => JSON.stringify(score, null, 2);

const sanitizeFileName = (value: string) =>
  value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "voicevox-score";

const copyTextToClipboard = async (text: string) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const success = document.execCommand("copy");
  document.body.removeChild(textarea);

  if (!success) {
    throw new Error("クリップボードにコピーできませんでした。");
  }
};

const downloadTextFile = (fileName: string, content: string, mimeType: string) => {
  const blob = new Blob([content], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = objectUrl;
  link.download = fileName;
  link.click();

  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
};

const isEditableAppKeyboardTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable || tagName === "input" || tagName === "textarea" || tagName === "select";
};

type ShortcutItem = {
  keys: string;
  description: string;
  requiresBackend?: boolean;
};

type ShortcutGroup = {
  title: string;
  items: ShortcutItem[];
  requiresBackend?: boolean;
};

const APP_SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "共通",
    items: [
      { keys: "Ctrl/Cmd + 1", description: "メーカーに切り替え" },
      { keys: "Ctrl/Cmd + 2", description: "実験に切り替え", requiresBackend: true },
      { keys: "Ctrl/Cmd + 3", description: "デモ記録に切り替え", requiresBackend: true },
      { keys: "Ctrl/Cmd + /", description: "この一覧を開閉" },
      { keys: "Esc", description: "一覧や確認ダイアログを閉じる" },
    ],
  },
  {
    title: "メーカー",
    items: [
      { keys: "Enter", description: "歌をつくる", requiresBackend: true },
      { keys: "Ctrl/Cmd + S", description: "歌をつくる", requiresBackend: true },
      { keys: "Ctrl/Cmd + Z", description: "ひとつ戻す" },
      { keys: "Ctrl/Cmd + Y", description: "ひとつ進める" },
      { keys: "Ctrl/Cmd + Shift + Z", description: "ひとつ進める" },
      { keys: "Delete / Backspace", description: "ぜんぶ消す" },
    ],
  },
  {
    title: "確認ダイアログ",
    items: [
      { keys: "Enter", description: "決定" },
      { keys: "Esc", description: "キャンセル" },
    ],
  },
  {
    title: "実験",
    requiresBackend: true,
    items: [
      { keys: "Ctrl/Cmd + Enter", description: "生成して聴く" },
    ],
  },
  {
    title: "デモ記録",
    requiresBackend: true,
    items: [
      { keys: "D", description: "絵の一覧に切り替え" },
      { keys: "S", description: "歌の一覧に切り替え" },
      { keys: "R", description: "記録を更新" },
    ],
  },
];

const App: React.FC = () => {
  const [lyrics, setLyrics] = useState<LyricsResponse | null>(null);
  const [generatedLyricsCandidates, setGeneratedLyricsCandidates] = useState<LyricsCandidate[] | null>(null);
  const [generatedDrawingAnalysis, setGeneratedDrawingAnalysis] = useState<DrawingAnalysis | null>(null);
  const [generatedPhase1ModelInfo, setGeneratedPhase1ModelInfo] = useState<Phase1ModelInfo | null>(null);
  const [candidateDisplayOrder, setCandidateDisplayOrder] = useState<LyricsCandidate["candidateId"][]>([]);
  const [previewCandidateId, setPreviewCandidateId] = useState<LyricsCandidate["candidateId"] | null>(null);
  const [evaluationSelection, setEvaluationSelection] = useState<EvaluationSelection>(null);
  const [isFirstImpressionOpen, setIsFirstImpressionOpen] = useState(false);
  const [isEvaluationConsentOpen, setIsEvaluationConsentOpen] = useState(false);
  const [evaluationGenerationId, setEvaluationGenerationId] = useState<string | null>(null);
  const [evaluationReceipt, setEvaluationReceipt] = useState<string | null>(null);
  const [evaluationReceiptExpiresAt, setEvaluationReceiptExpiresAt] = useState<string | null>(null);
  const [isEvaluationSubmissionPending, setIsEvaluationSubmissionPending] = useState(false);
  const [finalPreferenceSelection, setFinalPreferenceSelection] = useState<EvaluationSelection>(null);
  const [subjectFeedbackChoice, setSubjectFeedbackChoice] = useState<DrawingSubjectFeedbackChoice | null>(null);
  const [evaluationRatings, setEvaluationRatings] = useState<EvaluationStructuredRatings>({});
  const [isEvaluationFollowUpOpen, setIsEvaluationFollowUpOpen] = useState(false);
  const [followUpPreferencePrefill, setFollowUpPreferencePrefill] = useState<LyricsCandidate["candidateId"] | null>(null);
  const [isEvaluationFollowUpPending, setIsEvaluationFollowUpPending] = useState(false);
  const [isEvaluationCentrallySaved, setIsEvaluationCentrallySaved] = useState(false);
  const [isCreationArchiveManagerOpen, setIsCreationArchiveManagerOpen] = useState(false);
  const [hasAlternativePreviewed, setHasAlternativePreviewed] = useState(false);
  const [hasPlaybackStartedForGeneration, setHasPlaybackStartedForGeneration] = useState(false);
  const [isCandidatePreviewLoading, setIsCandidatePreviewLoading] = useState<LyricsCandidate["candidateId"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generationFailureDisplay, setGenerationFailureDisplay] = useState<GenerationFailureDisplay | null>(null);
  const [voicevoxWarning, setVoicevoxWarning] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileRetryKey, setTurnstileRetryKey] = useState(0);
  const [turnstileStatus, setTurnstileStatus] = useState<TurnstileStatus>(
    !import.meta.env.DEV && TURNSTILE_SITE_KEY ? "loading" : !import.meta.env.DEV ? "error" : "verified",
  );
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [playbackKind, setPlaybackKind] = useState<PlaybackKind>("animation-only");
  const [voicevoxConnectionStatus, setVoicevoxConnectionStatus] = useState<VoicevoxConnectionStatus>("idle");
  const [voicevoxConnectionMessage, setVoicevoxConnectionMessage] = useState("歌をつくる時に自動で確認します。");
  const [voicevoxBaseUrl, setVoicevoxBaseUrl] = useState(loadVoicevoxBaseUrl);
  const [voicevoxServerSelection, setVoicevoxServerSelection] = useState<VoicevoxServerId>(loadVoicevoxServerSelection);
  const [voicevoxServerHealth, setVoicevoxServerHealth] = useState<Partial<Record<VoicevoxServerId, VoicevoxServerHealth>>>({});
  const [voicevoxResolvedServer, setVoicevoxResolvedServer] = useState<VoicevoxResolvedServerId | null>(null);
  const [saveToast, setSaveToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const [progressLabel, setProgressLabel] = useState("準備中...");
  const [generationTimingEstimate, setGenerationTimingEstimate] = useState<GenerationTimingEstimate | null>(null);
  const [generationTimingRunKey, setGenerationTimingRunKey] = useState(0);
  const [generationProgressPhase, setGenerationProgressPhase] = useState<GenerationTimingPhase>("gemini");
  const [isGenerationProgressComplete, setIsGenerationProgressComplete] = useState(false);
  const [participantAge, setParticipantAge] = useState<number | null>(null);
  const [pendingGenerationData, setPendingGenerationData] = useState<DrawingData | null>(null);
  const [isRecordConsentOpen, setIsRecordConsentOpen] = useState(false);
  const [recordConsentError, setRecordConsentError] = useState<string | null>(null);
  const [appView, setAppView] = useState<AppView>("maker");
  const [demoBrowseMode, setDemoBrowseMode] = useState<DemoBrowseMode>("drawings");
  const [showFavoriteOnly, setShowFavoriteOnly] = useState(false);
  const [demoRecords, setDemoRecords] = useState<DemoRecordSummary[]>([]);
  const [isDemoRecordsLoading, setIsDemoRecordsLoading] = useState(false);
  const [demoRecordsError, setDemoRecordsError] = useState<string | null>(null);
  const [loadingDemoRecordId, setLoadingDemoRecordId] = useState<string | null>(null);
  const [updatingDemoRecordId, setUpdatingDemoRecordId] = useState<string | null>(null);
  const [deletingDemoRecordId, setDeletingDemoRecordId] = useState<string | null>(null);
  const [selectedDemoDrawing, setSelectedDemoDrawing] = useState<DrawingData | null>(null);
  const [selectedDemoRecordId, setSelectedDemoRecordId] = useState<string | null>(null);
  const [selectedDebugHistoryDrawing, setSelectedDebugHistoryDrawing] = useState<DrawingData | null>(null);
  const [generatedDrawing, setGeneratedDrawing] = useState<DrawingData | null>(null);
  const [playbackScore, setPlaybackScore] = useState<SingingScore | null>(null);
  const [drawingDisplayMode, setDrawingDisplayMode] = useState<DrawingDisplayMode>("animated");
  const [debugExportSource, setDebugExportSource] = useState<DebugExportSource | null>(null);
  const [debugExportArtifacts, setDebugExportArtifacts] = useState<DebugBundleArtifacts | null>(null);
  const [isDebugExportOpen, setIsDebugExportOpen] = useState(false);
  const [debugReporterNote, setDebugReporterNote] = useState("");
  const [isDebugBundleDownloading, setIsDebugBundleDownloading] = useState(false);
  const [debugBundleError, setDebugBundleError] = useState<string | null>(null);
  const [experimentVariant, setExperimentVariant] = useState(0);
  const [experimentLyricsSource, setExperimentLyricsSource] = useState("fixed");
  const [experimentLyrics, setExperimentLyrics] = useState<LyricsResponse>(EXPERIMENT_LYRICS);
  const [experimentScore, setExperimentScore] = useState<SingingScore | null>(null);
  const [experimentAudioUrl, setExperimentAudioUrl] = useState<string | null>(null);
  const [experimentError, setExperimentError] = useState<string | null>(null);
  const [experimentProgressLabel, setExperimentProgressLabel] = useState("待機中");
  const [isExperimentGenerating, setIsExperimentGenerating] = useState(false);
  const [loadingExperimentRecordId, setLoadingExperimentRecordId] = useState<string | null>(null);
  const [isShortcutHelpOpen, setIsShortcutHelpOpen] = useState(false);
  const [drawingMetrics, setDrawingMetrics] = useState<DrawingMetrics>({
    strokeCount: 0,
    pointCount: 0,
    drawingDurationMs: 0,
  });
  const [isInitialPlaybackPromptVisible, setIsInitialPlaybackPromptVisible] = useState(false);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [makerScene, setMakerScene] = useState<MakerScene>("draw");
  const [isSceneTurnAnimating, setIsSceneTurnAnimating] = useState(false);
  const [newSongResetKey, setNewSongResetKey] = useState(0);
  const isCompactMakerLayout = useMediaQueryAny(COMPACT_MAKER_LAYOUT_QUERIES);
  const isCompactPortraitLayout = useMediaQueryAny(COMPACT_PORTRAIT_LAYOUT_QUERIES);

  const audioRef = useRef<HTMLAudioElement>(null);
  const completionHeadingRef = useRef<HTMLHeadingElement>(null);
  const firstImpressionDialogRef = useRef<HTMLElement>(null);
  const recordConsentDialogRef = useRef<HTMLElement>(null);
  const recordConsentPrimaryButtonRef = useRef<HTMLButtonElement>(null);
  const generationRunRef = useRef(false);
  const generationSequenceRef = useRef(0);
  const voiceJobAbortRef = useRef<AbortController | null>(null);
  const generationTimingRunKeyRef = useRef(0);
  const generationCompletionWaiterRef = useRef<GenerationCompletionWaiter | null>(null);
  const turnstileWidgetRef = useRef<TurnstileHandle>(null);
  const turnstileTokenRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);
  const audioUrlRef = useRef<string | null>(null);
  const debugHistoryImageUrlRef = useRef<string | null>(null);
  const experimentAudioRef = useRef<HTMLAudioElement>(null);
  const experimentAudioUrlRef = useRef<string | null>(null);
  const sceneTurnTimerRef = useRef<number | null>(null);
  const candidatePlaybackCacheRef = useRef(new Map<LyricsCandidate["candidateId"], CandidatePlaybackCache>());
  const candidateActivationSequenceRef = useRef(0);
  const candidateActivationPromiseRef = useRef<Promise<DebugExportSource | null> | null>(null);
  const showPlaybackWhenCandidateReadyRef = useRef(false);
  const debugExportSourceRef = useRef<DebugExportSource | null>(null);
  // Kept only for the current generated song. These short-lived grants are
  // never written to localStorage, IndexedDB, demo records, or debug exports.
  const voicevoxGrantsRef = useRef<Partial<Record<LyricsCandidate["candidateId"], string>>>({});
  const evaluationDraftRef = useRef<EvaluationDraft | null>(null);
  const evaluationStorageConsentRef = useRef<EvaluationCentralConsent>("not-asked");
  const evaluationSaveSequenceRef = useRef(0);
  const evaluationDraftWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  // The ticket is held only for this newly-generated result and is never put
  // into debug exports, browser history, or archive assets.
  const archiveGenerationTicketRef = useRef<string | null>(null);
  const creationArchiveSnapshotRef = useRef<CreationArchiveSnapshot | null>(null);
  // Vite's development middleware is the only intentionally local API path.
  // Every built app can be served by the Worker, whose Gemini route validates
  // Turnstile regardless of VITE_APP_MODE, so it must provide a token.
  const isTurnstileRequired = !import.meta.env.DEV;

  const handleTurnstileToken = useCallback((token: string | null) => {
    turnstileTokenRef.current = token;
    setTurnstileToken(token);
  }, []);

  const handleTurnstileStatusChange = useCallback((status: TurnstileStatus) => {
    setTurnstileStatus(status);
    if (status === "expired") {
      window.setTimeout(() => turnstileWidgetRef.current?.reset(), 0);
    }
  }, []);

  const retryTurnstile = useCallback(() => {
    if (!TURNSTILE_SITE_KEY) return;
    handleTurnstileToken(null);
    setTurnstileStatus("loading");
    setTurnstileRetryKey((current) => current + 1);
    turnstileWidgetRef.current?.reset();
  }, [handleTurnstileToken]);

  const handleGenerationProgressDisplayComplete = (runKey: number) => {
    const waiter = generationCompletionWaiterRef.current;
    if (!waiter || waiter.runKey !== runKey) return;

    generationCompletionWaiterRef.current = null;
    waiter.resolve();
  };

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      generationRunRef.current = false;
      generationSequenceRef.current += 1;
      voiceJobAbortRef.current?.abort();
      candidateActivationSequenceRef.current += 1;
      candidatePlaybackCacheRef.current.clear();
      const completionWaiter = generationCompletionWaiterRef.current;
      generationCompletionWaiterRef.current = null;
      completionWaiter?.resolve();

      if (isBlobUrl(audioUrlRef.current)) {
        URL.revokeObjectURL(audioUrlRef.current);
      }

      if (isBlobUrl(debugHistoryImageUrlRef.current)) {
        URL.revokeObjectURL(debugHistoryImageUrlRef.current);
      }

      if (isBlobUrl(experimentAudioUrlRef.current)) {
        URL.revokeObjectURL(experimentAudioUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isGenerating || !lyrics || isInitialPlaybackPromptVisible) return;

    const frameId = window.requestAnimationFrame(() => {
      if (isCompactMakerLayout) {
        // The desktop completion heading is intentionally hidden in compact
        // playback. Keep the drawing in place and move keyboard focus to the
        // visible current lyric instead of scrolling to that hidden heading.
        const currentLyric = document.querySelector<HTMLButtonElement>(
          ".mobile-playback-lyrics button[data-mobile-current=\"true\"]",
        );
        currentLyric?.focus({ preventScroll: true });
        return;
      }

      completionHeadingRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [isCompactMakerLayout, isGenerating, isInitialPlaybackPromptVisible, lyrics]);

  useEffect(() => {
    if (!isRecordConsentOpen) return;
    const frameId = window.requestAnimationFrame(() => recordConsentPrimaryButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frameId);
  }, [isRecordConsentOpen]);

  useEffect(() => {
    if (!isFirstImpressionOpen) return;
    const frameId = window.requestAnimationFrame(() => {
      firstImpressionDialogRef.current?.querySelector<HTMLButtonElement>("button[data-first-impression-choice]")?.focus();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [isFirstImpressionOpen]);

  useEffect(() => {
    if (appView !== "maker" || !audioUrl) return;
    const makerAudio = audioRef.current;

    return () => {
      makerAudio?.pause();
      setIsAudioPlaying(false);
    };
  }, [appView, audioUrl]);

  useEffect(() => {
    const nextScene: MakerScene = isGenerating ? "generate" : lyrics || error ? "playback" : "draw";
    if (nextScene === makerScene) return;

    if (nextScene === "playback" && makerScene === "generate" && lyrics) {
      if (sceneTurnTimerRef.current !== null) window.clearTimeout(sceneTurnTimerRef.current);
      setIsSceneTurnAnimating(true);
      sceneTurnTimerRef.current = window.setTimeout(() => {
        sceneTurnTimerRef.current = null;
        setIsSceneTurnAnimating(false);
      }, 560);
    } else if (nextScene === "generate") {
      if (sceneTurnTimerRef.current !== null) window.clearTimeout(sceneTurnTimerRef.current);
      sceneTurnTimerRef.current = null;
      setIsSceneTurnAnimating(false);
    }

    setMakerScene(nextScene);
  }, [error, isGenerating, lyrics, makerScene]);

  useEffect(() => () => {
    if (sceneTurnTimerRef.current !== null) window.clearTimeout(sceneTurnTimerRef.current);
  }, []);

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

  const refreshDemoRecords = async () => {
    setDemoRecordsError(null);

    try {
      setDemoRecords(await listDemoRecords());
    } catch (loadError) {
      setDemoRecordsError(loadError instanceof Error ? loadError.message : "デモ記録を読み込めませんでした。");
    }
  };

  useEffect(() => {
    if (!appFeatures.demoRecords) {
      return;
    }

    if ((appView !== "demoRecords" && appView !== "melodyExperiment") || demoRecords.length > 0 || isDemoRecordsLoading) {
      return;
    }

    void loadDemoRecords();
  }, [appView, demoRecords.length, isDemoRecordsLoading]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isRecordConsentOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setIsRecordConsentOpen(false);
          setPendingGenerationData(null);
          setRecordConsentError(null);
        }
        return;
      }

      if (isFirstImpressionOpen) return;

      if (isInitialPlaybackPromptVisible) {
        return;
      }

      if (document.body.dataset.drawingFocusMode === "true") {
        return;
      }

      const key = event.key.toLowerCase();

      if (key === "escape" && isShortcutHelpOpen) {
        event.preventDefault();
        setIsShortcutHelpOpen(false);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && (key === "/" || key === "?")) {
        event.preventDefault();
        setIsShortcutHelpOpen((current) => !current);
        return;
      }

      if (!event.ctrlKey && !event.metaKey) {
        if (appView === "demoRecords") {
          if (key === "d") {
            event.preventDefault();
            setDemoBrowseMode("drawings");
            return;
          }

          if (key === "s") {
            event.preventDefault();
            setDemoBrowseMode("songs");
            return;
          }

          if (key === "r") {
            event.preventDefault();
            void loadDemoRecords();
          }
        }

        return;
      }

      if (isEditableAppKeyboardTarget(event.target)) {
        return;
      }

      if (
        key === "p" &&
        appView === "maker" &&
        lyrics &&
        (selectedDemoDrawing || generatedDrawing) &&
        !isGenerating
      ) {
        event.preventDefault();
        audioRef.current?.pause();
        setAppView("print");
        return;
      }

      if (key === "1") {
        event.preventDefault();
        setAppView("maker");
        setIsShortcutHelpOpen(false);
        return;
      }

      if (key === "2") {
        if (!appFeatures.voicevox || !isDevelopmentVoicevox()) return;
        event.preventDefault();
        setAppView("melodyExperiment");
        setIsShortcutHelpOpen(false);
        return;
      }

      if (key === "3") {
        if (!appFeatures.demoRecords) return;
        event.preventDefault();
        setAppView("demoRecords");
        setIsShortcutHelpOpen(false);
      }

      if (appView === "melodyExperiment" && key === "enter" && !isExperimentGenerating) {
        event.preventDefault();
        void handleGenerateExperimentVoice();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    appView,
    generatedDrawing,
    isExperimentGenerating,
    isFirstImpressionOpen,
    isGenerating,
    isInitialPlaybackPromptVisible,
    isRecordConsentOpen,
    isShortcutHelpOpen,
    loadDemoRecords,
    lyrics,
    selectedDemoDrawing,
  ]);

  const replaceAudioUrl = (nextUrl: string | null) => {
    if (isBlobUrl(audioUrlRef.current)) {
      URL.revokeObjectURL(audioUrlRef.current);
    }

    audioUrlRef.current = nextUrl;
    setAudioUrl(nextUrl);
  };

  const replaceDebugExportSource = (nextSource: DebugExportSource | null) => {
    debugExportSourceRef.current = nextSource;
    setDebugExportSource(nextSource);
  };

  const clearDebugHistoryDrawing = () => {
    if (isBlobUrl(debugHistoryImageUrlRef.current)) {
      URL.revokeObjectURL(debugHistoryImageUrlRef.current);
    }
    debugHistoryImageUrlRef.current = null;
    setSelectedDebugHistoryDrawing(null);
  };

  const clearCandidatePlaybackCache = () => {
    // Cancels any in-flight candidate synthesis. Cached Blobs do not need URL
    // cleanup; object URLs are created only for the active player and revoked
    // by replaceAudioUrl/resetAudioState.
    candidateActivationSequenceRef.current += 1;
    candidateActivationPromiseRef.current = null;
    showPlaybackWhenCandidateReadyRef.current = false;
    candidatePlaybackCacheRef.current.clear();
    setCandidateDisplayOrder([]);
    setPreviewCandidateId(null);
    setEvaluationSelection(null);
    setIsFirstImpressionOpen(false);
    evaluationStorageConsentRef.current = "not-asked";
    evaluationSaveSequenceRef.current += 1;
    evaluationDraftRef.current = null;
    archiveGenerationTicketRef.current = null;
    creationArchiveSnapshotRef.current = null;
    setIsEvaluationConsentOpen(false);
    setEvaluationGenerationId(null);
    setEvaluationReceipt(null);
    setEvaluationReceiptExpiresAt(null);
    setIsEvaluationSubmissionPending(false);
    setFinalPreferenceSelection(null);
    setSubjectFeedbackChoice(null);
    setEvaluationRatings({});
    setIsEvaluationFollowUpOpen(false);
    setFollowUpPreferencePrefill(null);
    setIsEvaluationFollowUpPending(false);
    setIsEvaluationCentrallySaved(false);
    setHasAlternativePreviewed(false);
    setHasPlaybackStartedForGeneration(false);
    setIsCandidatePreviewLoading(null);
  };

  const clearPhase1Generation = () => {
    voiceJobAbortRef.current?.abort();
    voiceJobAbortRef.current = null;
    setGeneratedLyricsCandidates(null);
    setGeneratedDrawingAnalysis(null);
    setGeneratedPhase1ModelInfo(null);
    clearCandidatePlaybackCache();
  };

  const renderModelInfo = () => {
    const voicevoxInfo = voicevoxResolvedServer
      ? `歌声生成: ${getVoicevoxServerLabel(voicevoxResolvedServer)}`
      : playbackKind === "animation-only"
        ? "歌声生成: なし（アニメーションのみ）"
        : null;

    if (generatedPhase1ModelInfo) {
      return (
        <p className="mt-3 text-right text-xs font-bold text-gray-400">
          画像読み込み: {generatedPhase1ModelInfo.drawingAnalysis}<br />
          歌詞生成: {generatedPhase1ModelInfo.lyricsGeneration}
          {voicevoxInfo && <><br />{voicevoxInfo}</>}
        </p>
      );
    }
    if (!lyrics?.modelName && !voicevoxInfo) return null;
    return (
      <p className="mt-3 text-right text-xs font-bold text-gray-400">
        {lyrics?.modelName && <>model: {lyrics.modelName}</>}
        {lyrics?.modelName && voicevoxInfo && <br />}
        {voicevoxInfo}
      </p>
    );
  };

  const replaceDebugHistoryDrawing = (drawing: DrawingData, imageBlob: Blob) => {
    clearDebugHistoryDrawing();
    const imageUri = URL.createObjectURL(imageBlob);
    debugHistoryImageUrlRef.current = imageUri;
    setSelectedDebugHistoryDrawing({ ...drawing, imageUri });
  };

  const replaceExperimentAudioUrl = (nextUrl: string | null) => {
    if (isBlobUrl(experimentAudioUrlRef.current)) {
      URL.revokeObjectURL(experimentAudioUrlRef.current);
    }

    experimentAudioUrlRef.current = nextUrl;
    setExperimentAudioUrl(nextUrl);
  };

  const stopAudioPlayback = () => {
    setIsAudioPlaying(false);
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
    setPlaybackKind("animation-only");
  };

  const handleSelectDemoRecord = async (recordId: string) => {
    setLoadingDemoRecordId(recordId);
    setDemoRecordsError(null);

    try {
      const demoRecord = await getDemoRecord(recordId);
      voicevoxGrantsRef.current = {};
      let nextAudioUrl = demoRecord.audioUrl;

      if (demoRecord.audioUrl) {
        try {
          nextAudioUrl = await fetchSeekableAudioUrl(demoRecord.audioUrl);
        } catch (audioLoadError) {
          if (import.meta.env.DEV) {
            console.warn("Failed to prepare seekable demo audio; using the original URL", audioLoadError);
          }
        }
      }

      stopAudioPlayback();
      replaceAudioUrl(nextAudioUrl);
      setPlaybackKind(nextAudioUrl ? "voice" : "animation-only");
      setLyrics(demoRecord.lyrics);
      clearPhase1Generation();
      setError(null);
      setVoicevoxWarning(null);
      setVoicevoxResolvedServer(null);
      setProgressLabel("準備中...");
      setParticipantAge(demoRecord.participantAge);
      clearDebugHistoryDrawing();
      setSelectedDemoDrawing(demoRecord.drawingData);
      setSelectedDemoRecordId(demoRecord.recordId);
      setGeneratedDrawing(null);
      setPlaybackScore(demoRecord.singingScore);
      replaceDebugExportSource(null);
      setDebugExportArtifacts(null);
      setDrawingDisplayMode("animated");
      setIsInitialPlaybackPromptVisible(false);
      setAppView("maker");
      setSaveToast({ message: "デモ記録を読み込みました", tone: "success" });
    } catch (loadError) {
      setDemoRecordsError(loadError instanceof Error ? loadError.message : "デモ記録を読み込めませんでした。");
    } finally {
      setLoadingDemoRecordId(null);
    }
  };

  const handleToggleDemoRecordFavorite = async (recordId: string, nextFavorite: boolean) => {
    setUpdatingDemoRecordId(recordId);
    setDemoRecordsError(null);

    try {
      await setDemoRecordFavorite(recordId, nextFavorite);
      await refreshDemoRecords();
    } catch (favoriteError) {
      setDemoRecordsError(favoriteError instanceof Error ? favoriteError.message : "お気に入りを更新できませんでした。");
    } finally {
      setUpdatingDemoRecordId(null);
    }
  };

  const handleDeleteDemoRecord = async (recordId: string) => {
    const record = demoRecords.find((item) => item.recordId === recordId);
    const confirmed = window.confirm(`${record?.title ?? "このデモ記録"}を削除しますか？この操作は元に戻せません。`);

    if (!confirmed) {
      return;
    }

    setDeletingDemoRecordId(recordId);
    setDemoRecordsError(null);

    try {
      await deleteDemoRecord(recordId);
      setDemoRecords((current) => current.filter((item) => item.recordId !== recordId));

      if (selectedDemoRecordId === recordId) {
        handleClear();
      }
    } catch (deleteError) {
      setDemoRecordsError(deleteError instanceof Error ? deleteError.message : "デモ記録を削除できませんでした。");
    } finally {
      setDeletingDemoRecordId(null);
    }
  };

  const startProgress = (label: string) => {
    setProgressLabel(label);
  };

  const updateProgress = (label: string) => {
    setProgressLabel(label);
  };

  const finishProgress = async (label: string) => {
    setProgressLabel(label);
  };

  const handleVoicevoxProgress = (stage: VoicevoxProgressStage) => {
    if (stage === "query_requested") {
      updateProgress("歌声に魔法をかけているよ");
      return;
    }

    if (stage === "query_ready") {
      updateProgress("歌声に魔法をかけているよ");
      return;
    }

    if (stage === "synthesis_requested") {
      updateProgress("歌声に魔法をかけているよ");
      return;
    }

    updateProgress("歌声に魔法をかけているよ");
  };

  const applyVoicevoxBaseUrl = () => {
    try {
      const normalizedBaseUrl = setDirectVoicevoxBaseUrl(voicevoxBaseUrl);
      setVoicevoxBaseUrl(normalizedBaseUrl);
      try {
        window.localStorage.setItem(VOICEVOX_BASE_URL_STORAGE_KEY, normalizedBaseUrl);
      } catch {
        // Storage is optional; the selected URL still works for this session.
      }
      setVoicevoxConnectionStatus("idle");
      setVoicevoxConnectionMessage("URLを適用しました。再確認してください。");
      setVoicevoxServerHealth((current) => ({
        ...current,
        local: { status: "unknown", message: "URLを適用しました。バージョンを確認してください。" },
      }));
      return true;
    } catch (error) {
      setVoicevoxConnectionStatus("unavailable");
      const message = error instanceof Error ? error.message : "VOICEVOXのURLを確認してください。";
      setVoicevoxConnectionMessage(message);
      setVoicevoxServerHealth((current) => ({ ...current, local: { status: "unavailable", message } }));
      return false;
    }
  };

  const handleSelectVoicevoxServer = (server: VoicevoxServerId) => {
    setVoicevoxServerSelection(server);
    try {
      window.localStorage.setItem(VOICEVOX_SERVER_SELECTION_STORAGE_KEY, server);
    } catch {
      // The selected route remains active for this tab when storage is unavailable.
    }
    // Already-generated candidate audio belongs to the current song and its
    // one-time grants have been consumed. Preserve that cache; this selection
    // applies to the next song instead of degrading the current one to silence.
    if (server === "local") {
      setVoicevoxConnectionMessage("このパソコンのVOICEVOXは、生成時にも確認します。");
    } else {
      setVoicevoxConnectionMessage("必要なときに「バージョンを確認」を押してください。");
    }
    setVoicevoxServerHealth((current) => ({
      ...current,
      [server]: current[server] ?? { status: "unknown" },
    }));
  };

  const checkVoicevoxServer = async (server: VoicevoxServerId) => {
    if (server === "local") {
      await checkVoicevoxConnection(true);
      return;
    }

    setVoicevoxServerHealth((current) => ({
      ...current,
      [server]: { status: "checking", message: "選択した歌声サーバーを確認しています..." },
    }));

    try {
      const result = await checkVoicevoxServerVersion(server);
      const resolvedLabel = result.server ? `（${getVoicevoxServerLabel(result.server)}）` : "";
      setVoicevoxServerHealth((current) => ({
        ...current,
        [server]: {
          status: result.liveCheck ? "connected" : "configured",
          version: result.version,
          message: result.liveCheck
            ? `接続できました${resolvedLabel}`
            : `設定を確認しました${resolvedLabel}。接続・バージョンは未確認です。`,
        },
      }));
    } catch (error) {
      setVoicevoxServerHealth((current) => ({
        ...current,
        [server]: {
          status: "unavailable",
          message: error instanceof Error ? error.message : "接続できませんでした。",
        },
      }));
    }
  };

  const handleOpenDebugHistoryRecord = (record: DebugHistoryRecord) => {
    const { manifest, artifacts } = record;
    const drawingData: DrawingData = {
      imageUri: "",
      strokes: manifest.drawing.strokes,
      strokeGroups: manifest.drawing.strokeGroups,
      canvasSize: manifest.drawing.canvasSize ?? undefined,
      lineWidth: manifest.drawing.lineWidth ?? undefined,
    };
    const playbackAudioBlob = artifacts.voiceAudioBlob ?? (manifest.singingScore ? createSilentPlaybackAudio(manifest.singingScore) : null);

    voicevoxGrantsRef.current = {};
    stopAudioPlayback();
    replaceAudioUrl(playbackAudioBlob ? URL.createObjectURL(playbackAudioBlob) : null);
    setPlaybackKind(artifacts.voiceAudioBlob ? "voice" : "animation-only");
    setLyrics(manifest.lyrics);
    clearPhase1Generation();
    setError(manifest.outcome.error);
    setVoicevoxWarning(manifest.generation.voicevoxIssue);
    setVoicevoxResolvedServer(null);
    setProgressLabel("再生できます");
    setParticipantAge(null);
    setSelectedDemoDrawing(null);
    setSelectedDemoRecordId(null);
    replaceDebugHistoryDrawing(drawingData, artifacts.imageBlob);
    setGeneratedDrawing(null);
    setPlaybackScore(manifest.singingScore);
    replaceDebugExportSource(null);
    setDebugExportArtifacts(artifacts);
    setIsDebugExportOpen(false);
    setDebugReporterNote("");
    setDebugBundleError(null);
    setDrawingDisplayMode("animated");
    setIsInitialPlaybackPromptVisible(false);
    setAppView("maker");
    setSaveToast({ message: "端末の記録を開きました", tone: "success" });
  };

  const checkVoicevoxConnection = async (forceRefresh = false) => {
    if (!applyVoicevoxBaseUrl()) {
      return false;
    }

    if (forceRefresh) {
      resetVoicevoxConnection();
    }

    setVoicevoxConnectionStatus("checking");
    setVoicevoxConnectionMessage("このパソコンのVOICEVOXを確認しています...");
    setVoicevoxServerHealth((current) => ({
      ...current,
      local: { status: "checking", message: "このパソコンのVOICEVOXを確認しています..." },
    }));

    try {
      const baseUrl = await probeVoicevox();
      setVoicevoxConnectionStatus("connected");
      setVoicevoxConnectionMessage(`接続できました（${baseUrl}）`);
      setVoicevoxServerHealth((current) => ({
        ...current,
        local: { status: "connected", message: `接続できました（${baseUrl}）` },
      }));
      return true;
    } catch {
      setVoicevoxConnectionStatus("unavailable");
      setVoicevoxConnectionMessage("接続できませんでした。歌声なしのアニメーションで続けられます。");
      setVoicevoxServerHealth((current) => ({
        ...current,
        local: { status: "unavailable", message: "接続できませんでした。歌声なしのアニメーションで続けられます。" },
      }));
      return false;
    }
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

  const analyzeLyricsAccents = async (targetLyrics: LyricsResponse) => {
    const sourceLines = targetLyrics.singingKanaLines?.filter((line) => line.trim().length > 0) ?? [];

    if (sourceLines.length === 0) {
      return undefined;
    }

    try {
      return (await analyzeAccentLines(sourceLines)).hints;
    } catch (accentError) {
      if (import.meta.env.DEV) {
        console.warn("Failed to analyze VOICEVOX accent phrases. Falling back to melody generation without accents.", accentError);
      }

      return undefined;
    }
  };

  const updateEvaluationDraftStateBestEffort = (
    patch: Parameters<typeof withEvaluationDraftState>[1],
  ) => {
    const currentDraft = evaluationDraftRef.current;
    if (!currentDraft) return;
    const nextDraft = withEvaluationDraftState(currentDraft, patch, new Date().toISOString());
    evaluationDraftRef.current = nextDraft;

    // Before the combined consent, the evaluation exists only in memory.
    // Once accepted, later bounded changes are kept in the browser draft too.
    if (evaluationStorageConsentRef.current !== "accepted" || !appFeatures.debugHistory) return;
    const write = () => saveEvaluationDraft(nextDraft);
    const queuedWrite = evaluationDraftWriteQueueRef.current.then(write, write);
    evaluationDraftWriteQueueRef.current = queuedWrite.catch(() => undefined);
    void queuedWrite.catch(() => {
      if (isMountedRef.current) {
        setSaveToast({ message: "このブラウザに保存できませんでした", tone: "error" });
      }
    });
  };

  // A receipt can also be issued for one candidate. Cloud evaluation still
  // requires a completed A/B choice; browser saving is independent of it.
  const canSaveEvaluationToCloud = (draft: EvaluationDraft | null) =>
    !!draft?.firstImpressionSelection
    && isComparableCandidateSet(draft.candidates)
    && !!evaluationReceipt
    && !!evaluationReceiptExpiresAt
    && Date.parse(evaluationReceiptExpiresAt) > Date.now();

  const handleFirstImpressionSelection = async (selection: EvaluationSelection) => {
    if (!isFirstImpressionOpen || evaluationSelection !== null || !isComparableCandidateSet(generatedLyricsCandidates)) return;

    const firstCandidateId = candidateDisplayOrder[0];
    const targetCandidateId = selection === "neither" ? firstCandidateId : selection;
    if (!targetCandidateId) return;

    setEvaluationSelection(selection);
    setFinalPreferenceSelection(selection);
    updateEvaluationDraftStateBestEffort({
      firstImpressionSelection: selection,
      finalPreferenceSelection: selection,
      activeCandidateId: targetCandidateId,
      alternativePreviewed: false,
      centralConsent: "not-asked",
    });

    setIsFirstImpressionOpen(false);
    const canSaveToCloud = canSaveEvaluationToCloud(evaluationDraftRef.current);
    const canSaveInBrowser = appFeatures.debugHistory && !!debugExportSource;
    const needsCandidateActivation = previewCandidateId !== targetCandidateId;
    if (canSaveInBrowser || canSaveToCloud) {
      setIsEvaluationConsentOpen(true);
      setIsInitialPlaybackPromptVisible(false);
    } else {
      if (needsCandidateActivation) {
        showPlaybackWhenCandidateReadyRef.current = true;
      } else {
        setIsInitialPlaybackPromptVisible(true);
      }
    }

    // Phase 1 normally prepared both candidates before opening this dialog, so
    // activation is an immediate cache switch. Keep the guarded async path as a
    // recovery for imported or older results whose cache is incomplete.
    if (needsCandidateActivation) {
      const activation = activateLyricsCandidate(targetCandidateId, null);
      candidateActivationPromiseRef.current = activation;
      void activation.finally(() => {
        if (candidateActivationPromiseRef.current === activation) {
          candidateActivationPromiseRef.current = null;
        }
      });
    }
  };

  const saveCurrentResultInBrowser = async (
    activation: Promise<DebugExportSource | null> | null,
    sourceAtConsent: DebugExportSource | null,
  ) => {
    if (!appFeatures.debugHistory || !sourceAtConsent) return;
    const saveSource = async (source: DebugExportSource) => {
      const artifacts = await buildDebugBundleArtifacts({
        source,
        buildId: appBuildId,
        mode: appConfig.mode,
        origin: window.location.origin,
      });
      await saveDebugHistoryRecord(artifacts);
    };

    // Save a complete animation-only version immediately. If VOICEVOX is still
    // preparing the selected candidate, replace the same record with its voice
    // once ready. Closing the tab or starting a new song cannot lose the first
    // browser save, and neither action can redirect it to another generation.
    await saveSource(sourceAtConsent);
    if (activation) {
      void activation
        .then((readySource) => readySource ? saveSource(readySource) : undefined)
        .catch(() => undefined);
    }
  };

  const browserSaveSourceForSelection = (
    source: DebugExportSource | null,
    draft: EvaluationDraft | null,
  ): DebugExportSource | null => {
    if (!source || !draft?.activeCandidateId) return source;
    const selectedCandidate = draft.candidates.find((candidate) => candidate.candidateId === draft.activeCandidateId);
    if (!selectedCandidate) return source;
    if ("candidateId" in (source.lyrics ?? {}) && (source.lyrics as LyricsCandidate).candidateId === selectedCandidate.candidateId) {
      return source;
    }
    const score = buildSingingScore(selectedCandidate, createSingingSeed(selectedCandidate, 0));
    return {
      ...source,
      lyrics: selectedCandidate,
      singingScore: score,
      voiceAudioBlob: null,
      playbackKind: "animation-only",
      voicevoxStatus: "not-attempted",
      voicevoxIssue: null,
    };
  };

  const handleEvaluationCentralConsent = async (nextConsent: Exclude<EvaluationCentralConsent, "not-asked">) => {
    if (isEvaluationSubmissionPending) return;
    evaluationStorageConsentRef.current = nextConsent;
    const updatedAt = new Date().toISOString();
    const currentDraft = evaluationDraftRef.current;
    const nextDraft = currentDraft
      ? withEvaluationDraftState(currentDraft, { centralConsent: nextConsent }, updatedAt)
      : null;
    evaluationDraftRef.current = nextDraft;
    if (nextConsent === "declined") {
      setIsEvaluationCentrallySaved(false);
      setIsEvaluationConsentOpen(false);
      if (isCandidatePreviewLoading) {
        showPlaybackWhenCandidateReadyRef.current = true;
      } else {
        setIsInitialPlaybackPromptVisible(true);
      }
      return;
    }
    setIsEvaluationSubmissionPending(true);
    const saveSequence = evaluationSaveSequenceRef.current + 1;
    evaluationSaveSequenceRef.current = saveSequence;
    const consentGenerationId = nextDraft?.generationId ?? null;
    const activationAtConsent = candidateActivationPromiseRef.current;
    const debugSourceAtConsent = browserSaveSourceForSelection(debugExportSourceRef.current, nextDraft);
    // Capture all archive inputs at the consent boundary. This makes a later
    // "new song" reset harmless while the independent upload is in flight.
    const archiveSnapshotAtConsent = creationArchiveSnapshotRef.current;
    const archiveTicketAtConsent = archiveGenerationTicketRef.current;
    setIsEvaluationConsentOpen(false);
    if (isCandidatePreviewLoading) {
      showPlaybackWhenCandidateReadyRef.current = true;
    } else {
      setIsInitialPlaybackPromptVisible(true);
    }
    try {
      const browserSave = Promise.all([
        ...(nextDraft && appFeatures.debugHistory ? [saveEvaluationDraft(nextDraft)] : []),
        saveCurrentResultInBrowser(activationAtConsent, debugSourceAtConsent),
      ]);
      const canSaveToCloud = canSaveEvaluationToCloud(nextDraft);
      const evaluationPayload = nextDraft && canSaveToCloud
        ? buildEvaluationSubmission(nextDraft, evaluationReceipt, appBuildId, updatedAt, EVALUATION_EXPERIMENT_ROUND_ID)
        : null;
      const fullArchiveRequested = !!evaluationPayload && !!archiveSnapshotAtConsent && !!archiveTicketAtConsent;
      const archiveSave = fullArchiveRequested && evaluationPayload && archiveSnapshotAtConsent && archiveTicketAtConsent
        ? startCreationArchive({
          evaluation: evaluationPayload,
          generationTicket: archiveTicketAtConsent,
          consentVersion: CREATION_ARCHIVE_CONSENT_VERSION,
          snapshot: archiveSnapshotAtConsent,
        })
        : Promise.resolve(null);
      // A full archive keeps evaluation and material under the same retention
      // lifecycle. Legacy metadata-only saves retain the existing parallel path.
      const cloudSave = fullArchiveRequested
        ? archiveSave.then((archive) => archive.archiveId ? submitEvaluation(evaluationPayload!) : null)
        : evaluationPayload
          ? submitEvaluation(evaluationPayload)
          : Promise.resolve(null);
      const [browserResult, cloudResult, archiveResult] = await Promise.allSettled([browserSave, cloudSave, archiveSave]);
      const savedInBrowser = browserResult.status === "fulfilled";
      const savedToCloud = cloudResult.status === "fulfilled" && cloudResult.value !== null;
      const stillShowingConsentedResult = consentGenerationId
        ? consentGenerationId === evaluationDraftRef.current?.generationId
        : debugSourceAtConsent?.recordId === debugExportSourceRef.current?.recordId;
      if (!stillShowingConsentedResult || evaluationSaveSequenceRef.current !== saveSequence) return;
      setIsEvaluationCentrallySaved(savedToCloud);
      const archive = archiveResult.status === "fulfilled" ? archiveResult.value : null;
      const archiveSaved = archive?.status === "complete";
      const archivePartial = archive?.status === "partial";
      const archiveRequestFailed = archiveResult.status === "rejected" || archive?.status === "failed";
      if (archive?.status === "failed" && archive.archiveId && archive.deletionReceipt) {
        downloadCreationArchiveDeletionReceiptBlob(archive.archiveId, archive.deletionReceipt);
      }
      if (archiveRequestFailed) {
        setSaveToast({ message: archive?.deletionReceipt ? "作品データは送らず、削除レシートをダウンロードしました" : archive?.error ?? "作品データを保存できませんでした。歌はそのまま使えます", tone: "error" });
      } else if (savedInBrowser && (savedToCloud || !canSaveToCloud) && (!archive || archiveSaved)) {
        setSaveToast({ message: archiveSaved ? "作品を1年間、非公開で保存しました" : savedToCloud ? "保存しました。ありがとう！" : "このブラウザに保存しました", tone: "success" });
      } else if (archivePartial) {
        setSaveToast({ message: "回答は保存しましたが、作品データの一部を保存できませんでした", tone: "error" });
      } else if (savedInBrowser) {
        setSaveToast({ message: "このブラウザには保存しました。クラウドには送れませんでした", tone: "error" });
      } else if (savedToCloud) {
        setSaveToast({ message: "クラウドには保存しました。このブラウザには保存できませんでした", tone: "error" });
      } else {
        setSaveToast({ message: "保存できませんでした。歌はそのまま使えます", tone: "error" });
      }
    } finally {
      if (isMountedRef.current && evaluationSaveSequenceRef.current === saveSequence) {
        setIsEvaluationSubmissionPending(false);
      }
    }
  };

  const persistEvaluationFollowUpAnswers = async (
    answers: EvaluationFollowUpAnswers,
    followUpConsent: EvaluationCentralConsent,
  ): Promise<EvaluationDraft> => {
    const currentDraft = evaluationDraftRef.current;
    if (!currentDraft) throw new Error("この回答の保存先が見つかりません。");
    const updatedAt = new Date().toISOString();
    setFinalPreferenceSelection(answers.finalPreferenceSelection);
    setSubjectFeedbackChoice(answers.subjectFeedbackChoice);
    setEvaluationRatings({ ...answers.ratings });
    const nextDraft = withEvaluationDraftState(currentDraft, {
      finalPreferenceSelection: answers.finalPreferenceSelection,
      subjectFeedbackChoice: answers.subjectFeedbackChoice,
      ratings: answers.ratings,
      followUpCentralConsent: followUpConsent,
    }, updatedAt);
    evaluationDraftRef.current = nextDraft;
    if (!appFeatures.debugHistory) return nextDraft;
    const write = () => saveEvaluationDraft(nextDraft);
    const queuedWrite = evaluationDraftWriteQueueRef.current.then(write, write);
    evaluationDraftWriteQueueRef.current = queuedWrite.then(() => undefined, () => undefined);
    await queuedWrite;
    return nextDraft;
  };

  const handleSaveEvaluationFollowUpLocally = async (answers: EvaluationFollowUpAnswers) => {
    if (isEvaluationFollowUpPending) return;
    setIsEvaluationFollowUpPending(true);
    try {
      await persistEvaluationFollowUpAnswers(answers, "declined");
      setSaveToast({ message: "回答をこの端末に保存しました", tone: "success" });
      setIsEvaluationFollowUpOpen(false);
      setFollowUpPreferencePrefill(null);
    } catch (followUpError) {
      setSaveToast({ message: followUpError instanceof Error ? followUpError.message : "回答を保存できませんでした", tone: "error" });
    } finally {
      if (isMountedRef.current) setIsEvaluationFollowUpPending(false);
    }
  };

  const handleSendEvaluationFollowUp = async (answers: EvaluationFollowUpAnswers) => {
    if (isEvaluationFollowUpPending || !evaluationReceipt || !isEvaluationCentrallySaved) return;
    setIsEvaluationFollowUpPending(true);
    let savedLocally = false;
    try {
      const draft = await persistEvaluationFollowUpAnswers(answers, "not-asked");
      savedLocally = true;
      const payload = buildEvaluationFollowUpSubmission(draft, evaluationReceipt);
      const result = await submitEvaluationFollowUp(payload);
      updateEvaluationDraftStateBestEffort({ followUpCentralConsent: "accepted" });
      setSaveToast({ message: result.duplicate ? "この回答はすでに届いています" : "回答を送りました。ありがとう！", tone: "success" });
      setIsEvaluationFollowUpOpen(false);
      setFollowUpPreferencePrefill(null);
    } catch (followUpError) {
      setSaveToast({
        message: `${savedLocally ? "回答は端末に保存しました。" : ""}${followUpError instanceof Error ? followUpError.message : "回答を送れませんでした"}`,
        tone: "error",
      });
    } finally {
      if (isMountedRef.current) setIsEvaluationFollowUpPending(false);
    }
  };

  const handleChooseCurrentAsFinalPreference = () => {
    if (!previewCandidateId || evaluationSelection === null) return;
    setFollowUpPreferencePrefill(previewCandidateId);
    setIsEvaluationFollowUpOpen(true);
  };

  const activateLyricsCandidate = async (candidateId: LyricsCandidate["candidateId"], showPlaybackPrompt: boolean | null = true): Promise<DebugExportSource | null> => {
    if (!isComparableCandidateSet(generatedLyricsCandidates) || isCandidatePreviewLoading) return null;
    const candidate = generatedLyricsCandidates.find((item) => item.candidateId === candidateId);
    if (!candidate || previewCandidateId === candidateId) return null;

    const activationSequence = candidateActivationSequenceRef.current + 1;
    candidateActivationSequenceRef.current = activationSequence;
    setIsCandidatePreviewLoading(candidateId);
    // Stop and reset first, then make one coherent state update once the next
    // candidate's score and audio are available.
    resetAudioState();
    let resolvedDebugSource: DebugExportSource | null = null;

    try {
      let playback = candidatePlaybackCacheRef.current.get(candidateId);
      if (!playback) {
        const voiceGrant = voicevoxGrantsRef.current[candidateId];
        const canUseLocalVoicevox = (voicevoxServerSelection === "auto" || voicevoxServerSelection === "local")
          && appFeatures.localVoicevox
          && voicevoxConnectionStatus === "connected";
        const canUseRemoteVoicevox = voicevoxServerSelection !== "local"
          && appFeatures.voicevox
          && (isDevelopmentVoicevox() || !!voiceGrant);
        const canUseVoicevox = canUseLocalVoicevox || canUseRemoteVoicevox;
        const accentLineHints = isDevelopmentVoicevox() && canUseLocalVoicevox
          ? await analyzeLyricsAccents(candidate)
          : undefined;
        if (candidateActivationSequenceRef.current !== activationSequence) return null;

        const score = buildSingingScore(candidate, createSingingSeed(candidate, 0), accentLineHints);
        let audioBlob = createSilentPlaybackAudio(score);
        let playbackKind: PlaybackKind = "animation-only";
        let nextVoicevoxWarning: string | null = canUseVoicevox ? null : voicevoxWarning;
        let nextVoicevoxServer: VoicevoxResolvedServerId | null = null;

        if (canUseVoicevox) {
          try {
            audioBlob = await synthesizeSingingVoice(score, undefined, voiceGrant, {
              server: voicevoxServerSelection,
              onServerResolved: (server) => {
                nextVoicevoxServer = server;
                setVoicevoxResolvedServer(server);
              },
            });
            playbackKind = "voice";
          } catch (voiceError) {
            nextVoicevoxWarning = voiceError instanceof Error ? voiceError.message : "VOICEVOXで歌声を作れませんでした。";
            setVoicevoxConnectionStatus("unavailable");
            setVoicevoxConnectionMessage("接続は確認できましたが、歌声合成を完了できませんでした。");
          }
        }
        if (candidateActivationSequenceRef.current !== activationSequence) return null;
        playback = {
          score,
          audioBlob,
          playbackKind,
          voicevoxWarning: nextVoicevoxWarning,
          voicevoxServer: nextVoicevoxServer,
        };
        candidatePlaybackCacheRef.current.set(candidateId, playback);
      }

      if (candidateActivationSequenceRef.current !== activationSequence || !isMountedRef.current) return null;
      setLyrics(candidate);
      setPlaybackScore(playback.score);
      replaceAudioUrl(URL.createObjectURL(playback.audioBlob));
      setPlaybackKind(playback.playbackKind);
      setVoicevoxWarning(playback.voicevoxWarning);
      setVoicevoxResolvedServer(playback.voicevoxServer);
      setPreviewCandidateId(candidateId);
      const debugSource = debugExportSourceRef.current;
      if (debugSource) {
        resolvedDebugSource = {
          ...debugSource,
          lyrics: candidate,
          singingScore: playback.score,
          voiceAudioBlob: playback.playbackKind === "voice" ? playback.audioBlob : null,
          playbackKind: playback.playbackKind,
          voicevoxStatus: playback.playbackKind === "voice" ? "voice" : "unavailable",
          voicevoxIssue: playback.voicevoxWarning,
        };
        replaceDebugExportSource(resolvedDebugSource);
      }
      const alternativeWasPreviewed = evaluationSelection !== null;
      if (alternativeWasPreviewed) setHasAlternativePreviewed(true);
      updateEvaluationDraftStateBestEffort({
        activeCandidateId: candidateId,
        ...(alternativeWasPreviewed ? { alternativePreviewed: true } : {}),
      });
      if (showPlaybackPrompt !== null) {
        setIsInitialPlaybackPromptVisible(showPlaybackPrompt);
      }
    } catch (candidateError) {
      if (candidateActivationSequenceRef.current === activationSequence && isMountedRef.current) {
        try {
          const fallbackScore = buildSingingScore(candidate, createSingingSeed(candidate, 0));
          const fallbackAudio = createSilentPlaybackAudio(fallbackScore);
          candidatePlaybackCacheRef.current.set(candidateId, {
            score: fallbackScore,
            audioBlob: fallbackAudio,
            playbackKind: "animation-only",
            voicevoxWarning: "歌声を作れなかったため、絵のアニメーションで再生します。",
            voicevoxServer: null,
          });
          setLyrics(candidate);
          setPlaybackScore(fallbackScore);
          replaceAudioUrl(URL.createObjectURL(fallbackAudio));
          setPlaybackKind("animation-only");
          setVoicevoxWarning("歌声を作れなかったため、絵のアニメーションで再生します。");
          setVoicevoxResolvedServer(null);
          setPreviewCandidateId(candidateId);
          const debugSource = debugExportSourceRef.current;
          if (debugSource) {
            resolvedDebugSource = {
              ...debugSource,
              lyrics: candidate,
              singingScore: fallbackScore,
              voiceAudioBlob: null,
              playbackKind: "animation-only",
              voicevoxStatus: "failed",
              voicevoxIssue: "歌声を作れなかったため、絵のアニメーションで再生します。",
            };
            replaceDebugExportSource(resolvedDebugSource);
          }
          updateEvaluationDraftStateBestEffort({ activeCandidateId: candidateId });
          setSaveToast({ message: "歌声なしで再生できます", tone: "error" });
        } catch {
          setSaveToast({ message: "この歌の再生準備に失敗しました", tone: "error" });
        }
      }
    } finally {
      if (candidateActivationSequenceRef.current === activationSequence && isMountedRef.current) {
        setIsCandidatePreviewLoading(null);
        if (showPlaybackPrompt === null && showPlaybackWhenCandidateReadyRef.current) {
          showPlaybackWhenCandidateReadyRef.current = false;
          setIsInitialPlaybackPromptVisible(true);
        }
      }
    }
    return resolvedDebugSource;
  };

  const handleGenerateExperimentVoice = async () => {
    if (!isDevelopmentVoicevox()) {
      setExperimentError("実験用の歌声生成は開発時のローカルVOICEVOXでのみ利用できます。");
      return;
    }
    const nextVariant = experimentVariant + 1;

    setExperimentVariant(nextVariant);
    setIsExperimentGenerating(true);
    setExperimentError(null);
    setExperimentProgressLabel("メロディを組み立てています...");
    stopExperimentAudioPlayback();
    replaceExperimentAudioUrl(null);

    try {
      setExperimentProgressLabel("VOICEVOX でアクセントを解析しています...");
      const accentLineHints = await analyzeLyricsAccents(experimentLyrics);
      const seed = createSingingSeed(experimentLyrics, nextVariant);
      setExperimentProgressLabel("メロディを組み立てています...");
      const score = buildSingingScore(experimentLyrics, seed, accentLineHints);
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

  const runGeneration = async (data: DrawingData, recordOptions: GenerationRecordOptions) => {
    if (generationRunRef.current) {
      return;
    }

    if (!appFeatures.gemini) {
      setError("公開確認版では、AI生成機能は準備中です。描画機能をお試しください。");
      return;
    }

    const turnstileTokenForRequest = turnstileTokenRef.current;
    if (isTurnstileRequired && !turnstileTokenForRequest) {
      setError("安全確認が終わってから、もう一度「歌をつくる！」を押してね。");
      setGenerationFailureDisplay({
        label: "安全確認失敗",
        message: "安全確認をやりなおしてから、もう一度ためしてみてね。",
        diagnosticCode: "TS-VERIFY",
      });
      retryTurnstile();
      return;
    }

    // Keep this token intact until Siteverify has received it. Resetting the
    // widget before fetch can invalidate it and reject every generation.

    const selectedVoicevoxServer = voicevoxServerSelection;
    const generationSequence = generationSequenceRef.current + 1;
    generationSequenceRef.current = generationSequence;
    const isCurrentGeneration = () => isMountedRef.current && generationSequenceRef.current === generationSequence;
    const groupedDrawingData = {
      ...data,
      strokeGroups: groupStrokes(data.strokes),
    };
    const startedAt = new Date().toISOString();
    const debugRecordId = createDebugRecordId();
    let generatedLyrics: LyricsResponse | null = null;
    let generatedCandidates: LyricsCandidate[] | null = null;
    let evaluationDraft: EvaluationDraft | null = null;
    let evaluationDraftUnavailable = false;
    let generatedScore: SingingScore | null = null;
    let generatedAudioBlob: Blob | null = null;
    let generatedVoiceAudioBlob: Blob | null = null;
    let generatedVoicevoxServer: VoicevoxResolvedServerId | null = null;
    let generationErrorMessage: string | null = null;
    let voicevoxIssue: string | null = null;
    let voicevoxStatus: DebugBundleSource["voicevoxStatus"] = "not-attempted";
    let voicevoxFailedStage: GenerationTimingPhase | null = null;
    const timingStartedAt = performance.now();
    const phaseStartedAt = new Map<GenerationTimingPhase, number>();
    const durationsMs: GenerationTimingDurations = {};
    let activeTimingPhase: GenerationTimingPhase = "gemini";
    let failedStage: GenerationTimingPhase | null = null;
    const completeTimingPhase = (phase = activeTimingPhase) => {
      const started = phaseStartedAt.get(phase);
      if (started === undefined) return;
      durationsMs[phase] = (durationsMs[phase] ?? 0) + Math.round(performance.now() - started);
      phaseStartedAt.delete(phase);
    };
    const beginTimingPhase = (phase: GenerationTimingPhase, updateVisibleProgress = true) => {
      completeTimingPhase(activeTimingPhase);
      activeTimingPhase = phase;
      phaseStartedAt.set(phase, performance.now());
      if (updateVisibleProgress) setGenerationProgressPhase(phase);
    };

    generationRunRef.current = true;
    const runKey = generationTimingRunKeyRef.current + 1;
    let resolveGenerationCompletion!: () => void;
    const generationCompletion = new Promise<void>((resolve) => {
      resolveGenerationCompletion = resolve;
    });
    generationCompletionWaiterRef.current = { runKey, resolve: resolveGenerationCompletion };
    generationTimingRunKeyRef.current = runKey;
    setGenerationTimingRunKey(runKey);
    setGenerationProgressPhase("gemini");
    setGenerationTimingEstimate(null);
    setIsGenerationProgressComplete(false);
    beginTimingPhase("gemini");
    if (appFeatures.generationTelemetry) {
      void getGenerationTimingEstimate()
        .then((estimate) => {
          if (generationRunRef.current && generationTimingRunKeyRef.current === runKey) setGenerationTimingEstimate(estimate);
        })
        .catch((timingEstimateError) => {
          // Timing estimates are optional and must never interrupt generation.
          if (import.meta.env.DEV) {
            console.warn("Failed to load generation timing estimate", timingEstimateError);
          }
        });
    }
    setIsGenerating(true);
    voicevoxGrantsRef.current = {};
    setLyrics(null);
    clearPhase1Generation();
    setError(null);
    setGenerationFailureDisplay(null);
    setVoicevoxWarning(null);
    setVoicevoxResolvedServer(null);
    setSaveToast(null);
    setSelectedDemoRecordId(null);
    setSelectedDemoDrawing(null);
    clearDebugHistoryDrawing();
    setGeneratedDrawing(groupedDrawingData);
    setPlaybackScore(null);
    replaceDebugExportSource(null);
    setDebugExportArtifacts(null);
    setIsDebugExportOpen(false);
    setDebugReporterNote("");
    setDebugBundleError(null);
    setDrawingDisplayMode("animated");
    resetAudioState();
    setIsInitialPlaybackPromptVisible(false);
    if (appFeatures.dataSaving) {
      void recordGeneration(recordOptions.shouldRecord)
        .catch((statsError) => {
          if (import.meta.env.DEV) {
            console.warn("Failed to record usage stats", statsError);
          }
        });
    }
    startProgress("絵をじっくり見ているよ");

    try {
      updateProgress("絵をじっくり見ているよ");
      // In auto/local mode this starts the loopback request from the user's
      // generate action so Chromium can show its Local Network Access prompt
      // while Gemini runs. Remote-only debug modes do not probe local audio.
      const localVoicevoxProbe = appFeatures.localVoicevox && (selectedVoicevoxServer === "auto" || selectedVoicevoxServer === "local")
        ? checkVoicevoxConnection(true)
        : Promise.resolve(false);
      const requestedGenerationId = createGenerationId();
      const generationResult = await generateEkakiUta(groupedDrawingData, turnstileTokenForRequest, requestedGenerationId ?? undefined);
      if (!isCurrentGeneration()) return;
      generatedLyrics = generationResult.lyrics;
      generatedCandidates = appConfig.lyricsCandidateCount === 1
        ? generationResult.candidates?.slice(0, 1) ?? null
        : generationResult.candidates;
      voicevoxGrantsRef.current = generationResult.voiceGrants ?? {};
      archiveGenerationTicketRef.current = generationResult.archiveGenerationTicket ?? null;
      setEvaluationReceipt(generationResult.evaluationReceipt ?? null);
      setEvaluationReceiptExpiresAt(generationResult.evaluationReceiptExpiresAt ?? null);
      setGeneratedLyricsCandidates(generatedCandidates);
      setGeneratedDrawingAnalysis(generationResult.drawingAnalysis);
      setGeneratedPhase1ModelInfo(generationResult.modelInfo);
      const candidateSet = generatedCandidates;
      if (isComparableCandidateSet(candidateSet) && generationResult.drawingAnalysis && generationResult.modelInfo) {
        const generationId = generationResult.generationId ?? requestedGenerationId;
        const displayOrder = shuffleCandidateIds(candidateSet.map((candidate) => candidate.candidateId));
        const initialPreviewCandidate = getInitialPreviewCandidate(candidateSet, displayOrder);
        if (!initialPreviewCandidate) {
          throw new Error("候補の表示順を初期化できませんでした。");
        }
        // The shuffled first card is the candidate that is actually prepared
        // below (score, VOICEVOX, mappings and first playback), not merely a
        // presentation label.
        generatedLyrics = initialPreviewCandidate;
        setCandidateDisplayOrder(displayOrder);
        setPreviewCandidateId(initialPreviewCandidate.candidateId);
        setEvaluationSelection(null);
        setEvaluationGenerationId(generationId);
        if (generationId) {
          const createdAt = new Date().toISOString();
          evaluationDraft = createEvaluationDraft({
            generationId,
            createdAt,
            candidates: candidateSet,
            displayOrder,
            drawingAnalysis: generationResult.drawingAnalysis,
            modelInfo: generationResult.modelInfo,
            activeCandidateId: initialPreviewCandidate.candidateId,
            lyricsPromptVersion: generationResult.lyricsPromptVersion,
          });
          evaluationDraftRef.current = evaluationDraft;
        } else {
          evaluationDraftUnavailable = true;
        }
      }
      completeTimingPhase("gemini");

      const canUseLocalVoicevox = await localVoicevoxProbe;
      if (!isCurrentGeneration()) return;
      const comparableCandidates = isComparableCandidateSet(generatedCandidates)
        ? generatedCandidates
        : null;
      // Phase 1 always returns candidate-scoped voice grants, including when
      // production is configured to show only one candidate.  Do not collapse
      // that one candidate back to the legacy shape here: doing so loses its
      // `candidate-a` grant before the synthesis request is made.
      const initialCandidateId: LyricsCandidate["candidateId"] | null = generatedLyrics && "candidateId" in generatedLyrics
        ? (generatedLyrics as LyricsCandidate).candidateId
        : null;
      const candidatesToPrepare: LyricsResponse[] = comparableCandidates
        ? [
          generatedLyrics as LyricsCandidate,
          ...comparableCandidates.filter((candidate) => candidate.candidateId !== initialCandidateId),
        ]
        : generatedLyrics
          ? [generatedLyrics]
          : [];
      const initialVoiceGrant = initialCandidateId
        ? voicevoxGrantsRef.current[initialCandidateId]
        : generationResult.voiceGrant;
      const canUseInitialRemoteVoicevox = selectedVoicevoxServer !== "local" && appFeatures.voicevox && (isDevelopmentVoicevox() || !!initialVoiceGrant);
      const canUseInitialVoicevox = canUseLocalVoicevox || canUseInitialRemoteVoicevox;
      if (selectedVoicevoxServer === "local" && appFeatures.localVoicevox && !canUseLocalVoicevox) {
        voicevoxStatus = "unavailable";
        setVoicevoxWarning(
          "VOICEVOX Engineを起動し、本番OriginのCORS許可とブラウザのローカルネットワークアクセス許可を確認してください。",
        );
      } else if (!canUseInitialVoicevox && appFeatures.voicevox && !initialVoiceGrant) {
        voicevoxStatus = "unavailable";
        setVoicevoxWarning("歌声の準備に必要な音声チケットを受け取れませんでした。歌詞とアニメーションは再生できます。");
      }

      const preparedCandidates = new Map<LyricsCandidate["candidateId"] | "legacy", CandidatePlaybackCache>();
      if (comparableCandidates) {
        updateProgress("2つの歌声を準備しているよ");
      }

      // Public A/B requests enter one bounded queue. Both results (including a
      // per-candidate animation fallback) are ready before asking for a choice.
      const queuedVoice = !!generationResult.voiceJobCapability && !!generationResult.generationId
        && !!comparableCandidates && !canUseLocalVoicevox && appFeatures.voicevox
        && !!voicevoxGrantsRef.current["candidate-a"] && !!voicevoxGrantsRef.current["candidate-b"]
        && selectedVoicevoxServer !== "local" && selectedVoicevoxServer !== "google-cloud-run";
      if (queuedVoice && comparableCandidates) {
        const abort = new AbortController();
        voiceJobAbortRef.current = abort;
        const cancelPending = () => { void cancelVoicevoxJobGroup(comparableCandidates.map(candidate => ({ jobId: `${generationResult.generationId}:${candidate.candidateId}` })), generationResult.voiceJobCapability!); };
        abort.signal.addEventListener("abort", cancelPending, { once: true });
        const inputs = comparableCandidates.map(candidate => {
          const score = buildSingingScore(candidate, createSingingSeed(candidate, 0));
          preparedCandidates.set(candidate.candidateId, { score, audioBlob: createSilentPlaybackAudio(score), playbackKind: "animation-only", voicevoxWarning: "歌声を用意できませんでした。絵のアニメーションで再生します。", voicevoxServer: null });
          return { candidateId: candidate.candidateId, voiceGrant: voicevoxGrantsRef.current[candidate.candidateId] ?? "", score };
        });
        try {
          beginTimingPhase("voicevoxSynthesis");
          const registration = await registerVoicevoxJobGroup({ generationId: generationResult.generationId!, groupId: generationResult.generationId!, capability: generationResult.voiceJobCapability!, candidates: inputs, signal: abort.signal });
          const states = await waitForVoicevoxJobs(registration.jobs, generationResult.voiceJobCapability!, { signal: abort.signal });
          for (const job of registration.jobs) {
            if (!states.find(state => state.jobId === job.jobId)?.audioReady) continue;
            try {
              const response = await fetch(voicevoxJobAudioUrl(job.jobId), { headers: { "X-Voicevox-Capability": generationResult.voiceJobCapability! }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]) });
              if (!response.ok) continue;
              const audioBlob = await response.blob();
              if (!audioBlob.size) continue;
              const previous = preparedCandidates.get(job.candidateId)!;
              preparedCandidates.set(job.candidateId, { ...previous, audioBlob, playbackKind: "voice", voicevoxWarning: null, voicevoxServer: "cloudflare-vpc" });
            } catch { /* Preserve this candidate's animation if downloading fails. */ }
          }
        } catch { /* Registered grants must not be reused through the old route. */ }
        finally { abort.signal.removeEventListener("abort", cancelPending); completeTimingPhase(); }
        if (!isCurrentGeneration()) return;
        for (const [id, playback] of preparedCandidates) if (id !== "legacy") candidatePlaybackCacheRef.current.set(id, playback);
      }

      // The VPC-backed VOICEVOX Engine shares one inference budget. Prepare
      // candidates one at a time to avoid a same-user burst; a failed voice is
      // cached as a seekable silent animation and must not stop the next one.
      for (const [candidateIndex, candidate] of candidatesToPrepare.entries()) {
        if (!isCurrentGeneration()) return;
        if (queuedVoice) break;
        // A single-candidate Phase 1 response still carries `candidate-a` and
        // its scoped voice grant. Preserve both even though it is not an A/B
        // set; only truly legacy responses use the legacy cache key.
        const candidateId: LyricsCandidate["candidateId"] | "legacy" = "candidateId" in candidate
          ? (candidate as LyricsCandidate).candidateId
          : "legacy";
        const voiceGrant = candidateId === "legacy"
          ? generationResult.voiceGrant
          : voicevoxGrantsRef.current[candidateId];
        const canUseRemoteVoicevox = selectedVoicevoxServer !== "local" && appFeatures.voicevox && (isDevelopmentVoicevox() || !!voiceGrant);
        const canUseVoicevox = canUseLocalVoicevox || canUseRemoteVoicevox;
        let candidateWarning: string | null = canUseVoicevox
          ? null
          : selectedVoicevoxServer === "local" && appFeatures.localVoicevox && !canUseLocalVoicevox
            ? "VOICEVOX Engineに接続できないため、絵のアニメーションで再生します。"
            : selectedVoicevoxServer !== "local" && appFeatures.voicevox && !voiceGrant
              ? "音声チケットを受け取れなかったため、絵のアニメーションで再生します。"
              : null;
        let candidateServer: VoicevoxResolvedServerId | null = null;
        let accentLineHints;

        try {
          if (isDevelopmentVoicevox() && canUseLocalVoicevox) {
            if (!comparableCandidates || candidateIndex === 0) beginTimingPhase("accent");
            accentLineHints = await analyzeLyricsAccents(candidate);
            if (!isCurrentGeneration()) return;
            if (!comparableCandidates || candidateIndex === 0) completeTimingPhase("accent");
          }

          if (!comparableCandidates || candidateIndex === 0) beginTimingPhase("score");
          const score = buildSingingScore(candidate, createSingingSeed(candidate, 0), accentLineHints);
          if (!comparableCandidates || candidateIndex === 0) completeTimingPhase("score");
          let audioBlob = createSilentPlaybackAudio(score);
          let candidatePlaybackKind: PlaybackKind = "animation-only";

          if (canUseVoicevox) {
            try {
              if (comparableCandidates) updateProgress("2つの歌声を準備しているよ");
              else updateProgress("歌声に魔法をかけているよ");
              beginTimingPhase("voicevoxQuery", !comparableCandidates || candidateIndex === 0);
              audioBlob = await synthesizeSingingVoice(score, (stage) => {
                if (!isCurrentGeneration()) return;
                if (stage === "synthesis_requested") {
                  completeTimingPhase("voicevoxQuery");
                  beginTimingPhase("voicevoxSynthesis", !comparableCandidates || candidateIndex === 1);
                }
                if (!comparableCandidates) handleVoicevoxProgress(stage);
              }, voiceGrant, {
                server: selectedVoicevoxServer,
                onServerResolved: (server) => {
                  candidateServer = server;
                  if (isCurrentGeneration() && (candidateId === initialCandidateId || candidateId === "legacy")) {
                    setVoicevoxResolvedServer(server);
                  }
                },
              });
              if (!isCurrentGeneration()) return;
              completeTimingPhase("voicevoxSynthesis");
              candidatePlaybackKind = "voice";
              candidateWarning = null;
            } catch (voicevoxError) {
              if (!isCurrentGeneration()) return;
              completeTimingPhase();
              candidateWarning = voicevoxError instanceof Error ? voicevoxError.message : "VOICEVOXで歌声を作れませんでした。";
              if (candidateId === initialCandidateId || candidateId === "legacy") {
                setVoicevoxConnectionStatus("unavailable");
                setVoicevoxConnectionMessage("接続は確認できましたが、歌声合成を完了できませんでした。");
                voicevoxFailedStage = activeTimingPhase;
              }
            }
          }

          const playback: CandidatePlaybackCache = {
            score,
            audioBlob,
            playbackKind: candidatePlaybackKind,
            voicevoxWarning: candidateWarning,
            voicevoxServer: candidateServer,
          };
          preparedCandidates.set(candidateId, playback);
          if (candidateId !== "legacy") {
            candidatePlaybackCacheRef.current.set(candidateId, playback);
          }
        } catch (candidateError) {
          // Score/accent preparation is also isolated per candidate. Build the
          // simplest valid fallback so both cards are ready before selection.
          let fallbackScore: SingingScore;
          try {
            fallbackScore = buildSingingScore(candidate, createSingingSeed(candidate, 0));
          } catch {
            fallbackScore = { notes: [{ lyric: "", key: null, frame_length: 1 }] };
          }
          const fallbackPlayback: CandidatePlaybackCache = {
            score: fallbackScore,
            audioBlob: createSilentPlaybackAudio(fallbackScore),
            playbackKind: "animation-only",
            voicevoxWarning: candidateError instanceof Error ? candidateError.message : "歌声を作れませんでした。",
            voicevoxServer: null,
          };
          preparedCandidates.set(candidateId, fallbackPlayback);
          if (candidateId !== "legacy") {
            candidatePlaybackCacheRef.current.set(candidateId, fallbackPlayback);
          }
        }
      }

      const initialPlayback = preparedCandidates.get(initialCandidateId ?? "legacy");
      if (!initialPlayback) throw new Error("歌の再生準備を完了できませんでした。");
      generatedScore = initialPlayback.score;
      generatedAudioBlob = initialPlayback.audioBlob;
      generatedVoiceAudioBlob = initialPlayback.playbackKind === "voice" ? initialPlayback.audioBlob : null;
      generatedVoicevoxServer = initialPlayback.voicevoxServer;
      voicevoxIssue = initialPlayback.voicevoxWarning;
      voicevoxStatus = initialPlayback.playbackKind === "voice"
        ? "voice"
        : canUseInitialVoicevox
          ? "failed"
          : appFeatures.voicevox || appFeatures.localVoicevox
            ? "unavailable"
            : "not-attempted";
      setPlaybackScore(initialPlayback.score);
      stopAudioPlayback();
      replaceAudioUrl(URL.createObjectURL(initialPlayback.audioBlob));
      setPlaybackKind(initialPlayback.playbackKind);
      setVoicevoxWarning(initialPlayback.voicevoxWarning);
      setVoicevoxResolvedServer(initialPlayback.voicevoxServer);

      // Freeze the original drawing and both prepared candidates before a
      // choice can change the active UI. Do not reconstruct this from state
      // later: a new song must never redirect an already-consented archive.
      if (comparableCandidates && evaluationDraft && generationResult.drawingAnalysis && generationResult.modelInfo) {
        const archivedCandidates = comparableCandidates
          .map((candidate) => {
            const prepared = preparedCandidates.get(candidate.candidateId);
            if (!prepared) return null;
            const isRealVoice = prepared.playbackKind === "voice";
            return {
              candidate: structuredClone(candidate),
              score: structuredClone(prepared.score),
              voiceAudioBlob: isRealVoice ? prepared.audioBlob : null,
              voiceStatus: isRealVoice ? "voice" as const : (appFeatures.voicevox || appFeatures.localVoicevox ? "failed" as const : "not-attempted" as const),
              voicevoxIssue: prepared.voicevoxWarning,
              voicevoxServer: prepared.voicevoxServer,
            };
          });
        if (archivedCandidates.every((item): item is NonNullable<typeof item> => !!item)) {
          const byId = new Map(archivedCandidates.map((item) => [item.candidate.candidateId, item]));
          const a = byId.get("candidate-a"), b = byId.get("candidate-b");
          if (a && b) creationArchiveSnapshotRef.current = {
            drawingData: structuredClone(groupedDrawingData),
            drawingAnalysis: structuredClone(generationResult.drawingAnalysis),
            candidates: [a, b],
            displayOrder: [...evaluationDraft.displayOrder] as [LyricsCandidate["candidateId"], LyricsCandidate["candidateId"]],
            activeCandidateId: evaluationDraft.activeCandidateId,
            buildId: appBuildId,
            mode: appConfig.mode,
            createdAt: new Date().toISOString(),
            modelInfo: structuredClone(generationResult.modelInfo),
            lyricsPromptVersion: generationResult.lyricsPromptVersion,
          };
        }
      }

      beginTimingPhase("finalize");
      updateProgress("絵描き歌の準備ができたよ");
      await finishProgress("絵描き歌の準備ができたよ");
      if (!isCurrentGeneration()) return;
      setLyrics(generatedLyrics);
    } catch (generationError) {
      if (!isCurrentGeneration()) return;
      failedStage = activeTimingPhase;
      completeTimingPhase();
      generationErrorMessage =
        generationError instanceof Error ? generationError.message : "歌の生成に失敗しました。";
      setGenerationFailureDisplay(getGenerationFailureDisplay(generationError));
      // Gemini succeeded before a later VOICEVOX stage failed. Keep that useful
      // lyric result visible instead of discarding it with the audio error.
      if (generatedLyrics && !generatedAudioBlob) {
        try {
          const fallbackScore = generatedScore ?? buildSingingScore(generatedLyrics, createSingingSeed(generatedLyrics, 0));
          const fallbackAudio = createSilentPlaybackAudio(fallbackScore);
          generatedScore = fallbackScore;
          generatedAudioBlob = fallbackAudio;
          generatedVoiceAudioBlob = null;
          voicevoxIssue = "歌声を作れなかったため、絵のアニメーションで再生します。";
          voicevoxStatus = appFeatures.voicevox || appFeatures.localVoicevox ? "failed" : "not-attempted";
          setPlaybackScore(fallbackScore);
          replaceAudioUrl(URL.createObjectURL(fallbackAudio));
          setPlaybackKind("animation-only");
          setVoicevoxWarning(voicevoxIssue);
          setVoicevoxResolvedServer(null);
        } catch {
          // If the lyric itself cannot produce a score, retain the original
          // generation error and let the existing error view explain it.
        }
      }
      setLyrics(generatedLyrics);
      if (!generatedLyrics) {
        setPlaybackScore(null);
        resetAudioState();
      }
      setError(generationErrorMessage);
      await finishProgress("エラーで終了しました");
    } finally {
      if (!isCurrentGeneration()) return;
      // Tokens are single-use, so prepare the next one only after this request
      // has completed (whether it succeeded or failed).
      if (isTurnstileRequired) {
        handleTurnstileToken(null);
        setTurnstileStatus("verifying");
        turnstileWidgetRef.current?.reset();
      }

      if (recordOptions.shouldRecord) {
        try {
          await saveDemoRecord({
            drawingData: groupedDrawingData,
            lyrics: generatedLyrics,
            audioBlob: generatedAudioBlob,
            singingScore: generatedScore,
            error: generationErrorMessage,
            startedAt,
            participantAge: recordOptions.participantAge,
            aiModel: generatedLyrics?.modelName ?? null,
          });
          setDemoRecords([]);
          setSaveToast({ message: "記録しました", tone: "success" });
        } catch (saveError) {
          if (import.meta.env.DEV) {
            console.error("Failed to save demo record", saveError);
          }
          setSaveToast({ message: "記録に失敗しました", tone: "error" });
        }
      }

      completeTimingPhase("finalize");
      const scoreNotes = generatedScore?.notes ?? [];
      const totalMs = Math.round(performance.now() - timingStartedAt);
      const completedDebugSource: DebugExportSource = {
        recordId: debugRecordId,
        drawingData: groupedDrawingData,
        lyrics: generatedLyrics,
        singingScore: generatedScore,
        voiceAudioBlob: generatedVoiceAudioBlob,
        playbackKind: generatedVoiceAudioBlob ? "voice" : "animation-only",
        voicevoxStatus,
        voicevoxIssue,
        startedAt,
        completedAt: new Date().toISOString(),
        failedStage: failedStage ?? voicevoxFailedStage,
        error: generationErrorMessage,
        durationsMs: { ...durationsMs },
      };
      replaceDebugExportSource(completedDebugSource);
      if (generationErrorMessage === null && isComparableCandidateSet(generatedCandidates) && generatedLyrics && generatedScore && generatedAudioBlob) {
        const candidateId = (generatedLyrics as LyricsCandidate).candidateId;
        candidatePlaybackCacheRef.current.set(candidateId, {
          score: generatedScore,
          audioBlob: generatedAudioBlob,
          playbackKind: generatedVoiceAudioBlob ? "voice" : "animation-only",
          voicevoxServer: generatedVoicevoxServer,
          voicevoxWarning: voicevoxIssue ?? (voicevoxStatus === "unavailable" ? "VOICEVOX Engineに接続できなかったため、歌声なしで再生します。" : null),
        });
      }
      if (generationErrorMessage === null && evaluationDraftUnavailable) {
        setSaveToast({ message: "このブラウザでは評価下書きを保存できません", tone: "error" });
      }
      if (appFeatures.generationTelemetry) {
        void saveGenerationTiming({
          success: generationErrorMessage === null,
          failedStage,
          modelName: generatedLyrics?.modelName ?? null,
          strokeCount: groupedDrawingData.strokes.length,
          strokeGroupCount: groupedDrawingData.strokeGroups?.length ?? 0,
          pointCount: groupedDrawingData.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0),
          lyricLineCount: generatedLyrics?.lines.filter((line) => line.trim().length > 0).length ?? 0,
          noteCount: scoreNotes.length,
          totalFrames: getScoreFrameLength(generatedScore),
          durationsMs,
          totalMs,
        }).catch(() => {
          // Anonymous timing storage is best-effort and must not change the result flow.
        });
      }
      if (generationErrorMessage === null) {
        setIsGenerationProgressComplete(true);
        await generationCompletion;
        if (!isCurrentGeneration()) return;
      } else if (generationCompletionWaiterRef.current?.runKey === runKey) {
        generationCompletionWaiterRef.current = null;
      }
      if (isMountedRef.current && generationTimingRunKeyRef.current === runKey) {
        setIsGenerating(false);
        generationRunRef.current = false;
        if (generationErrorMessage === null && generatedLyrics && generatedAudioBlob) {
          if (isComparableCandidateSet(generatedCandidates) && evaluationDraft) {
            setIsFirstImpressionOpen(true);
            setIsInitialPlaybackPromptVisible(false);
          } else if (appFeatures.debugHistory && debugExportSourceRef.current) {
            // Single-candidate and legacy results have no A/B dialog, but still
            // need their own browser-save choice before the playback prompt.
            setIsEvaluationConsentOpen(true);
            setIsInitialPlaybackPromptVisible(false);
          } else {
            setIsInitialPlaybackPromptVisible(true);
          }
        }
      }
    }
  };

  const handleComplete = async (data: DrawingData) => {
    if (!appFeatures.gemini) {
      setError("公開確認版では、AI生成機能は準備中です。描画機能をお試しください。");
      return;
    }

    if (!appFeatures.dataSaving) {
      await runGeneration(data, { shouldRecord: false, participantAge: null });
      return;
    }

    setPendingGenerationData(data);
    setRecordConsentError(null);
    setIsRecordConsentOpen(true);
  };

  const closeRecordConsent = () => {
    setIsRecordConsentOpen(false);
    setPendingGenerationData(null);
    setRecordConsentError(null);
  };

  const startPendingGeneration = async (recordOptions: GenerationRecordOptions) => {
    if (!pendingGenerationData) {
      return;
    }

    setIsRecordConsentOpen(false);
    setPendingGenerationData(null);
    setRecordConsentError(null);
    await runGeneration(pendingGenerationData, recordOptions);
  };

  const handleRecordAndGenerate = async () => {
    await startPendingGeneration({ shouldRecord: true, participantAge: appConfig.hideParticipantAgeUi ? null : participantAge });
  };

  const handleGenerateWithoutRecord = async () => {
    await startPendingGeneration({ shouldRecord: false, participantAge: null });
  };

  const handleClear = () => {
    generationSequenceRef.current += 1;
    generationRunRef.current = false;
    setIsGenerating(false);
    setIsGenerationProgressComplete(false);
    const completionWaiter = generationCompletionWaiterRef.current;
    generationCompletionWaiterRef.current = null;
    completionWaiter?.resolve();
    if (isTurnstileRequired) {
      handleTurnstileToken(null);
      setTurnstileStatus("verifying");
      turnstileWidgetRef.current?.reset();
    }
    voicevoxGrantsRef.current = {};
    setLyrics(null);
    clearPhase1Generation();
    setError(null);
    setGenerationFailureDisplay(null);
    setVoicevoxWarning(null);
    setSaveToast(null);
    setProgressLabel("準備中...");
    setSelectedDemoDrawing(null);
    setSelectedDemoRecordId(null);
    clearDebugHistoryDrawing();
    setGeneratedDrawing(null);
    setPlaybackScore(null);
    replaceDebugExportSource(null);
    setDebugExportArtifacts(null);
    setIsDebugExportOpen(false);
    setPendingGenerationData(null);
    setIsRecordConsentOpen(false);
    resetAudioState();
    setIsInitialPlaybackPromptVisible(false);
    setDrawingDisplayMode("animated");
  };

  const handleStartNewSong = () => {
    handleClear();
    setNewSongResetKey((current) => current + 1);
  };

  const handleDrawingEditStart = () => {
    if (!lyrics) return;
    voicevoxGrantsRef.current = {};
    setLyrics(null);
    clearPhase1Generation();
    setError(null);
    setVoicevoxWarning(null);
    setVoicevoxResolvedServer(null);
    setSelectedDemoRecordId(null);
    clearDebugHistoryDrawing();
    setPlaybackScore(null);
    replaceDebugExportSource(null);
    setDebugExportArtifacts(null);
    setIsDebugExportOpen(false);
    resetAudioState();
    setIsInitialPlaybackPromptVisible(false);
  };

  const handleInitialPlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;

    try {
      void audio.play().catch(() => {
        // Keep the initial overlay available when the browser rejects playback.
      });
    } catch {
      // Some browsers can throw synchronously for an unavailable audio source.
    }
  };

  const renderAlternativeCandidateButton = () => {
    if (!isComparableCandidateSet(generatedLyricsCandidates) || candidateDisplayOrder.length !== 2 || evaluationSelection === null) return null;
    const alternativeCandidateId = generatedLyricsCandidates.find((candidate) => candidate.candidateId !== previewCandidateId)?.candidateId;
    if (!alternativeCandidateId) return null;
    return (
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={() => {
            updateEvaluationDraftStateBestEffort({ activeCandidateId: alternativeCandidateId, alternativePreviewed: true });
            void activateLyricsCandidate(alternativeCandidateId);
          }}
          disabled={!!isCandidatePreviewLoading}
          aria-busy={isCandidatePreviewLoading === alternativeCandidateId}
          className="min-h-10 rounded-full border border-violet-200 bg-violet-50 px-4 py-2 text-xs font-black text-violet-800 shadow-sm transition hover:bg-violet-100 disabled:cursor-wait disabled:opacity-60"
        >
          {isCandidatePreviewLoading === alternativeCandidateId ? "準備中..." : "もう一つも聞く"}
        </button>
      </div>
    );
  };

  const renderEvaluationFollowUpControls = () => {
    if (
      !hasPlaybackStartedForGeneration ||
      !isComparableCandidateSet(generatedLyricsCandidates) ||
      evaluationSelection === null ||
      !previewCandidateId
    ) return null;
    const currentCandidate = generatedLyricsCandidates.find((candidate) => candidate.candidateId === previewCandidateId);
    const currentIsFinalPreference = finalPreferenceSelection === previewCandidateId;

    return (
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {hasAlternativePreviewed && currentCandidate && (
          currentIsFinalPreference ? (
            <span className="rounded-full bg-orange-50 px-3 py-2 text-xs font-black text-orange-700">いまの一番</span>
          ) : (
            <button
              type="button"
              onClick={handleChooseCurrentAsFinalPreference}
              disabled={isEvaluationFollowUpPending}
              className="min-h-9 rounded-full border border-orange-200 bg-orange-50 px-3 py-2 text-xs font-black text-orange-800 transition hover:bg-orange-100 disabled:opacity-60"
            >
              この歌をいまの一番にする
            </button>
          )
        )}
        <button
          type="button"
          onClick={() => {
            setFollowUpPreferencePrefill(null);
            setIsEvaluationFollowUpOpen(true);
          }}
          className="min-h-9 rounded-full border border-sky-200 bg-sky-50 px-3 py-2 text-xs font-black text-sky-800 transition hover:bg-sky-100"
        >
          絵の見え方・歌の感想（任意）
        </button>
      </div>
    );
  };

  const renderFirstImpressionModal = () => {
    if (!isFirstImpressionOpen || !isComparableCandidateSet(generatedLyricsCandidates) || candidateDisplayOrder.length !== 2) return null;
    const candidatesById = new Map(generatedLyricsCandidates.map((candidate) => [candidate.candidateId, candidate]));
    const displayedCandidates = candidateDisplayOrder.map((candidateId) => candidatesById.get(candidateId)).filter((candidate): candidate is LyricsCandidate => !!candidate);
    if (displayedCandidates.length !== 2) return null;

    return (
      <div className="fixed inset-0 z-[97] flex items-center justify-center bg-slate-900/45 px-4 py-5 backdrop-blur-sm" role="presentation">
        <section
          ref={firstImpressionDialogRef}
          className="max-h-[calc(100svh-2.5rem)] w-full max-w-3xl overflow-y-auto rounded-3xl border-4 border-violet-100 bg-white p-5 text-left shadow-2xl sm:p-7"
          role="dialog"
          aria-modal="true"
          aria-labelledby="first-impression-title"
        >
          <p className="text-xs font-black uppercase tracking-[0.18em] text-violet-500">歌詞の第一印象</p>
          <h2 id="first-impression-title" className="mt-1 text-2xl font-black leading-tight text-gray-800">どちらの歌詞を先に見てみたい？</h2>
          <p className="mt-2 text-sm font-semibold leading-relaxed text-gray-600">歌声を聴く前に、タイトルと歌詞から感じた方を選んでね。</p>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            {displayedCandidates.map((candidate, index) => (
              <button
                key={candidate.candidateId}
                type="button"
                data-first-impression-choice="true"
                onClick={() => void handleFirstImpressionSelection(candidate.candidateId)}
                disabled={!!isCandidatePreviewLoading}
                className="rounded-3xl border-2 border-violet-100 bg-violet-50/50 p-4 text-left shadow-sm transition hover:border-violet-300 hover:bg-violet-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-violet-200 disabled:cursor-wait disabled:opacity-60 sm:p-5"
              >
                <span className="text-xs font-black text-violet-500">歌 {index + 1}</span>
                <span className="mt-1 block text-xl font-black text-gray-800">{candidate.title}</span>
                <span className="mt-4 block space-y-2">
                  {candidate.lines.map((line, lineIndex) => (
                    <span key={`${candidate.candidateId}-${lineIndex}`} className="block rounded-xl border border-violet-100 bg-white px-3 py-2 text-sm font-bold leading-relaxed text-gray-700">
                      {line}
                    </span>
                  ))}
                </span>
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void handleFirstImpressionSelection("neither")}
            disabled={!!isCandidatePreviewLoading}
            className="mt-4 flex min-h-12 w-full items-center justify-center rounded-2xl border-2 border-gray-200 bg-white px-4 py-3 text-sm font-black text-gray-700 transition hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-gray-200 disabled:cursor-wait disabled:opacity-60"
          >
            どちらも違う
          </button>
          <p className="mt-3 text-center text-xs font-bold text-violet-700">最初に選んだ方を記録します。あとから聞き比べて、いまの一番を変えられます。</p>
        </section>
      </div>
    );
  };

  const experimentPitchedNotes = experimentScore?.notes.filter((note) => note.key !== null) ?? [];
  const experimentLastKey = experimentPitchedNotes.at(-1)?.key ?? null;
  const experimentTotalFrames = getScoreFrameLength(experimentScore);
  const playbackDrawing = selectedDemoDrawing ?? selectedDebugHistoryDrawing ?? generatedDrawing;
  const playbackLyricLineCount = getSingingLineCount(lyrics);
  const playbackAnimationEndProgress = getDrawingAnimationEndProgress(lyrics, playbackScore);
  const followUpFinalPreferenceSelection = finalPreferenceSelection ?? evaluationSelection;
  const canSendEvaluationFollowUp = isEvaluationCentrallySaved
    && !!evaluationReceipt
    && !!evaluationReceiptExpiresAt
    && Date.parse(evaluationReceiptExpiresAt) > Date.now();
  const releaseLabel = window.location.hostname.includes("-staging.")
    ? "確認版"
    : ["localhost", "127.0.0.1"].includes(window.location.hostname)
      ? "ローカル"
      : "公開版";
  const shortBuildId = appBuildId === "unknown" ? "unknown" : appBuildId.slice(0, 7);
  const visibleDemoRecords = showFavoriteOnly ? demoRecords.filter((record) => record.isFavorite) : demoRecords;
  const experimentScoreJson = serializeSingingScore(experimentScore);
  const canShowPrintLayout = !!lyrics && !!playbackDrawing && !isGenerating;
  const isTurnstileReady = !isTurnstileRequired || !!turnstileToken;
  const generationDisabled = !appFeatures.gemini || !isTurnstileReady;
  const generationDisabledMessage = !appFeatures.gemini
    ? "AI生成は現在準備中です。描画機能はそのまま利用できます。"
    : !TURNSTILE_SITE_KEY
      ? "安全確認の設定がまだ完了していません。管理者に知らせてね。"
      : turnstileStatus === "error"
        ? "安全確認を始められませんでした。通信を確認して、もう一度ためしてね。"
        : turnstileStatus === "expired"
          ? "安全確認をやり直しています…"
          : "安全確認中… 終わると歌をつくれます。";
  const turnstileSecurityCheck = isTurnstileRequired && TURNSTILE_SITE_KEY ? (
    <div className="flex w-full justify-center py-1">
      <Turnstile
        key={turnstileRetryKey}
        ref={turnstileWidgetRef}
        siteKey={TURNSTILE_SITE_KEY}
        action={TURNSTILE_ACTION}
        onToken={handleTurnstileToken}
        onStatusChange={handleTurnstileStatusChange}
      />
    </div>
  ) : null;
  const hasEnoughDrawing =
    drawingMetrics.strokeCount >= 3 ||
    (drawingMetrics.pointCount >= 60 && drawingMetrics.drawingDurationMs >= 500);
  const canvasGuideState = isGenerating || error || audioUrl
    ? null
    : hasEnoughDrawing
      ? appFeatures.gemini
        ? "generate"
        : null
      : drawingMetrics.strokeCount === 0
        ? "draw"
        : null;
  const initialPlaybackAriaLabel = playbackKind === "voice" ? "歌を再生する" : "アニメーションを再生する";

  const handleRecordConsentKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeRecordConsent();
      return;
    }

    if (event.key !== "Tab") return;

    const focusableElements: HTMLElement[] = recordConsentDialogRef.current
      ? Array.from(
        recordConsentDialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), select:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ) as HTMLElement[]
      : [];
    if (focusableElements.length === 0) return;

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  };

  const handleStartPrint = () => {
    if (!canShowPrintLayout) {
      return;
    }

    stopAudioPlayback();
    setAppView("print");
  };

  const openDebugExport = () => {
    if ((!debugExportSource && !debugExportArtifacts) || isGenerating) return;
    setDebugBundleError(null);
    setIsDebugExportOpen(true);
  };

  const closeDebugExport = () => {
    if (isDebugBundleDownloading) return;
    setIsDebugExportOpen(false);
  };

  const handleDownloadDebugBundle = async () => {
    if (!debugExportSource && !debugExportArtifacts) return;

    setIsDebugBundleDownloading(true);
    setDebugBundleError(null);
    try {
      const bundle = debugExportArtifacts
        ? await createDebugBundleFromArtifacts({ artifacts: debugExportArtifacts, reporterNote: debugReporterNote })
        : await createDebugBundle({
          source: debugExportSource!,
          reporterNote: debugReporterNote,
          buildId: appBuildId,
          mode: appConfig.mode,
          origin: window.location.origin,
        });
      downloadDebugBundle(bundle);
      setIsDebugExportOpen(false);
      setSaveToast({ message: "確認用ZIPを保存しました", tone: "success" });
    } catch (exportError) {
      setDebugBundleError(exportError instanceof Error ? exportError.message : "確認用ZIPを作成できませんでした。");
    } finally {
      setIsDebugBundleDownloading(false);
    }
  };

  const renderDebugExportButton = () => {
    if (isCompactMakerLayout || (!debugExportSource && !debugExportArtifacts) || isGenerating) return null;
    return (
      <button
        type="button"
        onClick={openDebugExport}
        className="absolute left-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-full border-2 border-violet-100 bg-white/85 text-violet-400 shadow-sm transition hover:border-violet-200 hover:bg-violet-50 hover:text-violet-600 active:scale-95"
        title="確認用ZIPを保存"
        aria-label="確認用ZIPを保存"
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 3v11m0 0 4-4m-4 4-4-4M5 15v4h14v-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    );
  };

  const handleCopyExperimentScore = async () => {
    if (!experimentScore) {
      return;
    }

    await copyTextToClipboard(experimentScoreJson);
  };

  const handleDownloadExperimentScore = () => {
    if (!experimentScore) {
      return;
    }

    const fileName = sanitizeFileName(`${experimentLyrics.title}-singing-score.json`);
    downloadTextFile(fileName, experimentScoreJson, "application/json;charset=utf-8");
  };

  if (appView === "print" && lyrics && playbackDrawing) {
    return (
      <PrintLayout
        lyrics={lyrics}
        drawingData={playbackDrawing}
        onBack={() => setAppView("maker")}
        autoPrint
      />
    );
  }

  return (
    <div className={`app-shell min-h-screen p-4 md:p-8 flex flex-col items-center ${appView === "maker" && isCompactMakerLayout ? `compact-maker-shell compact-maker-scene-${makerScene}` : ""}`}>
      {appView === "maker" && isCompactMakerLayout && isSceneTurnAnimating && (
        <div className="compact-page-turn" aria-hidden="true" />
      )}
      <button
        type="button"
        onClick={handleStartNewSong}
        className={`floating-reload fixed left-4 top-4 z-[80] flex h-12 w-12 items-center justify-center rounded-full border border-white/70 bg-white/90 text-orange-500 shadow-lg backdrop-blur-md transition-all hover:bg-orange-50 active:scale-95 ${appView === "maker" && isCompactMakerLayout ? "hidden" : ""}`}
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

      <button
        type="button"
        onClick={() => setIsShortcutHelpOpen((current) => !current)}
        className={`floating-help fixed bottom-4 left-4 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-white/70 bg-white/85 text-lg font-black text-gray-500 shadow-lg backdrop-blur-md transition-all hover:bg-orange-50 hover:text-orange-500 active:scale-95 ${appView === "maker" && isCompactMakerLayout ? "hidden" : ""}`}
        title="ショートカット一覧 (Ctrl+/)"
        aria-label="ショートカット一覧"
        aria-expanded={isShortcutHelpOpen}
        aria-controls="shortcut-help-panel"
      >
        ?
      </button>

      {isShortcutHelpOpen && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            className="absolute inset-0 bg-black/10"
            onClick={() => setIsShortcutHelpOpen(false)}
            aria-label="ショートカット一覧を閉じる"
          />
          <section
            id="shortcut-help-panel"
            className="absolute bottom-16 left-4 w-[min(92vw,30rem)] max-h-[70vh] overflow-auto rounded-3xl border border-white/80 bg-white/95 p-4 shadow-2xl backdrop-blur-md"
            role="dialog"
            aria-modal="false"
            aria-label="ショートカット一覧"
          >
            <div className="mb-3 flex items-center justify-between gap-3 border-b border-orange-100 pb-3">
              <div>
                <p className="text-xs font-black tracking-[0.24em] text-orange-400">キー操作</p>
                <h2 className="text-lg font-black text-gray-800">ショートカット一覧</h2>
              </div>
              <button
                type="button"
                onClick={() => setIsShortcutHelpOpen(false)}
                className="rounded-full bg-gray-100 px-3 py-1.5 text-xs font-black text-gray-600 transition-all hover:bg-gray-200"
              >
                閉じる
              </button>
            </div>

            <p className="mb-4 text-xs font-semibold leading-relaxed text-gray-500">
              画面右上のボタンとは別に、ひっそり開ける一覧です。Windows は Ctrl、Mac は Cmd を使います。
            </p>

            <div className="space-y-4">
              {APP_SHORTCUT_GROUPS
                .filter((group) => appFeatures.gemini || !group.requiresBackend)
                .map((group) => ({
                  ...group,
                  items: group.items.filter((item) => appFeatures.gemini || !item.requiresBackend),
                }))
                .map((group) => (
                  <section key={group.title} className="rounded-2xl border border-orange-100 bg-orange-50/40 p-3">
                    <h3 className="mb-2 text-sm font-black text-orange-600">{group.title}</h3>
                    <div className="space-y-2">
                      {group.items.map((item) => (
                        <div key={`${group.title}-${item.keys}`} className="flex gap-3 text-sm">
                          <span className="min-w-40 shrink-0 rounded-full bg-white px-3 py-1 font-black text-gray-700 shadow-sm">
                            {item.keys}
                          </span>
                          <span className="pt-1 font-semibold text-gray-600">{item.description}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
            </div>
          </section>
        </div>
      )}

      {isDebugExportOpen && (debugExportSource || debugExportArtifacts) && (
        <DebugExportDialog
          hasLyrics={debugExportArtifacts ? !!debugExportArtifacts.manifest.lyrics : !!debugExportSource?.lyrics}
          hasScore={debugExportArtifacts ? !!debugExportArtifacts.manifest.singingScore : !!debugExportSource?.singingScore}
          hasVoice={debugExportArtifacts ? !!debugExportArtifacts.voiceAudioBlob : debugExportSource?.playbackKind === "voice" && !!debugExportSource.voiceAudioBlob}
          hasError={debugExportArtifacts ? !!debugExportArtifacts.manifest.outcome.error || !!debugExportArtifacts.manifest.generation.voicevoxIssue : !!debugExportSource?.error || !!debugExportSource?.voicevoxIssue}
          reporterNote={debugReporterNote}
          isDownloading={isDebugBundleDownloading}
          downloadError={debugBundleError}
          onReporterNoteChange={setDebugReporterNote}
          onClose={closeDebugExport}
          onDownload={() => void handleDownloadDebugBundle()}
        />
      )}

      {renderFirstImpressionModal()}

      <EvaluationConsentModal
        open={isEvaluationConsentOpen}
        pending={isEvaluationSubmissionPending}
        savesInBrowser={appFeatures.debugHistory && !!debugExportSource}
        savesToCloud={canSaveEvaluationToCloud(evaluationDraftRef.current)}
        savesFullArchive={!!archiveGenerationTicketRef.current && !!creationArchiveSnapshotRef.current}
        onAccept={() => void handleEvaluationCentralConsent("accepted")}
        onDecline={() => void handleEvaluationCentralConsent("declined")}
      />

      <CreationArchiveManager
        open={isCreationArchiveManagerOpen}
        onClose={() => setIsCreationArchiveManagerOpen(false)}
        onToast={(message, tone) => setSaveToast({ message, tone })}
      />

      {isComparableCandidateSet(generatedLyricsCandidates) && followUpFinalPreferenceSelection !== null && (
        <EvaluationFollowUpModal
          open={isEvaluationFollowUpOpen}
          candidates={generatedLyricsCandidates}
          objectCandidates={generatedDrawingAnalysis?.objectCandidates ?? []}
          initialAnswers={{
            finalPreferenceSelection: followUpPreferencePrefill ?? followUpFinalPreferenceSelection,
            subjectFeedbackChoice,
            ratings: evaluationRatings,
          }}
          canSend={canSendEvaluationFollowUp}
          pending={isEvaluationFollowUpPending}
          onClose={() => {
            setIsEvaluationFollowUpOpen(false);
            setFollowUpPreferencePrefill(null);
          }}
          onSaveLocal={(answers) => void handleSaveEvaluationFollowUpLocally(answers)}
          onSend={(answers) => void handleSendEvaluationFollowUp(answers)}
        />
      )}

      {isRecordConsentOpen && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-900/30 px-4 py-6 backdrop-blur-sm"
          role="presentation"
          onClick={closeRecordConsent}
        >
          <section
            ref={recordConsentDialogRef}
            className="w-full max-w-lg rounded-3xl border-4 border-yellow-200 bg-white p-5 text-left shadow-2xl sm:p-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="record-consent-title"
            onKeyDown={handleRecordConsentKeyDown}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-5 border-b border-orange-100 pb-4">
              <p className="text-xs font-black tracking-[0.18em] text-orange-400">アプリの改善</p>
              <h2 id="record-consent-title" className="mt-1 text-2xl font-black leading-tight text-gray-800">
                絵を記録してもよいですか？（任意）
              </h2>
              <p className="mt-2 text-sm font-bold leading-relaxed text-gray-600">
                描いた絵と生成された絵描き歌を保存し、研究およびサービス改善のために使用してもよろしいですか？
              </p>
            </div>

            {!appConfig.hideParticipantAgeUi && <div className="mt-5 rounded-2xl border-2 border-orange-100 bg-orange-50/70 p-4">
              <label htmlFor="participant-age" className="mb-2 block text-sm font-black text-gray-700">
                年齢を選んでください（任意）
              </label>
              <select
                id="participant-age"
                value={participantAge ?? ""}
                onChange={(event) => {
                  setParticipantAge(event.target.value === "" ? null : Number(event.target.value));
                  setRecordConsentError(null);
                }}
                className="h-12 w-full rounded-2xl border-2 border-orange-200 bg-white px-4 text-base font-black text-gray-800 shadow-sm outline-none transition-all focus:border-orange-400 focus:ring-4 focus:ring-orange-100"
              >
                <option value="">未選択</option>
                {PARTICIPANT_AGE_OPTIONS.map((age) => (
                  <option key={age} value={age}>
                    {age}才
                  </option>
                ))}
              </select>
              {recordConsentError && (
                <p className="mt-2 text-sm font-black text-red-600" role="alert">
                  {recordConsentError}
                </p>
              )}
            </div>}

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <button
                ref={recordConsentPrimaryButtonRef}
                type="button"
                onClick={handleRecordAndGenerate}
                className="flex h-14 items-center justify-center rounded-2xl bg-orange-500 px-4 text-base font-black text-white shadow-md transition-all hover:bg-orange-600 active:scale-95"
              >
                記録してつくる
              </button>
              <button
                type="button"
                onClick={handleGenerateWithoutRecord}
                className="flex h-14 items-center justify-center rounded-2xl bg-yellow-400 px-4 text-base font-black text-gray-800 shadow-md transition-all hover:bg-yellow-500 active:scale-95"
              >
                記録しないでつくる
              </button>
              <button
                type="button"
                onClick={closeRecordConsent}
                className="flex h-12 items-center justify-center rounded-2xl bg-gray-200 px-4 text-sm font-black text-gray-700 shadow-sm transition-all hover:bg-gray-300 active:scale-95 sm:col-span-2"
              >
                もどる
              </button>
            </div>
          </section>
        </div>
      )}

      <header className={`magic-header mb-6 text-center ${appView === "maker" && isCompactMakerLayout ? "hidden" : ""}`}>
        {!isCompactMakerLayout && (appFeatures.localVoicevox || appFeatures.voicevox) && (
          <VoicevoxServerSelector
            selectedServer={voicevoxServerSelection}
            localBaseUrl={voicevoxBaseUrl}
            healthByServer={voicevoxServerHealth}
            onSelectServer={handleSelectVoicevoxServer}
            onLocalBaseUrlChange={setVoicevoxBaseUrl}
            onCheckServer={(server) => void checkVoicevoxServer(server)}
            disabled={isGenerating}
          />
        )}
        <p className="mb-2 text-xs font-black uppercase tracking-[0.24em] text-orange-600">絵が、魔法で歌になる！</p>
        <h1 className="mx-auto mb-1 w-fit">
          <img
            src="/logo.png"
            alt="超えかき歌！"
            className="h-14 w-auto drop-shadow-sm md:h-16"
          />
        </h1>
        <p className="text-sm text-gray-600 font-medium">絵を描くと、AI が歌詞を作り、ずんだもん（VOICEVOX）が歌ってくれます！</p>
        <div className="mt-4 inline-flex rounded-full border border-white/70 bg-white/80 p-1 shadow-md backdrop-blur-md">
          <button
            type="button"
            onClick={() => setAppView("maker")}
            title="メーカー (Ctrl+1 / Cmd+1)"
            className={`rounded-full px-5 py-2 text-sm font-black transition-all ${appView === "maker" ? "bg-orange-400 text-white shadow-sm" : "text-gray-600 hover:bg-orange-50"
              }`}
          >
            メーカー
          </button>
          {appFeatures.voicevox && isDevelopmentVoicevox() && <button
            type="button"
            onClick={() => setAppView("melodyExperiment")}
            title="実験 (Ctrl+2 / Cmd+2)"
            className={`rounded-full px-5 py-2 text-sm font-black transition-all ${appView === "melodyExperiment" ? "bg-orange-400 text-white shadow-sm" : "text-gray-600 hover:bg-orange-50"
              }`}
          >
            実験
          </button>}
          {appFeatures.demoRecords && <button
            type="button"
            onClick={() => setAppView("demoRecords")}
            title="デモ記録 (Ctrl+3 / Cmd+3)"
            className={`rounded-full px-5 py-2 text-sm font-black transition-all ${appView === "demoRecords" ? "bg-orange-400 text-white shadow-sm" : "text-gray-600 hover:bg-orange-50"
              }`}
          >
            デモ記録
          </button>}
          {appFeatures.debugHistory && !appFeatures.demoRecords && <button
            type="button"
            onClick={() => setAppView("debugHistory")}
            title="デモ記録"
            className={`rounded-full px-5 py-2 text-sm font-black transition-all ${appView === "debugHistory" ? "bg-violet-500 text-white shadow-sm" : "text-gray-600 hover:bg-violet-50"
              }`}
          >
            デモ記録
          </button>}
          {!isCompactPortraitLayout && <button
            type="button"
            onClick={() => setIsCreationArchiveManagerOpen(true)}
            title="クラウド保存した作品を確認・削除"
            className="rounded-full px-5 py-2 text-sm font-black text-gray-600 transition-all hover:bg-sky-50"
          >
            保存した作品
          </button>}
        </div>
      </header>

      {appView === "maker" && isCompactMakerLayout && (
        <div className="compact-maker-intro" aria-label="超えかき歌の説明">
          <img src="/logo.png" alt="超えかき歌！" />
          <p>絵を描くと、AI が歌詞を作り、ずんだもん（VOICEVOX）が歌ってくれます！</p>
          {(appFeatures.demoRecords || appFeatures.debugHistory) && (
            <button
              type="button"
              onClick={() => setAppView(appFeatures.demoRecords ? "demoRecords" : "debugHistory")}
              className="shrink-0 rounded-full border border-violet-200 bg-white px-3 py-2 text-xs font-black text-violet-700 shadow-sm"
              aria-label="デモ記録を開く"
            >
              🎵 デモ記録
            </button>
          )}
        </div>
      )}

      {appView === "debugHistory" && appFeatures.debugHistory ? (
        <DebugHistoryView
          onOpenRecord={handleOpenDebugHistoryRecord}
          onBack={() => setAppView("maker")}
          onToast={setSaveToast}
        />
      ) : appView === "demoRecords" ? (
        <main className="mb-16 w-full max-w-6xl">
          <section className="rounded-3xl border-8 border-orange-100 bg-white p-5 shadow-xl md:p-7">
            <div className="mb-5 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-2xl font-black text-gray-800">デモ記録</h2>
                <p className="text-sm font-semibold text-gray-500">
                  これまでに生成した絵描き歌を選ぶと、もう一度見返せます。
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {import.meta.env.DEV && <a href="/gallery" target="_blank" rel="noopener noreferrer" className="rounded-full border-2 border-yellow-300 bg-yellow-100 px-4 py-2 text-sm font-black text-orange-800 hover:bg-yellow-200">
                  展示ギャラリーを開く
                </a>}
                <div className="flex rounded-full bg-orange-50 p-1">
                  <button
                    type="button"
                    onClick={() => setDemoBrowseMode("drawings")}
                    className={`rounded-full px-4 py-2 text-sm font-black transition-all ${demoBrowseMode === "drawings" ? "bg-white text-orange-600 shadow-sm" : "text-gray-500"
                      }`}
                  >
                    絵の一覧
                  </button>
                  <button
                    type="button"
                    onClick={() => setDemoBrowseMode("songs")}
                    className={`rounded-full px-4 py-2 text-sm font-black transition-all ${demoBrowseMode === "songs" ? "bg-white text-orange-600 shadow-sm" : "text-gray-500"
                      }`}
                  >
                    歌の一覧
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => setShowFavoriteOnly((current) => !current)}
                  className={`rounded-full border px-4 py-2 text-sm font-black transition-all ${showFavoriteOnly
                    ? "border-orange-200 bg-orange-500 text-white shadow-sm"
                    : "border-orange-100 bg-white text-gray-600 hover:bg-orange-50"
                    }`}
                  title="お気に入りのみ表示"
                  aria-pressed={showFavoriteOnly}
                >
                  ★ お気に入りのみ
                </button>
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
            ) : visibleDemoRecords.length === 0 ? (
              <div className="flex min-h-64 items-center justify-center rounded-2xl border-4 border-dashed border-gray-200 text-center font-bold text-gray-400">
                {showFavoriteOnly ? "お気に入りのデモ記録がまだありません。" : "表示できる成功デモ記録がまだありません。"}
              </div>
            ) : demoBrowseMode === "drawings" ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                {visibleDemoRecords.map((record) => (
                  <div key={record.recordId} className="relative">
                    <button
                      type="button"
                      onClick={() => void handleSelectDemoRecord(record.recordId)}
                      className="group h-full w-full overflow-hidden rounded-2xl border-2 border-yellow-100 bg-yellow-50 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-orange-200 hover:shadow-md disabled:opacity-60"
                      disabled={loadingDemoRecordId !== null || updatingDemoRecordId === record.recordId || deletingDemoRecordId === record.recordId}
                    >
                      <div className="relative aspect-square bg-white">
                        <img src={record.imageUrl} alt={record.title} className="h-full w-full object-contain" loading="lazy" />
                        {record.isFavorite && (
                          <span className="absolute left-2 top-2 rounded-full bg-white/95 px-2 py-1 text-[10px] font-black text-orange-500 shadow-sm">
                            お気に入り
                          </span>
                        )}
                      </div>
                      <div className="p-3">
                        <p className="truncate text-sm font-black text-gray-800">{record.title}</p>
                        <div className="mt-1 flex items-center justify-between gap-2">
                          <p className="min-w-0 truncate text-xs font-bold text-orange-500">{record.identifiedObject}</p>
                          {!appConfig.hideParticipantAgeUi && record.participantAge !== null && (
                            <span className="shrink-0 text-[10px] font-bold text-gray-400">{record.participantAge}歳</span>
                          )}
                        </div>
                        {loadingDemoRecordId === record.recordId && (
                          <p className="mt-2 text-xs font-black text-gray-500">読み込み中...</p>
                        )}
                        {updatingDemoRecordId === record.recordId && (
                          <p className="mt-2 text-xs font-black text-orange-500">お気に入り更新中...</p>
                        )}
                        {deletingDemoRecordId === record.recordId && (
                          <p className="mt-2 text-xs font-black text-red-500">削除中...</p>
                        )}
                      </div>
                    </button>

                    <div className="absolute right-2 top-2 flex gap-1">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleToggleDemoRecordFavorite(record.recordId, !record.isFavorite);
                        }}
                        disabled={updatingDemoRecordId === record.recordId || deletingDemoRecordId === record.recordId}
                        className={`flex h-8 w-8 items-center justify-center rounded-full border shadow-sm transition-all active:scale-95 ${record.isFavorite
                          ? "border-orange-200 bg-orange-500 text-white hover:bg-orange-600"
                          : "border-white/80 bg-white/95 text-gray-500 hover:bg-orange-50 hover:text-orange-500"
                          }`}
                        title={record.isFavorite ? "お気に入りを外す" : "お気に入りにする"}
                        aria-label={record.isFavorite ? "お気に入りを外す" : "お気に入りにする"}
                      >
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill={record.isFavorite ? "currentColor" : "none"} aria-hidden="true">
                          <path
                            d="M12 3.75 14.94 9.7l6.56.95-4.75 4.63 1.12 6.53L12 18.96l-5.87 3.09 1.12-6.53L2.5 10.65l6.56-.95L12 3.75Z"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDeleteDemoRecord(record.recordId);
                        }}
                        disabled={updatingDemoRecordId === record.recordId || deletingDemoRecordId === record.recordId}
                        className="flex h-8 w-8 items-center justify-center rounded-full border border-white/80 bg-white/95 text-gray-500 shadow-sm transition-all hover:bg-red-50 hover:text-red-500 active:scale-95"
                        title="削除"
                        aria-label="削除"
                      >
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path
                            d="M4 7h16"
                            stroke="currentColor"
                            strokeWidth="1.9"
                            strokeLinecap="round"
                          />
                          <path
                            d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"
                            stroke="currentColor"
                            strokeWidth="1.9"
                            strokeLinecap="round"
                          />
                          <path
                            d="M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"
                            stroke="currentColor"
                            strokeWidth="1.9"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="divide-y divide-orange-50 overflow-hidden rounded-2xl border-2 border-orange-100">
                {visibleDemoRecords.map((record) => (
                  <div key={record.recordId} className="flex w-full items-stretch gap-2 bg-white px-4 py-3 transition-all hover:bg-orange-50">
                    <button
                      type="button"
                      onClick={() => void handleSelectDemoRecord(record.recordId)}
                      className="min-w-0 flex-1 text-left disabled:opacity-60"
                      disabled={loadingDemoRecordId !== null || updatingDemoRecordId === record.recordId || deletingDemoRecordId === record.recordId}
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 truncate text-base font-black text-gray-800">{record.title}</span>
                        {record.isFavorite && <span className="shrink-0 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-black text-orange-500">お気に入り</span>}
                        {!appConfig.hideParticipantAgeUi && record.participantAge !== null && (
                          <span className="shrink-0 text-[10px] font-bold text-gray-400">{record.participantAge}歳</span>
                        )}
                      </div>
                      <span className="mt-1 block text-xs font-bold text-gray-400">
                        {loadingDemoRecordId === record.recordId
                          ? "読み込み中..."
                          : updatingDemoRecordId === record.recordId
                            ? "お気に入り更新中..."
                            : deletingDemoRecordId === record.recordId
                              ? "削除中..."
                              : record.identifiedObject}
                      </span>
                    </button>

                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleToggleDemoRecordFavorite(record.recordId, !record.isFavorite);
                        }}
                        disabled={updatingDemoRecordId === record.recordId || deletingDemoRecordId === record.recordId}
                        className={`flex h-9 w-9 items-center justify-center rounded-full border shadow-sm transition-all active:scale-95 ${record.isFavorite
                          ? "border-orange-200 bg-orange-500 text-white hover:bg-orange-600"
                          : "border-white/80 bg-white text-gray-500 hover:bg-orange-50 hover:text-orange-500"
                          }`}
                        title={record.isFavorite ? "お気に入りを外す" : "お気に入りにする"}
                        aria-label={record.isFavorite ? "お気に入りを外す" : "お気に入りにする"}
                      >
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill={record.isFavorite ? "currentColor" : "none"} aria-hidden="true">
                          <path
                            d="M12 3.75 14.94 9.7l6.56.95-4.75 4.63 1.12 6.53L12 18.96l-5.87 3.09 1.12-6.53L2.5 10.65l6.56-.95L12 3.75Z"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDeleteDemoRecord(record.recordId);
                        }}
                        disabled={updatingDemoRecordId === record.recordId || deletingDemoRecordId === record.recordId}
                        className="flex h-9 w-9 items-center justify-center rounded-full border border-white/80 bg-white text-gray-500 shadow-sm transition-all hover:bg-red-50 hover:text-red-500 active:scale-95"
                        title="削除"
                        aria-label="削除"
                      >
                        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path d="M4 7h16" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                          <path
                            d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7"
                            stroke="currentColor"
                            strokeWidth="1.9"
                            strokeLinecap="round"
                          />
                          <path
                            d="M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"
                            stroke="currentColor"
                            strokeWidth="1.9"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
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

            <KaraokeLyricsPanel
              lyrics={experimentLyrics}
              audioRef={experimentAudioRef}
              singingScore={experimentScore}
              className="mt-2"
              showKanaLines
            />
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
              <div className="mt-5 rounded-2xl border-2 border-orange-100 bg-white p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-black text-gray-800">生成楽譜</h3>
                    <p className="text-xs font-bold text-gray-400">横幅が frame、色が key、灰色が休符です。</p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs font-black">
                    {[60, 64, 65, 67].map((key) => (
                      <span key={key} className={`rounded-full border px-3 py-1 ${getExperimentNoteToneClass(key)}`}>
                        {key}: {getExperimentNoteLabel(key)}
                      </span>
                    ))}
                    <span className={`rounded-full border px-3 py-1 ${getExperimentNoteToneClass(null)}`}>休符</span>
                  </div>
                </div>

                <div className="mb-4 rounded-2xl border border-orange-100 bg-orange-50/40 p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-black text-gray-700">VOICEVOX に送信した SingingScore</h4>
                      <p className="text-xs font-semibold text-gray-500">そのまま閲覧・コピー・ダウンロードできます。</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void handleCopyExperimentScore()}
                        className="rounded-full border border-orange-100 bg-white px-3 py-2 text-xs font-black text-gray-600 shadow-sm transition-all hover:bg-orange-50"
                      >
                        コピー
                      </button>
                      <button
                        type="button"
                        onClick={handleDownloadExperimentScore}
                        className="rounded-full border border-orange-100 bg-white px-3 py-2 text-xs font-black text-gray-600 shadow-sm transition-all hover:bg-orange-50"
                      >
                        DL
                      </button>
                    </div>
                  </div>
                  <textarea
                    readOnly
                    value={experimentScoreJson}
                    className="h-64 w-full rounded-2xl border border-orange-100 bg-white p-3 font-mono text-[11px] leading-relaxed text-gray-700 shadow-inner outline-none"
                  />
                </div>

                <div className="overflow-x-auto rounded-2xl border border-orange-50 bg-orange-50/40 p-3">
                  <div className="flex min-h-40 items-end gap-1">
                    {experimentScore.notes.map((note, index) => (
                      <div
                        key={`${note.lyric}-${note.key ?? "rest"}-${note.frame_length}-${index}`}
                        className={`flex h-32 shrink-0 flex-col justify-between rounded-lg border px-2 py-2 text-center shadow-sm ${getExperimentNoteToneClass(
                          note.key,
                        )}`}
                        style={{ width: `${getExperimentNoteWidth(note.frame_length)}px` }}
                        title={`${note.lyric || "休符"} / key: ${note.key ?? "-"} / frame: ${note.frame_length}`}
                      >
                        <span className="truncate text-base font-black">{note.lyric || "休"}</span>
                        <span className="text-xs font-black">{getExperimentNoteLabel(note.key)}</span>
                        <span className="text-[11px] font-black tabular-nums">{note.frame_length}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="mt-4 overflow-hidden rounded-2xl border border-orange-100">
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
              </div>
            )}
          </section>
        </main>
      ) : (
        <main className="maker-grid w-full max-w-6xl grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-8 items-start mb-16">
          <section className="canvas-stage min-w-0">
            <PaintCanvas
              onComplete={handleComplete}
              onClear={handleClear}
              onEditStart={handleDrawingEditStart}
              onDrawingMetricsChange={setDrawingMetrics}
              guideState={canvasGuideState}
              isGenerating={isGenerating}
              isInteractionBlocked={isRecordConsentOpen}
              generationStageLabel={progressLabel}
              generationTimingEstimate={generationTimingEstimate}
              generationProgressPhase={generationProgressPhase}
              generationRunKey={generationTimingRunKey}
              isGenerationProgressComplete={isGenerationProgressComplete}
              onGenerationProgressDisplayComplete={handleGenerationProgressDisplayComplete}
              generationDisabled={generationDisabled}
              generationDisabledMessage={generationDisabledMessage}
              generationDisabledRetry={
                isTurnstileRequired && TURNSTILE_SITE_KEY && (turnstileStatus === "error" || turnstileStatus === "expired")
                  ? retryTurnstile
                  : null
              }
              generationSecurityCheck={<>
                {turnstileSecurityCheck}
              </>}
              initialDrawing={playbackDrawing}
              playbackDrawing={playbackDrawing}
              playbackAudioRef={audioRef}
              playbackDisplayMode={drawingDisplayMode}
              playbackAnimationEndProgress={playbackAnimationEndProgress}
              playbackLineStrokeMappings={lyrics?.lineStrokeMappings}
              playbackScore={playbackScore}
              playbackLyricLineCount={playbackLyricLineCount}
              isPlaybackActive={!!lyrics && !!playbackDrawing && !isGenerating && isAudioPlaying}
              showInitialPlaybackPrompt={isInitialPlaybackPromptVisible}
              onInitialPlayback={handleInitialPlayback}
              initialPlaybackAriaLabel={initialPlaybackAriaLabel}
              mobileScene={isCompactMakerLayout ? makerScene : undefined}
              hideFocusControl={isCompactPortraitLayout && makerScene === "draw"}
              resetRequestKey={newSongResetKey}
            />

          </section>

          <section className="result-stage flex min-w-0 flex-col gap-6">
            {lyrics || isGenerating || error ? (
              <>
                <div className="magic-card bg-white p-5 sm:p-8 rounded-3xl shadow-xl border-8 border-orange-100 animate-fade-in relative min-h-[400px]">
                  {isGenerating ? (
                    <GenerationJourney stageLabel={progressLabel} drawingData={playbackDrawing} timingEstimate={generationTimingEstimate} progressPhase={generationProgressPhase} runKey={generationTimingRunKey} isComplete={isGenerationProgressComplete} onCompletionDisplayComplete={handleGenerationProgressDisplayComplete} />
                  ) : lyrics && !audioUrl ? (
                    <>
                      {error && (
                        <p className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800" role="alert">
                          歌詞はできましたが、歌声の生成に失敗しました。{error}
                        </p>
                      )}
                      {!isCompactMakerLayout && <button
                        type="button"
                        onClick={handleStartPrint}
                        disabled={!canShowPrintLayout}
                        className="absolute right-4 top-4 z-10 flex h-11 w-11 items-center justify-center rounded-full border-2 border-orange-100 bg-white text-orange-500 shadow-sm transition-all hover:border-orange-200 hover:bg-orange-50 hover:text-orange-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                        title="印刷する"
                        aria-label="印刷する"
                      >
                        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path d="M7 9V4h10v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M7 18H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M7 14h10v6H7z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>}
                      <div className="mb-6 border-b-2 border-orange-50 pb-4 pt-14 text-center">
                        <span className="inline-block px-4 py-1 bg-orange-100 text-orange-600 rounded-full text-sm font-bold mb-2">{lyrics.identifiedObject}</span>
                        <h2 ref={completionHeadingRef} tabIndex={-1} className="text-3xl font-bold text-gray-800 focus:outline-none">{lyrics.title}</h2>
                      </div>
                      <KaraokeLyricsPanel
                        lyrics={lyrics}
                        audioRef={audioRef}
                        singingScore={playbackScore}
                        className="mt-2"
                        showKanaLines={playbackKind === "voice"}
                      />
                      {renderAlternativeCandidateButton()}
                      {playbackKind === "voice" && (
                        <div className="mt-6 rounded-2xl border-2 border-orange-100 bg-orange-50/60 p-4">
                          <p className="mb-2 text-sm font-black text-gray-700">描く順番</p>
                          <div className="space-y-2 text-sm font-semibold text-gray-600">
                            {lyrics.lineStrokeMappings?.map((mapping) => <p key={mapping.lineIndex}>{mapping.lineIndex + 1}行目: {mapping.strokeGroupIds.length > 0 ? mapping.strokeGroupIds.join("、") : "対応する線なし"}</p>)}
                          </div>
                        </div>
                      )}
                      {renderDebugExportButton()}
                      {renderModelInfo()}
                    </>
                  ) : error ? (
                    <div className="flex min-h-[340px] flex-col items-center justify-center text-center" role="alert">
                      {renderDebugExportButton()}
                      <div className="mb-4 text-6xl" aria-hidden="true">🌙</div>
                      <h2 className="text-2xl font-black text-red-700">{generationFailureDisplay?.label ?? "AI生成失敗"}</h2>
                      <p className="mt-3 max-w-md font-bold leading-relaxed text-slate-600">
                        {generationFailureDisplay?.message ?? "絵はそのまま残っています。絵にもどって、もう一度ためしてみてね。"}
                      </p>
                      <p className="mt-3 text-xs font-bold text-slate-400">
                        診断コード: {generationFailureDisplay?.diagnosticCode ?? "AI-GENERATE"}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setError(null);
                          setGenerationFailureDisplay(null);
                        }}
                        className="mt-6 min-h-12 rounded-2xl bg-violet-600 px-6 py-3 font-black text-white shadow-lg"
                      >
                        絵にもどる
                      </button>
                    </div>
                  ) : lyrics ? (
                    <>
                      {renderDebugExportButton()}
                      {!isCompactMakerLayout && <button
                        type="button"
                        onClick={handleStartPrint}
                        disabled={!canShowPrintLayout}
                        className="absolute right-4 top-4 z-10 flex h-11 w-11 items-center justify-center rounded-full border-2 border-orange-100 bg-white text-orange-500 shadow-sm transition-all hover:border-orange-200 hover:bg-orange-50 hover:text-orange-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
                        title="印刷する"
                        aria-label="印刷する"
                      >
                        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path
                            d="M7 9V4h10v5"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <path
                            d="M7 18H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                          <path
                            d="M7 14h10v6H7z"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>}

                      <div className="mb-6 border-b-2 border-orange-50 pb-4 pt-14 text-center">
                        <span className="inline-block px-4 py-1 bg-orange-100 text-orange-600 rounded-full text-sm font-bold mb-2">
                          {lyrics.identifiedObject}
                        </span>
                        <h2 ref={completionHeadingRef} tabIndex={-1} className="text-3xl font-bold text-gray-800 focus:outline-none">{lyrics.title}</h2>
                        {selectedDemoRecordId && (
                          <p className="mt-2 text-xs font-bold text-gray-400">demo-records から読み込み済み</p>
                        )}
                      </div>

                      {isCompactMakerLayout && (
                        <p className="sr-only" role="status" aria-live="polite">
                          歌ができたよ。絵と歌詞を確認して、再生できます。
                        </p>
                      )}

                      <KaraokeLyricsPanel
                        lyrics={lyrics}
                        audioRef={audioRef}
                        singingScore={playbackScore}
                        className={isCompactMakerLayout ? "mobile-playback-lyrics" : "mt-2"}
                        title={isCompactMakerLayout ? lyrics.title : undefined}
                        showKanaLines={false}
                        compact={isCompactMakerLayout}
                      />

                      <div className={`mt-8 rounded-3xl border-2 border-yellow-100 bg-yellow-50/80 p-5 ${isCompactMakerLayout ? "mobile-playback-player" : ""}`}>
                        <div className="mb-4 flex justify-end">
                          <div className="flex rounded-full bg-white p-1 shadow-sm">
                            <button
                              type="button"
                              onClick={() => setDrawingDisplayMode("animated")}
                              className={`rounded-full px-4 py-2 text-sm font-black transition-all ${drawingDisplayMode === "animated" ? "bg-orange-400 text-white shadow-sm" : "text-gray-500"
                                }`}
                            >
                              アニメーション
                            </button>
                            <button
                              type="button"
                              onClick={() => setDrawingDisplayMode("static")}
                              className={`rounded-full px-4 py-2 text-sm font-black transition-all ${drawingDisplayMode === "static" ? "bg-orange-400 text-white shadow-sm" : "text-gray-500"
                                }`}
                            >
                              完成絵
                            </button>
                          </div>
                        </div>
                        <audio
                          ref={audioRef}
                          src={audioUrl ?? undefined}
                          controls
                          className="w-full"
                          aria-label={playbackKind === "voice" ? "歌声の再生" : "絵描き歌アニメーションの再生"}
                          onPlay={() => {
                            setIsInitialPlaybackPromptVisible(false);
                            setIsAudioPlaying(true);
                            setHasPlaybackStartedForGeneration(true);
                          }}
                          onPause={() => setIsAudioPlaying(false)}
                          onEnded={() => setIsAudioPlaying(false)}
                          onEmptied={() => setIsAudioPlaying(false)}
                        />
                        <p className="mt-3 text-center text-sm font-bold text-gray-600">
                          {playbackKind === "voice" ? "歌声に合わせて、絵を描く順番を見てみよう" : "音声なしで、絵を描く順番と歌詞を見てみよう"}
                        </p>
                      </div>

                      {voicevoxWarning && (
                        <p className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800" role="alert">
                          {isCompactMakerLayout
                            ? "歌声は作れませんでしたが、絵描き歌のアニメーションは再生できます。"
                            : `歌声は作れませんでしたが、絵描き歌のアニメーションは再生できます。${voicevoxWarning}`}
                        </p>
                      )}

                      {renderAlternativeCandidateButton()}
                      {renderEvaluationFollowUpControls()}
                      {renderModelInfo()}
                    </>
                  ) : null}
                </div>
                {lyrics && (
                  <button
                    type="button"
                    onClick={handleStartNewSong}
                    className="new-song-action min-h-12 w-full rounded-2xl border-2 border-orange-200 bg-orange-50 px-4 py-3 text-base font-black text-orange-700 shadow-sm transition hover:border-orange-300 hover:bg-orange-100 active:scale-[.98]"
                  >
                    新しい歌を作る
                  </button>
                )}
              </>
            ) : (
              <div className="magic-card h-full flex flex-col items-center justify-center p-8 sm:p-12 bg-white/80 border-4 border-dashed border-violet-200 rounded-3xl text-slate-500 text-center">
                <div className="text-6xl mb-4 animate-bounce">♪</div>
                <p className="text-xl font-bold">
                  キャンバスに好きな絵を描いてください。
                  <br />
                  歌詞づくりから歌声生成までまとめて進みます。
                </p>
              </div>
            )}
          </section>
        </main>
      )}

      {saveToast && (
        <div
          className={`fixed bottom-5 left-1/2 z-[60] -translate-x-1/2 rounded-full px-5 py-2 text-sm font-bold shadow-lg backdrop-blur-md animate-save-toast ${saveToast.tone === "success" ? "bg-gray-900/75 text-white" : "bg-red-600/80 text-white"
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
