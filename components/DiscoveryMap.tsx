import React, { useMemo, useState } from "react";
import { DrawingData, LyricsResponse, SingingScore, StrokeBounds, StrokeGroup } from "../types";
import { buildLineTimings, getLineStartTimeSeconds } from "../utils/playbackTiming";

type DiscoveryMapProps = {
  drawingData: DrawingData;
  lyrics: LyricsResponse;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  singingScore?: SingingScore | null;
};

const getStrokeBounds = (drawingData: DrawingData, strokeIndex: number): StrokeBounds => {
  const points = drawingData.strokes[strokeIndex]?.points ?? [];
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
};

const getGroups = (drawingData: DrawingData): StrokeGroup[] =>
  drawingData.strokeGroups?.length
    ? drawingData.strokeGroups
    : drawingData.strokes.map((stroke, index) => ({
        id: `legacy-${index + 1}`,
        rawStrokeIndexes: [index],
        bounds: getStrokeBounds(drawingData, index),
        startTime: stroke.startTime,
        endTime: stroke.endTime,
        length: stroke.points.length,
      }));

type HotspotPosition = { left: number; top: number };

const spreadHotspots = (origins: HotspotPosition[]) => {
  const placed: HotspotPosition[] = [];
  const minimumDistance = 14;
  const clamp = (value: number) => Math.max(7, Math.min(93, value));
  const distance = (a: HotspotPosition, b: HotspotPosition) => Math.hypot(a.left - b.left, a.top - b.top);

  origins.forEach((origin, index) => {
    const candidates: HotspotPosition[] = [{ left: clamp(origin.left), top: clamp(origin.top) }];
    for (let ring = 1; ring <= 4; ring += 1) {
      for (let step = 0; step < 12; step += 1) {
        const angle = ((step + index * 5) / 12) * Math.PI * 2;
        candidates.push({
          left: clamp(origin.left + Math.cos(angle) * minimumDistance * ring),
          top: clamp(origin.top + Math.sin(angle) * minimumDistance * ring),
        });
      }
    }

    const separated = candidates.find((candidate) => placed.every((other) => distance(candidate, other) >= minimumDistance));
    const bestFallback = candidates.reduce((best, candidate) => {
      const nearest = placed.length ? Math.min(...placed.map((other) => distance(candidate, other))) : Number.POSITIVE_INFINITY;
      return nearest > best.nearest ? { position: candidate, nearest } : best;
    }, { position: candidates[0], nearest: -1 });
    placed.push(separated ?? bestFallback.position);
  });

  return placed;
};

