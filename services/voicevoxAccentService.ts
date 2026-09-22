import { ensureVoicevoxOk, fetchLocalVoicevox, isDevelopmentVoicevox } from "./voicevoxHttp";
import { buildAlignedAccentHint, type VoicevoxAccentPhrase, type VoicevoxAccentAnalysis } from "./voicevoxAccentAlignment";
export { buildAlignedAccentHint } from "./voicevoxAccentAlignment";
const TALK_ACCENT_SPEAKER = 3;

const analyzeAccentLine = async (line: string) => {
  if (!isDevelopmentVoicevox()) {
    throw new Error("アクセント解析は開発時のローカルVOICEVOXでのみ利用できます。");
  }

  const query = new URLSearchParams({
    speaker: String(TALK_ACCENT_SPEAKER),
    text: line,
  });
  const response = await fetchLocalVoicevox(`/accent_phrases?${query.toString()}`, {
    method: "POST",
  });

  await ensureVoicevoxOk(response, "VOICEVOX のアクセント解析に失敗しました。");

  return (await response.json()) as VoicevoxAccentPhrase[];
};

export const analyzeAccentLines = async (lines: string[]): Promise<VoicevoxAccentAnalysis> => {
  const phrasesByLine = await Promise.all(lines.map((line) => analyzeAccentLine(line)));

  return {
    hints: phrasesByLine.map((phrases, index) => buildAlignedAccentHint(lines[index], phrases)),
    phrasesByLine,
  };
};
