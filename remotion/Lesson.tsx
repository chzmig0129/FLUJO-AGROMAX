/**
 * Lesson.tsx — composición del ensamblaje de UNA clase (etapa 11).
 *
 * Concatena, en orden: el intro de la etapa 9 en el frame 0, y después
 * SOLO los tramos "keep" de plan/cuts/<lessonId>.json. Eso es todo el
 * ripple/quita-silencios: no se recorta nada acá, los tramos ya vienen
 * calculados y particionan la clase sin huecos ni traslapes.
 *
 * POR QUÉ ESTO NO PIERDE SINCRONÍA DE AUDIO:
 *
 *  - Los recortes son en FRAMES (trimBefore/trimAfter), no en segundos, y
 *    los proxies son CFR a 30 fps: el frame N es exactamente N/30 s. No hay
 *    redondeo por tramo y por lo tanto no hay deriva acumulada.
 *  - No hay concatenación de streams: Remotion le pide a cada frame de
 *    salida su fuente exacta, y el audio se muestrea del MISMO instante del
 *    MISMO archivo. Video y audio no pueden desfasarse entre sí porque
 *    salen del mismo pedido.
 *  - La duración de cada <Sequence> es exactamente endFrame - startFrame, y
 *    su `from` es la suma de las duraciones anteriores. La suma cierra por
 *    construcción con expectedFrames del plan.
 *
 * CLIPS SIN AUDIO: se marcan `muted`. Remotion emite UNA sola pista de audio
 * para toda la composición y ese tramo simplemente aporta silencio, así que
 * un clip mudo concatena limpio junto a los que sí tienen audio — sin
 * normalizar pistas ni inyectar silencio a mano.
 */
import React from "react";
import { AbsoluteFill, OffthreadVideo, Sequence, staticFile } from "remotion";
import type { LessonCompositionProps } from "../src/lib/assembly/types";
import { Captions } from "./Captions";

export const Lesson: React.FC<LessonCompositionProps> = ({
  introSrc,
  introDurationInFrames,
  entries,
  captions,
}) => {
  // Offset acumulado en el timeline de salida. Se calcula en el render (no
  // en un efecto) para que sea idéntico en cada frame.
  let cursor = introSrc ? introDurationInFrames : 0;

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {introSrc ? (
        <Sequence from={0} durationInFrames={introDurationInFrames} name="intro">
          {/* El intro se renderizó mudo: se marca muted para no pedirle una
              pista de audio que no tiene. */}
          <OffthreadVideo
            src={staticFile(introSrc)}
            muted
            style={{ width: "100%", height: "100%" }}
          />
        </Sequence>
      ) : null}

      {entries.map((entry, index) => {
        const durationInFrames = entry.endFrame - entry.startFrame;
        const from = cursor;
        cursor += durationInFrames;

        return (
          <Sequence
            key={`${entry.src}-${entry.startFrame}-${index}`}
            from={from}
            durationInFrames={durationInFrames}
            name={`keep ${index + 1}`}
          >
            <OffthreadVideo
              src={staticFile(entry.src)}
              // Recorte en frames del proxy: [startFrame, endFrame).
              trimBefore={entry.startFrame}
              trimAfter={entry.endFrame}
              muted={!entry.hasAudio}
              style={{ width: "100%", height: "100%" }}
            />
          </Sequence>
        );
      })}

      <Captions captions={captions} offsetFrames={introDurationInFrames} />
    </AbsoluteFill>
  );
};
