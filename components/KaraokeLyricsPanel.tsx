import React, { useEffect, useMemo, useState } from "react";
import { LyricsResponse, SingingScore } from "../types";

type KaraokeLineTiming = {
    lineIndex: number;
    startFrame: number;
    endFrame: number;
};

interface KaraokeLyricsPanelProps {
    lyrics: LyricsResponse;
    audioRef?: React.RefObject<HTMLAudioElement | null>;
    singingScore?: SingingScore | null;
    className?: string;
    title?: string;
    showKanaLines?: boolean;
}

const getLeadingRestFrames = (score: SingingScore) => {
    const firstNote = score.notes[0];
    return firstNote?.key === null && firstNote.lyric === "" ? firstNote.frame_length : 0;
};

const buildLineTimings = (score: SingingScore | null | undefined, lineCount: number) => {
    if (!score || lineCount <= 0) {
        return [];
    }

    const totalFrames = score.notes.reduce((sum, note) => sum + note.frame_length, 0);
    const leadingRestFrames = getLeadingRestFrames(score);
    const phraseFrameLength = (totalFrames - leadingRestFrames) / lineCount;

    if (totalFrames <= 0 || phraseFrameLength <= 0) {
        return [];
    }

    return Array.from({ length: lineCount }, (_, lineIndex) => ({
        lineIndex,
        startFrame: leadingRestFrames + phraseFrameLength * lineIndex,
        endFrame: leadingRestFrames + phraseFrameLength * (lineIndex + 1),
    }));
};

const getCurrentFrame = (audio: HTMLAudioElement | null, score: SingingScore | null | undefined, lineCount: number) => {
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) {
        return 0;
    }

    if (score) {
        const totalFrames = score.notes.reduce((sum, note) => sum + note.frame_length, 0);

        if (totalFrames > 0) {
            return (audio.currentTime / audio.duration) * totalFrames;
        }
    }

    return (audio.currentTime / audio.duration) * lineCount;
};

const findCurrentLineIndex = (lineTimings: KaraokeLineTiming[], currentFrame: number) => {
    if (lineTimings.length === 0) {
        return -1;
    }

    const activeTiming =
        lineTimings.find((timing) => currentFrame >= timing.startFrame && currentFrame < timing.endFrame) ??
        lineTimings.at(-1) ??
        null;

    return activeTiming?.lineIndex ?? -1;
};

const splitTextSegments = (value: string) => {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter !== "undefined") {
        const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
        return Array.from(segmenter.segment(value), (segment) => segment.segment);
    }

    return Array.from(value);
};

