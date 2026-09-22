import { appFeatures } from "../config/appConfig";
import { getDemoRecord, listDemoRecords } from "../services/demoRecordService";
import { getDebugHistoryRecord, listDebugHistoryRecords, type DebugHistoryRecord } from "../services/debugHistoryDb";
import type { DemoRecordDetail, DemoRecordSummary } from "../types";

function browserDetail(record: DebugHistoryRecord, urls: string[]): DemoRecordDetail {
  const url = (blob: Blob) => { const value = URL.createObjectURL(blob); urls.push(value); return value; };
  const imageUrl = url(record.artifacts.imageBlob);
  const manifest = record.manifest;
  if (!manifest.lyrics) throw new Error("この作品には歌詞がありません。");
  return {
    recordId: record.recordId, savedAt: record.createdAt, title: record.title,
    identifiedObject: record.identifiedObject, imageUrl,
    audioUrl: record.artifacts.voiceAudioBlob ? url(record.artifacts.voiceAudioBlob) : null,
    participantAge: null, isFavorite: record.isFavorite === true, lyrics: manifest.lyrics,
    singingScore: manifest.singingScore,
    drawingData: { imageUri: imageUrl, strokes: manifest.drawing.strokes, strokeGroups: manifest.drawing.strokeGroups,
      canvasSize: manifest.drawing.canvasSize ?? undefined, lineWidth: manifest.drawing.lineWidth ?? undefined },
  };
}

export async function loadGalleryRecords() {
  const urls: string[] = [];
  const dispose = () => urls.forEach(url => URL.revokeObjectURL(url));
  try {
    if (appFeatures.demoRecords) return { records: await listDemoRecords(), dispose };
    const records: DemoRecordSummary[] = [];
    for (const summary of await listDebugHistoryRecords()) {
      if (!summary.hasVoice || !summary.manifest.lyrics) continue;
      const record = await getDebugHistoryRecord(summary.recordId);
      if (record) records.push(browserDetail(record, urls));
    }
    return { records, dispose };
  } catch (error) { dispose(); throw error; }
}

export async function loadGalleryRecord(recordId: string) {
  const urls: string[] = [];
  const dispose = () => urls.forEach(url => URL.revokeObjectURL(url));
  try {
    if (appFeatures.demoRecords) return { record: await getDemoRecord(recordId), dispose };
    const record = await getDebugHistoryRecord(recordId);
    if (!record) throw new Error("この作品が見つかりませんでした。");
    return { record: browserDetail(record, urls), dispose };
  } catch (error) { dispose(); throw error; }
}
