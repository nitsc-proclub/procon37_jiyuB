import { appFeatures } from "../config/appConfig";
import { getDemoRecord, listDemoRecords } from "../services/demoRecordService";
import { getDebugHistoryRecord, listDebugHistoryGalleryRecords, type DebugHistoryRecord } from "../services/debugHistoryDb";
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
    if (appFeatures.demoRecords) return { records: await listDemoRecords(), skippedCount: 0, dispose };
    const records: DemoRecordSummary[] = [];
    const snapshot = await listDebugHistoryGalleryRecords();
    for (const { summary, imageBlob } of snapshot.records) {
      const imageUrl = URL.createObjectURL(imageBlob);
      urls.push(imageUrl);
      records.push({ recordId: summary.recordId, savedAt: summary.createdAt, title: summary.title,
        identifiedObject: summary.identifiedObject, imageUrl, audioUrl: null, hasAudio: true,
        participantAge: null, isFavorite: summary.isFavorite === true });
    }
    return { records, skippedCount: snapshot.skippedCount, dispose };
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
