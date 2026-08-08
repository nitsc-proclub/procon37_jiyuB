const isDeploymentPreview = import.meta.env.VITE_APP_MODE === "deployment-preview";

export const appConfig = {
  mode: isDeploymentPreview ? "deployment-preview" : "full",
  isDeploymentPreview,
} as const;

export const appFeatures = {
  // The Worker route holds the Gemini key as a Cloudflare Secret. VOICEVOX
  // remains intentionally unavailable in the public deployment for Goal 1.
  gemini: true,
  voicevox: !isDeploymentPreview,
  demoRecords: !isDeploymentPreview,
  dataSaving: !isDeploymentPreview,
  generationTelemetry: !isDeploymentPreview,
} as const;