const KaraokeLyricsPanel: React.FC<KaraokeLyricsPanelProps> = ({
    lyrics,
    audioRef,
    singingScore,
    className,
    title,
    showKanaLines = false,
}) => {
    const lineCount = lyrics.lines.length;
    const lineTimings = useMemo(() => buildLineTimings(singingScore, lineCount), [lineCount, singingScore]);
    const [renderTick, setRenderTick] = useState(0);

    useEffect(() => {
        const audio = audioRef?.current;

        if (!audio) {
            return;
        }

        let rafId: number | null = null;

        const scheduleTick = () => {
            setRenderTick((current) => current + 1);
        };

        const startLoop = () => {
            const loop = () => {
                scheduleTick();
                rafId = window.requestAnimationFrame(loop);
            };

            if (rafId === null) {
                rafId = window.requestAnimationFrame(loop);
            }
        };

        const stopLoop = () => {
            if (rafId !== null) {
                window.cancelAnimationFrame(rafId);
                rafId = null;
            }
        };

        const handlePlay = () => {
            scheduleTick();
            startLoop();
        };

        const handlePause = () => {
            stopLoop();
            scheduleTick();
        };

        const handleTimeUpdate = () => scheduleTick();
        const handleEnded = () => {
            stopLoop();
            scheduleTick();
        };

        audio.addEventListener("play", handlePlay);
        audio.addEventListener("pause", handlePause);
        audio.addEventListener("ended", handleEnded);
        audio.addEventListener("timeupdate", handleTimeUpdate);
        audio.addEventListener("seeking", handleTimeUpdate);
        audio.addEventListener("loadedmetadata", handleTimeUpdate);

        if (!audio.paused) {
            startLoop();
        }

        scheduleTick();

        return () => {
            stopLoop();
            audio.removeEventListener("play", handlePlay);
            audio.removeEventListener("pause", handlePause);
            audio.removeEventListener("ended", handleEnded);
            audio.removeEventListener("timeupdate", handleTimeUpdate);
            audio.removeEventListener("seeking", handleTimeUpdate);
            audio.removeEventListener("loadedmetadata", handleTimeUpdate);
        };
    }, [audioRef]);

    const { activeLineIndex, activeLineProgress } = useMemo(() => {
        const currentFrame = getCurrentFrame(audioRef?.current ?? null, singingScore, lineCount);
        const activeLineIndexValue = findCurrentLineIndex(lineTimings, currentFrame);
        const activeTiming = lineTimings[activeLineIndexValue];

        if (!activeTiming) {
            return { activeLineIndex: -1, activeLineProgress: 0 };
        }

        const span = Math.max(1, activeTiming.endFrame - activeTiming.startFrame);
        const progress = (currentFrame - activeTiming.startFrame) / span;

        return {
            activeLineIndex: activeLineIndexValue,
            activeLineProgress: Math.max(0, Math.min(1, progress)),
        };
    }, [audioRef, lineCount, lineTimings, renderTick, singingScore]);

    return (
        <div className={className}>
            {title && <p className="mb-3 text-sm font-black text-gray-600">{title}</p>}
            <div className="space-y-3 text-center">
                {lyrics.lines.map((line, index) => {
                    const isActive = index === activeLineIndex;
                    const isDone = activeLineIndex >= 0 && index < activeLineIndex;
                    const lineStyle = isActive
                        ? "border-orange-300 bg-gradient-to-r from-orange-100 via-yellow-50 to-white shadow-md shadow-orange-100"
                        : isDone
                            ? "border-orange-100 bg-orange-50/60 text-orange-600"
                            : "border-gray-100 bg-white text-gray-700";
                    const lineSegments = splitTextSegments(line);
                    const activeSegmentCount = isActive
                        ? Math.max(0, Math.min(lineSegments.length, Math.floor(lineSegments.length * activeLineProgress)))
                        : isDone
                            ? lineSegments.length
                            : 0;

                    return (
                        <div
                            key={`${line}-${index}`}
                            className={`rounded-2xl border-2 px-4 py-3 transition-all duration-300 ${lineStyle}`}
                        >
                            <p className={`text-xl font-bold leading-relaxed md:text-2xl ${isActive ? "tracking-wide" : ""}`}>
                                {lineSegments.map((segment, segmentIndex) => {
                                    const isHighlighted = segmentIndex < activeSegmentCount;
                                    const isTail = segmentIndex === activeSegmentCount && isActive && activeLineProgress > 0 && activeLineProgress < 1;

                                    return (
                                        <span
                                            key={`${segment}-${segmentIndex}`}
                                            className={isHighlighted || isTail ? "text-orange-500" : isDone ? "text-orange-500/70" : "text-gray-700"}
                                            style={isTail ? { color: "rgb(249 115 22 / 0.95)" } : undefined}
                                        >
                                            {segment}
                                        </span>
                                    );
                                })}
                            </p>
                            {lyrics.lineStrokeMappings?.[index] && (
                                <p className={`mt-2 text-[11px] font-black ${isActive ? "text-orange-500" : "text-gray-400"}`}>
                                    strokes: {lyrics.lineStrokeMappings[index].strokeGroupIds.join(", ") || "none"}
                                </p>
                            )}
                        </div>
                    );
                })}
            </div>

            {showKanaLines && lyrics.singingKanaLines && lyrics.singingKanaLines.length > 0 && (
                <div className="mt-6 rounded-2xl border-2 border-yellow-100 bg-yellow-50 p-4">
                    <p className="mb-2 text-sm font-black text-gray-600">歌声合成用かな</p>
                    <div className="space-y-2">
                        {lyrics.singingKanaLines.map((line, index) => {
                            const isActive = index === activeLineIndex;
                            return (
                                <p
                                    key={`${line}-${index}`}
                                    className={`rounded-xl px-3 py-2 text-sm font-semibold transition-colors ${isActive ? "bg-white text-orange-600 shadow-sm" : "text-gray-500"}`}
                                >
                                    {line}
                                </p>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};

export default KaraokeLyricsPanel;