import React, { useEffect, useMemo, useRef, useState } from "react";
import { DrawingData, LyricsResponse } from "../types";
import { buildPrintStrokeSteps, getPrintSourceSize } from "../services/printLayoutService";
import StrokeStepPreview from "./StrokeStepPreview";

type PrintLayoutProps = {
  lyrics: LyricsResponse;
  drawingData: DrawingData;
  onBack: () => void;
  autoPrint?: boolean;
  showRomaji?: boolean;
};

const formatPrintDate = (date: Date) =>
  new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);

const getDensityClassName = (lineCount: number) => {
  if (lineCount >= 7) {
    return "density-tight";
  }

  if (lineCount >= 5) {
    return "density-medium";
  }

  return "density-standard";
};

const PrintLayout: React.FC<PrintLayoutProps> = ({ lyrics, drawingData, onBack, autoPrint = false, showRomaji = true }) => {
  const printedAt = useMemo(() => formatPrintDate(new Date()), []);
  const fallbackSourceSize = useMemo(() => getPrintSourceSize(drawingData), [drawingData]);
  const [sourceSize, setSourceSize] = useState(fallbackSourceSize);
  const [isArtworkReady, setIsArtworkReady] = useState(false);
  const hasStartedPrint = useRef(false);
  const strokeSteps = useMemo(() => buildPrintStrokeSteps(drawingData, lyrics), [drawingData, lyrics]);
  const densityClassName = getDensityClassName(lyrics.lines.length);

  useEffect(() => {
    if (!autoPrint || !isArtworkReady || hasStartedPrint.current) {
      return;
    }

    hasStartedPrint.current = true;
    const handleAfterPrint = () => onBack();
    window.addEventListener("afterprint", handleAfterPrint, { once: true });

    let timerId = 0;
    const frameId = window.requestAnimationFrame(() => {
      timerId = window.setTimeout(async () => {
        await document.fonts?.ready;
        window.print();
      }, 0);
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(timerId);
      window.removeEventListener("afterprint", handleAfterPrint);
    };
  }, [autoPrint, isArtworkReady, onBack]);

  return (
    <div className="print-layout-screen">
      <div className="print-actions no-print">
        <button type="button" onClick={onBack} className="print-action secondary">
          戻る
        </button>
        <button type="button" onClick={() => window.print()} className="print-action primary">
          印刷する
        </button>
      </div>

      <section className={`print-sheet ${densityClassName}`} aria-label="印刷プレビュー">
        <div className="print-sheet-inner">
          <header className="print-topbar">
            <div className="print-brand">
              <img className="print-logo" src="/logo.png" alt="超えかき歌！" />
              {showRomaji && <div className="print-romaji">Cho Ekaki Uta</div>}
            </div>

            <div className="print-title-block">
              <h1 className="print-title">{lyrics.title}</h1>
            </div>

            <div className="print-name-date">
              <div>
                なまえ
                <div className="print-write-line" />
              </div>
              <div>
                ひにち
                <div className="print-date">{printedAt}</div>
              </div>
            </div>
          </header>

          <main className="print-main">
            <section className="print-art-card">
              <div className="print-art-square">
                <img
                  src={drawingData.imageUri}
                  alt={`${lyrics.title}の絵`}
                  onLoad={(event) => {
                    const image = event.currentTarget;
                    const size = Math.max(image.naturalWidth, image.naturalHeight);

                    if (size > 0) {
                      setSourceSize({ width: size, height: size });
                    }

                    setIsArtworkReady(true);
                  }}
                  onError={() => setIsArtworkReady(true)}
                />
              </div>
            </section>

            <section className="print-lyrics-card">
              <div className="print-paired-lines">
                {strokeSteps.map((step) => (
                  <article className="print-paired-line" key={`${step.lineIndex}-${step.lyric}`}>
                    <div className="print-lyric-text">
                      <span className="print-line-number">{step.lineIndex + 1}</span>
                      <span>{step.lyric}</span>
                    </div>
                    <div className="print-step-art">
                      <StrokeStepPreview drawingData={drawingData} sourceSize={sourceSize} step={step} />
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </main>
        </div>
        <div className="print-credit">制作：仙台高専プログラミング部</div>
      </section>

      <style>{`
        @page {
          size: A4 landscape;
          margin: 0;
        }

        .print-layout-screen {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 18px;
          padding: 20px;
          background:
            radial-gradient(circle at top left, rgba(251, 146, 60, 0.18), transparent 30%),
            #e5e7eb;
          color: #1f2937;
        }

        .print-actions {
          position: sticky;
          top: 12px;
          z-index: 100;
          display: flex;
          gap: 12px;
          align-items: center;
          justify-content: center;
          padding: 10px;
          border: 1px solid rgba(255, 255, 255, 0.8);
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.92);
          box-shadow: 0 14px 34px rgba(31, 41, 55, 0.16);
          backdrop-filter: blur(12px);
        }

        .print-action {
          min-width: 112px;
          min-height: 42px;
          border: 0;
          border-radius: 999px;
          padding: 0 18px;
          font: inherit;
          font-size: 14px;
          font-weight: 900;
          cursor: pointer;
          transition: transform 140ms ease, background 140ms ease;
        }

        .print-action:active {
          transform: scale(0.97);
        }

        .print-action.primary {
          color: #fff;
          background: #fb923c;
          box-shadow: 0 8px 20px rgba(251, 146, 60, 0.28);
        }

        .print-action.secondary {
          color: #4b5563;
          background: #fff7ed;
        }

        .print-sheet {
          position: relative;
          width: 297mm;
          height: 210mm;
          overflow: hidden;
          background:
            radial-gradient(circle at 1.2mm 1.2mm, rgba(251, 146, 60, 0.16) 0 0.55mm, transparent 0.62mm) 0 0 / 8mm 8mm,
            linear-gradient(rgba(254, 215, 170, 0.13) 0.35mm, transparent 0.35mm) 0 0 / 16mm 16mm,
            linear-gradient(90deg, rgba(254, 215, 170, 0.13) 0.35mm, transparent 0.35mm) 0 0 / 16mm 16mm,
            #fff8ef;
          box-shadow: 0 20px 70px rgba(31, 41, 55, 0.25);
          print-color-adjust: exact;
          -webkit-print-color-adjust: exact;
        }

        .print-credit {
          position: absolute;
          right: 7mm;
          bottom: 4mm;
          z-index: 1;
          color: rgba(107, 114, 128, 0.72);
          font-size: 6.5pt;
          font-weight: 800;
          letter-spacing: 0;
          line-height: 1;
          white-space: nowrap;
        }

        .print-sheet-inner {
          position: absolute;
          inset: 8mm;
          display: grid;
          grid-template-rows: auto 1fr;
          gap: 4.5mm;
        }

        .print-topbar {
          display: grid;
          grid-template-columns: 64mm 1fr 48mm;
          align-items: center;
          gap: 6mm;
        }

        .print-brand {
          display: grid;
          justify-items: start;
          gap: 0.6mm;
        }

        .print-logo {
          display: block;
          width: 58mm;
          height: auto;
          object-fit: contain;
          filter: drop-shadow(0 2px 3px rgba(31, 41, 55, 0.16));
        }

        .print-romaji {
          width: 58mm;
          color: #374151;
          font-family: Georgia, "Times New Roman", serif;
          font-size: 11pt;
          font-weight: 700;
          letter-spacing: 0.22em;
          text-align: center;
        }

        .print-title-block {
          min-width: 0;
          text-align: center;
        }

        .print-title {
          margin: 0;
          color: #1f2937;
          font-size: 25pt;
          font-weight: 900;
          line-height: 1.08;
          letter-spacing: 0;
          overflow-wrap: anywhere;
        }

        .print-name-date {
          display: grid;
          gap: 2.8mm;
          color: #6b7280;
          font-size: 8.5pt;
          font-weight: 900;
        }

        .print-write-line {
          height: 6mm;
          border-bottom: 0.45mm solid rgba(107, 114, 128, 0.28);
        }

        .print-date {
          color: #374151;
          font-size: 10pt;
          font-weight: 900;
          text-align: right;
        }

        .print-main {
          display: grid;
          grid-template-columns: 154mm minmax(0, 1fr);
          gap: 6mm;
          min-height: 0;
          align-items: stretch;
        }

        .print-art-card,
        .print-lyrics-card {
          border: 1.8mm solid #ffedd5;
          border-radius: 8mm;
          background: rgba(255, 255, 255, 0.96);
          box-shadow: 0 4mm 11mm rgba(31, 41, 55, 0.10);
        }

        .print-art-card {
          display: grid;
          place-items: center;
          padding: 5mm;
        }

        .print-art-square {
          display: grid;
          place-items: center;
          width: 139mm;
          height: 139mm;
          overflow: hidden;
          border: 0.9mm dashed #d1d5db;
          border-radius: 7mm;
          background:
            linear-gradient(#fff, #fff) padding-box,
            repeating-linear-gradient(0deg, transparent 0 12mm, rgba(251, 146, 60, 0.08) 12mm 12.4mm);
        }

        .print-art-square img {
          width: 100%;
          height: 100%;
          object-fit: contain;
          opacity: 0.92;
        }

        .print-lyrics-card {
          display: grid;
          padding: 5mm;
          min-width: 0;
        }

        .print-paired-lines {
          display: grid;
          gap: 2.6mm;
          align-content: center;
        }

        .print-paired-line {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 34mm;
          align-items: center;
          gap: 3mm;
          border: 0.7mm solid #ffedd5;
          border-radius: 5mm;
          background: #fff;
          padding: 2.4mm;
          box-shadow: 0 1mm 3mm rgba(251, 146, 60, 0.10);
        }

        .print-lyric-text {
          display: grid;
          grid-template-columns: 8mm 1fr;
          align-items: center;
          gap: 3mm;
          color: #374151;
          font-size: 14.8pt;
          font-weight: 900;
          line-height: 1.28;
          overflow-wrap: anywhere;
        }

        .print-line-number {
          display: grid;
          place-items: center;
          width: 8mm;
          height: 8mm;
          border-radius: 999px;
          color: #fff;
          background: #fb923c;
          font-size: 9pt;
          line-height: 1;
        }

        .print-step-art {
          position: relative;
          display: grid;
          place-items: center;
          width: 30mm;
          height: 30mm;
          overflow: hidden;
          border: 0.6mm solid rgba(251, 146, 60, 0.28);
          border-radius: 4mm;
          background: #fff;
        }

        .print-step-svg {
          width: 100%;
          height: 100%;
        }

        .print-step-stroke {
          fill: none;
          stroke-linecap: round;
          stroke-linejoin: round;
        }

        .print-step-stroke.previous {
          stroke: #1f2937;
          stroke-width: 5;
          opacity: 0.72;
        }

        .print-step-stroke.current {
          stroke: #f97316;
          stroke-width: 6;
          opacity: 0.95;
        }

        .density-medium .print-paired-lines {
          gap: 1.5mm;
        }

        .density-medium .print-paired-line {
          grid-template-columns: minmax(0, 1fr) 27mm;
          padding: 1.7mm;
        }

        .density-medium .print-lyric-text {
          grid-template-columns: 7mm 1fr;
          gap: 2mm;
          font-size: 11.5pt;
          line-height: 1.2;
        }

        .density-medium .print-line-number {
          width: 7mm;
          height: 7mm;
          font-size: 8pt;
        }

        .density-medium .print-step-art {
          width: 23mm;
          height: 23mm;
        }

        .density-tight .print-paired-lines {
          grid-template-columns: 1fr 1fr;
          align-content: start;
          gap: 2mm;
        }

        .density-tight .print-paired-line {
          grid-template-columns: minmax(0, 1fr) 22mm;
          gap: 2mm;
          padding: 1.6mm;
        }

        .density-tight .print-lyric-text {
          grid-template-columns: 6mm 1fr;
          gap: 2mm;
          font-size: 9.5pt;
          line-height: 1.18;
        }

        .density-tight .print-line-number {
          width: 6mm;
          height: 6mm;
          font-size: 7.5pt;
        }

        .density-tight .print-step-art {
          width: 20mm;
          height: 20mm;
          border-radius: 3mm;
        }

        @media print {
          *,
          *::before,
          *::after {
            print-color-adjust: exact !important;
            -webkit-print-color-adjust: exact !important;
          }

          html,
          body,
          #root {
            width: 297mm;
            min-height: 210mm;
            margin: 0;
            background: #fff !important;
          }

          .no-print {
            display: none !important;
          }

          .print-layout-screen {
            display: block;
            min-height: 0;
            padding: 0;
            background: #fff;
          }

          .print-sheet {
            margin: 0;
            box-shadow: none;
          }
        }
      `}</style>
    </div>
  );
};

export default PrintLayout;
