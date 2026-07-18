import { DemoRecordDetail, DemoRecordSummary, DrawingData, LyricsResponse, SingingScore, UsageStats } from "../types";

type DemoRecordStatus = "success" | "error";

interface DemoRecordMetadata {
  status: DemoRecordStatus;
  favorite: boolean;
  startedAt: string;
  completedAt: string;
  participantAge: number | null;
  participant: {
    age: number | null;
  };
  aiModel: string | null;
  lyrics: LyricsResponse | null;
  error: string | null;
  drawing: {
    strokeCount: number;
    strokes: DrawingData["strokes"];
    strokeGroups?: DrawingData["strokeGroups"];
    canvasSize?: DrawingData["canvasSize"];
    lineWidth?: DrawingData["lineWidth"];
  };
  singingScore: SingingScore | null;
}

interface SaveDemoRecordParams {
  drawingData: DrawingData;
  lyrics: LyricsResponse | null;
  audioBlob: Blob | null;
  singingScore: SingingScore | null;
  error: string | null;
  startedAt: string;
  participantAge: number | null;
  aiModel: string | null;
}

const blobToDataUri = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read blob"));
    reader.readAsDataURL(blob);
  });

export const saveDemoRecord = async ({
  drawingData,
  lyrics,
  audioBlob,
  singingScore,
  error,
  startedAt,
  participantAge,
  aiModel,
}: SaveDemoRecordParams) => {
  const completedAt = new Date().toISOString();
  const metadata: DemoRecordMetadata = {
    status: error ? "error" : "success",
    favorite: false,
    startedAt,
    completedAt,
    participantAge,
    participant: {
      age: participantAge,
    },
    aiModel,
    lyrics,
    error,
    drawing: {
      strokeCount: drawingData.strokes.length,
      strokes: drawingData.strokes,
      strokeGroups: drawingData.strokeGroups,
      canvasSize: drawingData.canvasSize,
      lineWidth: drawingData.lineWidth,
    },
    singingScore,
  };

  const response = await fetch("/api/demo-records", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      imageDataUri: drawingData.imageUri,
      audioDataUri: audioBlob ? await blobToDataUri(audioBlob) : null,
      metadata,
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(details || `Failed to save demo record (${response.status})`);
  }

  return (await response.json()) as { recordId: string; directory: string };
};

const fetchDemoRecordJson = async <T>(url: string, init?: RequestInit) => {
  const response = await fetch(url, init);

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(details || `Failed to fetch demo records (${response.status})`);
  }

  return (await response.json()) as T;
};

export const listDemoRecords = () =>
  fetchDemoRecordJson<{ records: DemoRecordSummary[] }>("/api/demo-records").then(({ records }) => records);

export const getUsageStats = () =>
  fetchDemoRecordJson<UsageStats>("/api/demo-records/stats");

export const recordExperience = (recorded: boolean, experienceId: string) =>
  fetchDemoRecordJson<UsageStats>("/api/demo-records/stats", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recorded, experienceId }),
  });

export const getDemoRecord = (recordId: string) =>
  fetchDemoRecordJson<DemoRecordDetail>(`/api/demo-records/${encodeURIComponent(recordId)}`);

export const setDemoRecordFavorite = (recordId: string, favorite: boolean) =>
  fetchDemoRecordJson<{ recordId: string; isFavorite: boolean }>(`/api/demo-records/${encodeURIComponent(recordId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ favorite }),
  });

export const deleteDemoRecord = async (recordId: string) => {
  const response = await fetch(`/api/demo-records/${encodeURIComponent(recordId)}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(details || `Failed to delete demo record (${response.status})`);
  }
};
