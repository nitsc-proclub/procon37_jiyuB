import React, { useEffect, useMemo, useRef } from 'react';
import type { DrawingData } from '../../types';
import { LEAD_FRAMES, LINE_FRAMES, FPS, SONG_SECONDS } from '../shared';

export function drawingBounds(drawing: DrawingData) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const stroke of drawing.strokes ?? []) for (const p of stroke.points) { left = Math.min(left, p.x); top = Math.min(top, p.y); right = Math.max(right, p.x); bottom = Math.max(bottom, p.y); }
  if (!Number.isFinite(left)) return { left: 0, top: 0, right: 1024, bottom: 1024, width: 1024, height: 1024 };
  return { left, top, right, bottom, width: Math.max((drawing.lineWidth ?? 8) * 4, right - left), height: Math.max((drawing.lineWidth ?? 8) * 4, bottom - top) };
}

export default function Drawing({ drawing, mappings, seconds = 0, clock, complete = false, loop = false }: { drawing: DrawingData; mappings?: { lineIndex: number; strokeGroupIds: string[] }[]; seconds?: number; clock?: () => number; complete?: boolean; loop?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const geometry = useMemo(() => {
    const lineByStroke = new Map<number, number>();
    for (const m of mappings ?? []) for (const group of drawing.strokeGroups ?? []) if (m.strokeGroupIds.includes(group.id)) for (const i of group.rawStrokeIndexes) if (!lineByStroke.has(i)) lineByStroke.set(i, m.lineIndex);
    const paths = (drawing.strokes ?? []).map((stroke, i) => {
      const lengths = stroke.points.map((p, j) => j ? Math.hypot(p.x - stroke.points[j - 1].x, p.y - stroke.points[j - 1].y) : 0);
      return { points: stroke.points, lengths, total: Math.max(1, lengths.reduce((a, b) => a + b, 0)), line: Math.max(0, Math.min(3, lineByStroke.get(i) ?? Math.floor(i * 4 / Math.max(1, drawing.strokes.length)))) };
    });
    const totals = [0,0,0,0], starts: number[] = [];
    for (const p of paths) { starts.push(totals[p.line]); totals[p.line] += p.total; }
    return { paths, starts, totals };
  }, [drawing, mappings]);
  const surfaces = useMemo(() => {
    const size = 640, width = drawing.lineWidth ?? 8;
    const { left, right, bottom, width: w, height: h } = drawingBounds(drawing);
    const scale = (size - 72) / Math.max(w, h);
    const x = size / 2 - (left + right) / 2 * scale, y = size - 36 - bottom * scale;
    const paths = geometry.paths.map(p => {
      const path = new Path2D();
      if (p.points.length) { path.moveTo(p.points[0].x, p.points[0].y); for (const point of p.points.slice(1)) path.lineTo(point.x, point.y); }
      return path;
    });
    const render = (complete: boolean) => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d')!; ctx.setTransform(scale, 0, 0, scale, x, y); ctx.lineCap = ctx.lineJoin = 'round';
      ctx.strokeStyle = ctx.fillStyle = complete ? '#26324d' : 'rgba(38,50,77,.23)'; ctx.lineWidth = complete ? width : width * .65;
      paths.forEach((path, i) => { const p = geometry.paths[i].points; if (p.length === 1) { ctx.beginPath(); ctx.arc(p[0].x, p[0].y, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); } else ctx.stroke(path); });
      return canvas;
    };
    return { ghost: render(false), finished: render(true), scale, x, y, size };
  }, [geometry, drawing.lineWidth]);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const { size, scale, x, y } = surfaces;
    if (canvas.width !== size) canvas.width = canvas.height = size;
    const draw = (seconds: number) => {
    if (loop) seconds = Math.max(0, seconds) % SONG_SECONDS;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, size, size);
    const finished = complete || seconds >= SONG_SECONDS;
    ctx.drawImage(finished ? surfaces.finished : surfaces.ghost, 0, 0);
    if (finished) return;
    ctx.setTransform(scale, 0, 0, scale, x, y);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const width = drawing.lineWidth ?? 8;
    const trace = (p: typeof geometry.paths[number], amount: number, color: string, lineWidth: number) => {
      if (!p.points.length || amount <= 0) return;
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = lineWidth;
      if (p.points.length === 1) { ctx.beginPath(); ctx.arc(p.points[0].x, p.points[0].y, lineWidth / 2, 0, Math.PI * 2); ctx.fill(); return; }
      ctx.beginPath(); ctx.moveTo(p.points[0].x, p.points[0].y); let remaining = amount;
      for (let i = 1; i < p.points.length; i++) {
        const before = p.points[i - 1], next = p.points[i], length = p.lengths[i];
        const fraction = length ? Math.min(1, remaining / length) : 1;
        ctx.lineTo(before.x + (next.x - before.x) * fraction, before.y + (next.y - before.y) * fraction); remaining -= length; if (remaining <= 0) break;
      }
      ctx.stroke();
    };
    const frame = seconds * FPS - LEAD_FRAMES;
    const currentLine = Math.floor(frame / LINE_FRAMES);
    geometry.paths.forEach((p, i) => {
      if (p.line < currentLine) { trace(p, p.total, '#334155', width); return; }
      if (p.line !== currentLine) return;
      const progress = Math.max(0, Math.min(1, (frame - p.line * LINE_FRAMES) / LINE_FRAMES));
      const distance = geometry.totals[p.line] * progress - geometry.starts[i];
      trace(p, Math.min(p.total, distance), '#f97316', width * 1.35);
    });
    };
    let frame = 0;
    const tick = () => { draw(clock ? clock() : seconds); if (clock && !complete) frame = requestAnimationFrame(tick); };
    tick(); return () => cancelAnimationFrame(frame);
  }, [drawing, geometry, surfaces, seconds, clock, complete, loop]);
  if (!drawing.strokes?.length) return <img src={drawing.imageUri} alt="作品のイラスト" className="ex-drawing" />;
  return <canvas ref={ref} className="ex-drawing" aria-label="歌に合わせて描かれるイラスト" />;
}
