declare const __APP_BUILD_ID__: string | undefined;

/** Set by Vite from the build checkout. It intentionally never contains secrets. */
export const appBuildId = typeof __APP_BUILD_ID__ === "string" && __APP_BUILD_ID__.trim() ? __APP_BUILD_ID__ : "unknown";
