import React from "react";
import { DrawingData } from "../types";
import { buildStrokePath, PrintSourceSize, PrintStrokeStep } from "../services/printLayoutService";

type StrokeStepPreviewProps = {
  drawingData: DrawingData;
  sourceSize: PrintSourceSize;
  step: PrintStrokeStep;
};

const renderStrokePaths = (drawingData: DrawingData, strokeIndexes: number[], className: string) =>
  strokeIndexes.map((strokeIndex) => {
    const stroke = drawingData.strokes[strokeIndex];

    if (!stroke) {
      return null;
    }

    const path = buildStrokePath(stroke);

    if (!path) {
      return null;
    }

    return <path key={`${className}-${strokeIndex}`} className={className} d={path} />;
  });

const StrokeStepPreview: React.FC<StrokeStepPreviewProps> = ({ drawingData, sourceSize, step }) => (
  <svg
    className="print-step-svg"
    viewBox={`0 0 ${sourceSize.width} ${sourceSize.height}`}
    preserveAspectRatio="xMidYMid meet"
    aria-hidden="true"
  >
    <rect width={sourceSize.width} height={sourceSize.height} fill="#fff" />
    {renderStrokePaths(drawingData, step.previousStrokeIndexes, "print-step-stroke previous")}
    {renderStrokePaths(drawingData, step.currentStrokeIndexes, "print-step-stroke current")}
  </svg>
);

export default StrokeStepPreview;
