import React, { useEffect, useMemo, useRef, useState } from "react";
import { LyricsResponse, SingingScore } from "../types";
import { buildLineTimings, findActiveLineTiming, getLineStartTimeSeconds, getPlaybackTimelinePosition } from "../utils/playbackTiming";

interface KaraokeLyricsPanelProps {
    lyrics: LyricsResponse;
    audioRef?: React.RefObject<HTMLAudioElement | null>;
    singingScore?: SingingScore | null;
    className?: string;
    title?: string;
    showKanaLines?: boolean;
    compact?: boolean;
}

const splitTextSegments = (value: string) => {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter !== "undefined") {
        const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
        return Array.from(segmenter.segment(value), (segment) => segment.segment);
    }

    return Array.from(value);
};

type CompactLineFit = {
    fontSize?: number;
    wraps: boolean;
};

const MIN_COMPACT_LYRIC_FONT_SIZE = 14;
const FITTING_SAFETY_GAP = 2;

const KaraokeLyricsPanel: React.FC<KaraokeLyricsPanelProps> = ({
    lyrics,
    audioRef,
    singingScore,
    className,
    title,
    showKanaLines = false,
    compact = false,
}) => {
    const lineCount = lyrics.lines.length;
    const lineTimings = useMemo(() => buildLineTimings(singingScore, lineCount), [lineCount, singingScore]);
    const [renderTick, setRenderTick] = useState(0);
    const compactLyricsRef = useRef<HTMLDivElement>(null);
    const compactLineButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const compactLineProbeRefs = useRef<Array<HTMLSpanElement | null>>([]);
    const lyricLineKey = useMemo(() => lyrics.lines.join("\u0000"), [lyrics.lines]);
    const [compactLineFits, setCompactLineFits] = useState<{ key: string; values: CompactLineFit[] }>({
        key: "",
        values: [],
    });

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
        const currentFrame = getPlaybackTimelinePosition(audioRef?.current ?? null, singingScore, lineCount);
        const activeLineIndexValue = findActiveLineTiming(lineTimings, currentFrame)?.lineIndex ?? -1;
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

    const playFromLine = (lineIndex: number) => {
        const audio = audioRef?.current;
        const timing = lineTimings[lineIndex];
        if (!audio || !timing) return;

        const startTime = getLineStartTimeSeconds(timing, audio.duration, singingScore, lineCount);
        if (startTime === null) return;
        audio.currentTime = startTime;
        setRenderTick((current) => current + 1);
        void audio.play().catch((playError) => {
            // A synthetic click can be rejected by autoplay policy. Seeking is
            // still useful on its own, so preserve the child's selected line.
            audio.currentTime = startTime;
            setRenderTick((current) => current + 1);
            if (import.meta.env.DEV) console.error("Failed to play selected lyric line", playError);
        });
    };

    useEffect(() => {
        if (!compact || activeLineIndex < 0) return;

        const container = compactLyricsRef.current;
        const activeButton = container?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
        if (!container || !activeButton) return;

        const containerRect = container.getBoundingClientRect();
        const buttonRect = activeButton.getBoundingClientRect();
        if (buttonRect.top < containerRect.top) {
            container.scrollTop += buttonRect.top - containerRect.top;
        } else if (buttonRect.bottom > containerRect.bottom) {
            container.scrollTop += buttonRect.bottom - containerRect.bottom;
        }
    }, [activeLineIndex, compact]);

    useEffect(() => {
        if (!compact || typeof window === "undefined") return;

        let frameId: number | null = null;
        const measure = () => {
            frameId = null;
            const nextFits = lyrics.lines.map((_, index): CompactLineFit => {
                const button = compactLineButtonRefs.current[index];
                const probe = compactLineProbeRefs.current[index];
                if (!button || !probe) return { wraps: false };

                const buttonStyle = window.getComputedStyle(button);
                const baseFontSize = Number.parseFloat(window.getComputedStyle(probe).fontSize);
                const availableWidth = button.clientWidth
                    - Number.parseFloat(buttonStyle.paddingLeft)
                    - Number.parseFloat(buttonStyle.paddingRight)
                    - FITTING_SAFETY_GAP;
                const naturalWidth = probe.scrollWidth;

                if (!Number.isFinite(baseFontSize) || availableWidth <= 0 || naturalWidth <= 0) {
                    return { wraps: false };
                }

                const requestedFontSize = Math.min(baseFontSize, (baseFontSize * availableWidth) / naturalWidth);
                if (requestedFontSize >= baseFontSize - 0.1) return { wraps: false };

                if (requestedFontSize >= MIN_COMPACT_LYRIC_FONT_SIZE) {
                    // Round down so a sub-pixel rounding difference cannot bring the wrap back.
                    return { fontSize: Math.floor(requestedFontSize * 10) / 10, wraps: false };
                }

                return { fontSize: MIN_COMPACT_LYRIC_FONT_SIZE, wraps: true };
            });

            setCompactLineFits((current) => {
                const unchanged = current.key === lyricLineKey
                    && current.values.length === nextFits.length
                    && current.values.every((fit, index) => fit.fontSize === nextFits[index].fontSize && fit.wraps === nextFits[index].wraps);
                return unchanged ? current : { key: lyricLineKey, values: nextFits };
            });
        };

        const scheduleMeasurement = () => {
            if (frameId !== null) return;
            frameId = window.requestAnimationFrame(measure);
        };

        const resizeObserver = new ResizeObserver(scheduleMeasurement);
        if (compactLyricsRef.current) resizeObserver.observe(compactLyricsRef.current);
        compactLineButtonRefs.current.forEach((button) => {
            if (button) resizeObserver.observe(button);
        });
        window.addEventListener("resize", scheduleMeasurement);
        scheduleMeasurement();

        // A font swap can change Japanese glyph widths after the first layout.
        void document.fonts?.ready.then(scheduleMeasurement).catch(() => undefined);

        return () => {
            if (frameId !== null) window.cancelAnimationFrame(frameId);
            resizeObserver.disconnect();
            window.removeEventListener("resize", scheduleMeasurement);
        };
    }, [activeLineIndex, compact, lyricLineKey]);

    return (
        <div className={className}>
            {title && <p className="mb-3 text-sm font-black text-gray-600">{title}</p>}
            <p className="sr-only" aria-live="polite" aria-atomic="true">
                {activeLineIndex >= 0 ? `再生中：${lyrics.lines[activeLineIndex]}` : ""}
            </p>
            <div ref={compact ? compactLyricsRef : undefined} className={compact ? "compact-karaoke-lines" : undefined}>
                <div className="space-y-3 text-center">
                {lyrics.lines.map((line, index) => {
                    const isActive = index === activeLineIndex;
                    const isDone = activeLineIndex >= 0 && index < activeLineIndex;
                    const isMobileCurrent = isActive || (activeLineIndex < 0 && index === 0);
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
                    const fit = compactLineFits.key === lyricLineKey ? compactLineFits.values[index] : undefined;
                    const lyricTextStyle: React.CSSProperties | undefined = compact
                        ? {
                            fontSize: fit?.fontSize ? `${fit.fontSize}px` : undefined,
                            whiteSpace: fit?.wraps ? "normal" : "nowrap",
                            overflowWrap: fit?.wraps ? "anywhere" : "normal",
                        }
                        : undefined;
                    const lyricSegmentStyle: React.CSSProperties | undefined = fit?.fontSize
                        ? { fontSize: `${fit.fontSize}px` }
                        : undefined;

                    return (
                        <button
                            type="button"
                            key={`${line}-${index}`}
                            ref={(element) => {
                                compactLineButtonRefs.current[index] = element;
                            }}
                            onClick={() => playFromLine(index)}
                            aria-pressed={isActive}
                            aria-label={`${line}から聞く`}
                            data-mobile-current={isMobileCurrent}
                            className={`min-h-11 w-full rounded-2xl border-2 px-4 py-3 transition-all duration-300 focus-visible:outline focus-visible:outline-4 focus-visible:outline-orange-300 ${lineStyle}`}
                        >
                            {compact && (
                                <span
                                    ref={(element) => {
                                        compactLineProbeRefs.current[index] = element;
                                    }}
                                    aria-hidden="true"
                                    className={`pointer-events-none fixed -left-[9999px] top-0 block w-max whitespace-nowrap font-bold text-[1.0625rem] leading-snug sm:text-lg ${isActive ? "tracking-wide" : ""}`}
                                    style={{ visibility: "hidden" }}
                                >
                                    {lineSegments.map((segment, segmentIndex) => (
                                        <span key={`${segment}-${segmentIndex}`}>{segment}</span>
                                    ))}
                                </span>
                            )}
                            <span className={`block font-bold ${compact ? "text-[1.0625rem] leading-snug sm:text-lg" : "text-xl leading-relaxed md:text-2xl"} ${isActive ? "tracking-wide" : ""}`} style={lyricTextStyle}>
                                {lineSegments.map((segment, segmentIndex) => {
                                    const isHighlighted = segmentIndex < activeSegmentCount;
                                    const isTail = segmentIndex === activeSegmentCount && isActive && activeLineProgress > 0 && activeLineProgress < 1;

                                    return (
                                        <span
                                            key={`${segment}-${segmentIndex}`}
                                            className={isHighlighted || isTail ? "text-orange-500" : isDone ? "text-orange-500/70" : "text-gray-700"}
                                            style={isTail ? { ...lyricSegmentStyle, color: "rgb(249 115 22 / 0.95)" } : lyricSegmentStyle}
                                        >
                                            {segment}
                                        </span>
                                    );
                                })}
                            </span>
                        </button>
                    );
                })}
                </div>
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
