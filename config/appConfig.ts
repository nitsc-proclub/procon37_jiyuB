import { resolveGeminiImageMaxDimension, resolveLyricsCandidateCount, resolveParticipantAgeUiHidden } from "./generationConfig";

const isDeploymentPreview = import.meta.env.VITE_APP_MODE === "deployment-preview";
const isProductionBuild = import.meta.env.PROD;

export const appConfig = {
  mode: isDeploymentPreview ? "deployment-preview" : "full",
  isDeploymentPreview,
  lyricsCandidateCount: resolveLyricsCandidateCount(import.meta.env.VITE_LYRICS_CANDIDATE_COUNT),
  geminiImageMaxDimension: resolveGeminiImageMaxDimension(import.meta.env.VITE_GEMINI_IMAGE_MAX_DIMENSION),
  hideParticipantAgeUi: resolveParticipantAgeUiHidden(import.meta.env.VITE_HIDE_PARTICIPANT_AGE),
} as const;

export const appFeatures = {
  // Temporary browser-only saving policy; keep cloud implementation for later.
  cloudSaving: false,
  gallery: !isDeploymentPreview,
  // The Worker route holds the Gemini key as a Cloudflare Secret.
  gemini: true,
  // Public builds may talk only to a VOICEVOX Engine on the visitor's own
  // loopback interface. This is separate from the local-only experiment UI.
  localVoicevox: true,
  voicevox: !isDeploymentPreview,
  // The legacy demo-records API is a Vite-only local middleware. Public
  // Worker builds must not expose its consent UI or call the missing route.
  demoRecords: !isDeploymentPreview && !isProductionBuild,
  dataSaving: !isDeploymentPreview && !isProductionBuild,
  generationTelemetry: !isDeploymentPreview && !isProductionBuild,
  // Public debug records stay entirely in the visitor's IndexedDB. The
  // deployment-preview flag remains useful for a built local confirmation
  // version, while production builds use the same browser-only boundary.
  debugHistory: isDeploymentPreview || isProductionBuild,
} as const;
