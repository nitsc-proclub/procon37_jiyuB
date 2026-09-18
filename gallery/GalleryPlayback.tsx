import React, { useEffect, useRef, useState } from "react";
import DrawingPlaybackCanvas from "../components/DrawingPlaybackCanvas";
import KaraokeLyricsPanel from "../components/KaraokeLyricsPanel";
import type { DemoRecordDetail } from "../types";
import { getDrawingAnimationEndProgress, getSingingLineCount } from "../utils/playbackTiming";
import { GALLERY_SETTINGS } from "./model";

type Props = {
  recordId: string | null;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  volume: number;
  onVolume: (volume: number) => void;
  onBack: () => void;
  onPrint: (record: DemoRecordDetail) => void;
};

export default function GalleryPlayback({ recordId, audioRef, volume, onVolume, onBack, onPrint }: Props) {
  const [record, setRecord] = useState<DemoRecordDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsPlay, setNeedsPlay] = useState(false);
  const [displayMode, setDisplayMode] = useState<"animated" | "static">("animated");
  const returnTimer = useRef<number | null>(null);
  const backRef = useRef(onBack);
  backRef.current = onBack;
  const clearReturn = () => {
    if (returnTimer.current !== null) window.clearTimeout(returnTimer.current);
    returnTimer.current = null;
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.volume = volume;
  }, [audioRef, volume]);

  useEffect(() => {
    const audio = audioRef.current;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    clearReturn();
    audio?.pause();
    audio?.removeAttribute("src");
    audio?.load();
    setRecord(null); setError(null); setNeedsPlay(false); setDisplayMode("animated");
    if (recordId) {
      void (async () => {
        try {
          const response = await fetch(`/api/demo-records/${encodeURIComponent(recordId)}`, { signal: controller.signal, cache: "no-store" });
          if (!response.ok) throw new Error("この作品を読み込めませんでした。");
          const detail = await response.json() as DemoRecordDetail;
          if (!detail.audioUrl) throw new Error("この作品には音声がありません。");
          const audioResponse = await fetch(detail.audioUrl, { signal: controller.signal });
          if (!audioResponse.ok) throw new Error("音声を読み込めませんでした。");
          const blob = await audioResponse.blob();
          if (!blob.size) throw new Error("音声を読み込めませんでした。");
          if (controller.signal.aborted || !audio) return;
          objectUrl = URL.createObjectURL(blob);
          audio.src = objectUrl;
          setRecord(detail);
        } catch (error) {
          if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "作品を読み込めませんでした。");
        }
      })();
    }
    return () => {
      controller.abort();
      clearReturn();
      audio?.pause();
      audio?.removeAttribute("src");
      audio?.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [recordId, audioRef]);

  // Start only after both canvas and lyrics have mounted around the same audio
  // clock. Cleanup prevents a slow request from starting after the visitor left.
  useEffect(() => {
    if (!record) return;
    let active = true;
    const audio = audioRef.current;
    void audio?.play().catch(() => { if (active) setNeedsPlay(true); });
    return () => { active = false; };
  }, [record, audioRef]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!record || event.isComposing || event.repeat || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey
        || target?.isContentEditable || target?.matches("input, textarea, select")) return;
      if (event.key.toLowerCase() !== "p") return;

      event.preventDefault();
      clearReturn();
      audioRef.current?.pause();
      onPrint(record);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [audioRef, onPrint, record]);

  return <section className="gallery-playback" hidden={!recordId} aria-label="絵描き歌の再生">
    <button type="button" className="gallery-back" onClick={onBack}><span aria-hidden="true">←</span> 一覧にもどる</button>
    {!record && <div className="gallery-player-message" role="status">{error ?? "歌を準備しています…"}</div>}
    <div className="gallery-player-grid" style={{ visibility: record ? "visible" : "hidden" }}>
      <div className="gallery-canvas">
        {record && <DrawingPlaybackCanvas drawingData={record.drawingData} audioRef={audioRef} mode={displayMode}
          lineStrokeMappings={record.lyrics.lineStrokeMappings} singingScore={record.singingScore}
          lyricLineCount={getSingingLineCount(record.lyrics)} animationEndProgress={getDrawingAnimationEndProgress(record.lyrics, record.singingScore)} />}
      </div>
      <div className="gallery-song-panel">
        {record && <>
          <h1>{record.title}</h1>
          <KaraokeLyricsPanel lyrics={record.lyrics} audioRef={audioRef} singingScore={record.singingScore} showKanaLines={false} className="gallery-karaoke" />
        </>}
        <div className="gallery-audio-panel">
          <div className="gallery-display-toggle" role="group" aria-label="絵の表示">
            <button type="button" aria-pressed={displayMode === "animated"} onClick={() => setDisplayMode("animated")}>アニメーション</button>
            <button type="button" aria-pressed={displayMode === "static"} onClick={() => setDisplayMode("static")}>完成した絵</button>
          </div>
          <audio ref={audioRef} controls aria-label="歌声の再生" preload="auto"
            onPlay={() => { clearReturn(); setNeedsPlay(false); }}
            onVolumeChange={() => { const audio = audioRef.current; if (audio) onVolume(audio.volume); }}
            onSeeking={clearReturn}
            onEnded={() => { clearReturn(); returnTimer.current = window.setTimeout(() => { if (audioRef.current?.ended) backRef.current(); }, GALLERY_SETTINGS.returnAfterMs); }}
            onError={() => { if (audioRef.current?.getAttribute("src")) setError("音声を再生できませんでした。一覧からもう一度選んでください。"); }} />
          {needsPlay && <button className="gallery-start-play" type="button" onClick={() => { void audioRef.current?.play().catch(() => setNeedsPlay(true)); }}>▶ 歌を再生する</button>}
          {record && error && <p role="alert">{error}</p>}
        </div>
      </div>
    </div>
  </section>;
}
