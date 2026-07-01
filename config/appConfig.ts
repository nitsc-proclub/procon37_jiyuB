const isDeploymentPreview = import.meta.env.VITE_APP_MODE === "deployment-preview";

export const appConfig = {
  mode: isDeploymentPreview ? "deployment-preview" : "full",
  isDeploymentPreview,
} as const;

export const appFeatures = {
  gemini: !isDeploymentPreview,
  voicevox: !isDeploymentPreview,
  demoRecords: !isDeploymentPreview,
  dataSaving: !isDeploymentPreview,
} as const;
