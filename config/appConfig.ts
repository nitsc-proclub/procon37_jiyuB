const isDeploymentPreview = import.meta.env.VITE_APP_MODE === "deployment-preview";

export const appConfig = {
  mode: isDeploymentPreview ? "deployment-preview" : "full",
  isDeploymentPreview,
} as const;

export const appFeatures = {
  // The Worker route holds the Gemini key as a Cloudflare Secret.
  gemini: true,
  // Public builds may talk only to a VOICEVOX Engine on the visitor's own
  // loopback interface. This is separate from the local-only experiment UI.
  localVoicevox: true,
  voicevox: !isDeploymentPreview,
  demoRecords: !isDeploymentPreview,
  dataSaving: !isDeploymentPreview,
  generationTelemetry: !isDeploymentPreview,
  // Public debug records stay entirely in the visitor's IndexedDB.
  debugHistory: isDeploymentPreview,
} as const;