const DiscoveryMap: React.FC<DiscoveryMapProps> = ({ drawingData, lyrics, audioRef, singingScore }) => {
  const groups = useMemo(() => getGroups(drawingData), [drawingData]);
  const [activeIndex, setActiveIndex] = useState(0);
  const sourceSize = useMemo(() => drawingData.canvasSize ?? {
    width: Math.max(1, ...drawingData.strokes.flatMap((stroke) => stroke.points.map((point) => point.x))),
    height: Math.max(1, ...drawingData.strokes.flatMap((stroke) => stroke.points.map((point) => point.y))),
  }, [drawingData]);
  const hotspotPositions = useMemo(
    () => spreadHotspots(groups.map((group) => ({
      left: ((group.bounds.minX + group.bounds.maxX) / 2 / sourceSize.width) * 100,
      top: ((group.bounds.minY + group.bounds.maxY) / 2 / sourceSize.height) * 100,
    }))),
    [groups, sourceSize.height, sourceSize.width],
  );
  const groupLineMap = useMemo(() => {
    const result = new Map<string, number>();
    lyrics.lineStrokeMappings?.forEach((mapping) => {
      mapping.strokeGroupIds.forEach((groupId) => {
        if (!result.has(groupId)) result.set(groupId, mapping.lineIndex);
      });
    });
    return result;
  }, [lyrics.lineStrokeMappings]);
  const lineTimings = useMemo(() => buildLineTimings(singingScore, lyrics.lines.length), [lyrics.lines.length, singingScore]);
  const activeGroup = groups[activeIndex] ?? null;
  const mappedLineIndex = activeGroup ? groupLineMap.get(activeGroup.id) : undefined;
  const displayLineIndex = mappedLineIndex ?? (lyrics.lines.length > 0 ? activeIndex % lyrics.lines.length : -1);

  const selectGroup = (index: number) => {
    const safeIndex = Math.max(0, Math.min(groups.length - 1, index));
    setActiveIndex(safeIndex);
    const group = groups[safeIndex];
    const lineIndex = group ? groupLineMap.get(group.id) : undefined;
    const audio = audioRef.current;
    if (lineIndex === undefined || !audio) return;

    const timing = lineTimings[lineIndex];
    if (!timing) return;
    const startTime = getLineStartTimeSeconds(timing, audio.duration, singingScore, lyrics.lines.length);
    if (startTime === null) return;
    audio.currentTime = startTime;
    void audio.play().catch((playError) => {
      if (import.meta.env.DEV) console.error("Failed to play discovery point", playError);
    });
  };

  if (groups.length === 0) {
    return <p className="rounded-2xl bg-yellow-50 p-5 text-center font-bold text-slate-600">この絵は、まるごとひとつの発見だよ。</p>;
  }

  return (
    <section aria-labelledby="discovery-map-title">
      <div className="mb-4 text-center">
        <h3 id="discovery-map-title" className="text-2xl font-black text-slate-800">絵の中を たんけんしよう</h3>
        <p className="mt-1 text-sm font-bold text-slate-500">番号をタップすると、その線のことばが見つかるよ</p>
      </div>
      <div className="relative aspect-square overflow-hidden rounded-3xl border-4 border-yellow-200 bg-white shadow-inner">
        <img src={drawingData.imageUri} alt="描いた絵の発見マップ" className="h-full w-full object-contain" />
        {groups.map((group, index) => {
          const position = hotspotPositions[index];
          const isActive = index === activeIndex;
          return (
            <button
              key={group.id}
              type="button"
              onClick={() => selectGroup(index)}
              aria-pressed={isActive}
              aria-label={`発見 ${index + 1}をひらく`}
              className={`absolute flex min-h-11 min-w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-4 font-black shadow-lg focus-visible:outline focus-visible:outline-4 focus-visible:outline-orange-400 ${isActive ? "z-20 border-orange-700 bg-orange-500 text-white" : "z-10 border-white bg-yellow-300 text-slate-800"}`}
              style={{ left: `${position.left}%`, top: `${position.top}%` }}
            >
              {isActive ? "✓" : index + 1}
            </button>
          );
        })}
      </div>
      <div className="mt-4 rounded-3xl border-2 border-orange-200 bg-orange-50 p-4 text-center" role="status" aria-live="polite">
        <p className="text-xs font-black text-orange-700">発見 {activeIndex + 1} / {groups.length}</p>
        <p className="mt-1 text-xl font-black text-slate-800">{displayLineIndex >= 0 ? lyrics.lines[displayLineIndex] : "どんなことばが似合うかな？"}</p>
        {mappedLineIndex === undefined && <p className="mt-1 text-xs font-bold text-slate-500">この線には、近くの歌詞を組み合わせているよ</p>}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <button type="button" onClick={() => selectGroup((activeIndex - 1 + groups.length) % groups.length)} className="min-h-11 rounded-2xl bg-slate-100 px-4 font-black text-slate-700">← まえ</button>
        <button type="button" onClick={() => audioRef.current?.pause()} className="min-h-11 rounded-2xl border-2 border-orange-200 bg-white px-2 font-black text-orange-700">■ とめる</button>
        <button type="button" onClick={() => selectGroup((activeIndex + 1) % groups.length)} className="min-h-11 rounded-2xl bg-orange-500 px-4 font-black text-white">つぎ →</button>
      </div>
      <div className="mt-3 flex flex-wrap justify-center gap-2" aria-label="発見の一覧">
        {groups.map((group, index) => (
          <button key={group.id} type="button" onClick={() => selectGroup(index)} aria-label={`発見 ${index + 1}`} aria-current={index === activeIndex ? "step" : undefined} className="min-h-11 min-w-11 rounded-xl border-2 border-yellow-200 bg-white px-3 font-black text-slate-700">
            {index === activeIndex ? `● ${index + 1}` : index + 1}
          </button>
        ))}
      </div>
    </section>
  );
};

export default DiscoveryMap;
