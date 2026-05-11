const DEV_VOICEVOX_BASE_URL = "/voicevox";
const PROD_VOICEVOX_BASE_URL = "http://127.0.0.1:50021";

export const getVoicevoxBaseUrl = () => (import.meta.env.DEV ? DEV_VOICEVOX_BASE_URL : PROD_VOICEVOX_BASE_URL);

const readErrorText = async (response: Response) => {
  try {
    return await response.text();
  } catch {
    return "";
  }
};

export const ensureVoicevoxOk = async (response: Response, defaultMessage: string) => {
  if (response.ok) {
    return;
  }

  const details = await readErrorText(response);
  const suffix = details ? ` ${details}` : "";
  throw new Error(`${defaultMessage} (${response.status})${suffix}`);
};
