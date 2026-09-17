import React, { memo, useMemo } from "react";
import type { DemoRecordSummary } from "../types";
import { cardPosition, cardTraits, type GalleryLayout } from "./model";

type Props = {
  record: DemoRecordSummary; index: number; layout: GalleryLayout;
  selected: boolean; introducing: boolean; waiting: boolean; idle: boolean;
  onSelect: (id: string) => void; onOpen: (id: string) => void;
};

export default memo(function GalleryCard({ record, index, layout, selected, introducing, waiting, idle, onSelect, onOpen }: Props) {
  const traits = useMemo(() => cardTraits(record.recordId), [record.recordId]);
  const position = cardPosition(index, record.recordId, layout);
  const style = {
    ...position, width: layout.cardWidth, height: layout.cardHeight,
    "--card-rotation": `${traits.rotation}deg`, "--float-duration": `${traits.duration}s`,
    "--float-delay": `${traits.delay}s`, "--float-distance": `${traits.amplitude * layout.scale}px`,
    "--shadow-scale": traits.shadow, "--intro-distance": `${Math.max(80, layout.height - position.top)}px`,
    "--title-size": `${Math.max(17, layout.cardWidth * .076)}px`,
  } as React.CSSProperties;
  return <div className={`gallery-slot${selected ? " is-selected" : ""}${introducing ? " is-introducing" : ""}${waiting ? " is-waiting" : ""}`} style={style} data-record-id={record.recordId} data-index={index}>
    <div className="gallery-arrival">
      <div className="gallery-float">
        <button className="gallery-card" type="button" disabled={waiting} aria-label={`${record.title}を再生`} aria-current={selected ? "true" : undefined}
          onClick={() => onOpen(record.recordId)} onFocus={() => onSelect(record.recordId)}
          onPointerMove={event => { if (!idle && (event.movementX || event.movementY)) onSelect(record.recordId); }}>
          <span className="gallery-art"><img src={record.imageUrl} alt="" loading={index < layout.columns * 2 ? "eager" : "lazy"} decoding="async" draggable={false}/></span>
          <span className="gallery-title"><span>{record.title}</span></span>
        </button>
        {introducing && <div className="gallery-welcome" aria-hidden="true"><i/><i/><i/><i/><i/><i/></div>}
      </div>
      <span className="gallery-ground-shadow" aria-hidden="true"/>
    </div>
  </div>;
});
