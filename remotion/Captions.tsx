/**
 * Captions.tsx — capa de subtítulos karaoke sobre el ensamblaje de una
 * clase (etapa 11).
 *
 * ENTRADA: `captions` en frames relativos al primer frame de CONTENIDO (sin
 * intro) — ver el contrato en src/lib/assembly/types.ts (Caption/CaptionWord)
 * y la CONVENCIÓN DE FRAMES [start, end) semiabierta, igual que TimelineEntry.
 * `offsetFrames` es la duración del intro en el timeline de SALIDA: se suma
 * al frame relativo de cada caption/word para ubicarlo en el frame real de
 * Lesson.
 *
 * SIN ESTADO: el caption/word activo se recalcula en cada frame a partir de
 * useCurrentFrame() con una búsqueda lineal — nada de useEffect ni useState,
 * así que el resultado es 100% determinista y reproducible frame a frame
 * (mismo principio que Lesson.tsx documenta para el cursor del timeline).
 *
 * KARAOKE SIN ESCALAR: la palabra activa se resalta con un bloque de fondo
 * (CAPTION_HIGHLIGHT) detrás del texto, no con un scale/pop del texto — un
 * pop que escala el word cambia su ancho y por lo tanto el layout de las
 * palabras vecinas (colapsa/expande espacios), rompiendo la lectura. Un
 * bloque de fondo no toca el flujo del texto.
 */
import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { LessonCompositionProps } from "../src/lib/assembly/types";
import {
  CAPTION_CENTER_Y,
  CAPTION_FONT_SIZE,
  CAPTION_HIGHLIGHT,
  CAPTION_OUTLINE_PX,
  CAPTION_SHADOW,
} from "../src/lib/constants";
import { ensurePoppinsLoaded, FONT_FAMILY } from "./fonts/poppins";

type CaptionsProps = {
  captions: LessonCompositionProps["captions"];
  /** Frame de salida en el que empieza el contenido (duración del intro). */
  offsetFrames: number;
};

/**
 * Sombra de texto que dibuja un contorno parejo (varias copias desplazadas
 * alrededor del glyph) más la sombra suave de CAPTION_SHADOW. Se prefiere a
 * WebkitTextStroke solo porque el stroke de WebKit puede fusionar letras muy
 * juntas en tamaños grandes; con text-shadow cada copia respeta el mismo
 * kerning que el texto base.
 */
function buildTextShadow(): string {
  const outline = CAPTION_OUTLINE_PX;
  const steps = 16;
  const outlineShadows: string[] = [];
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const x = Math.round(Math.cos(angle) * outline * 100) / 100;
    const y = Math.round(Math.sin(angle) * outline * 100) / 100;
    outlineShadows.push(`${x}px ${y}px 0 #000000`);
  }
  const softShadow = `0px ${CAPTION_SHADOW.offsetY}px ${CAPTION_SHADOW.blur}px rgba(0,0,0,${CAPTION_SHADOW.opacity})`;
  return [...outlineShadows, softShadow].join(", ");
}

export const Captions: React.FC<CaptionsProps> = ({
  captions,
  offsetFrames,
}) => {
  const frame = useCurrentFrame();
  const { height } = useVideoConfig();

  // Frame relativo al primer frame de CONTENIDO: la misma base que usan los
  // startFrame/endFrame de captions y words.
  const contentFrame = frame - offsetFrames;

  const activeCaption = captions.find(
    (caption) =>
      contentFrame >= caption.startFrame && contentFrame < caption.endFrame
  );

  // Sin captions (o sin ninguno activo) no hay nada que dibujar: no se debe
  // cargar la fuente (ver "POR QUÉ LA CARGA ES PEREZOSA" en fonts/poppins.ts)
  // para no reintroducir contención en renders sin subtítulos.
  if (captions.length === 0 || !activeCaption) {
    return null;
  }

  ensurePoppinsLoaded();

  const textShadow = buildTextShadow();

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-start",
        alignItems: "center",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: height * CAPTION_CENTER_Y,
          transform: "translateY(-50%)",
          maxWidth: "88%",
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          alignItems: "baseline",
          rowGap: 6,
          fontFamily: FONT_FAMILY,
          fontWeight: 700,
          fontSize: CAPTION_FONT_SIZE,
          color: "#FFFFFF",
          textShadow,
        }}
      >
        {activeCaption.words.map((word, index) => {
          const isActive =
            contentFrame >= word.startFrame && contentFrame < word.endFrame;

          return (
            <span
              key={`${word.text}-${word.startFrame}-${index}`}
              style={{
                position: "relative",
                display: "inline-block",
                padding: "2px 10px",
                marginRight: 12,
              }}
            >
              {isActive ? (
                <span
                  style={{
                    position: "absolute",
                    inset: 0,
                    borderRadius: 10,
                    backgroundColor: CAPTION_HIGHLIGHT,
                    zIndex: 0,
                  }}
                />
              ) : null}
              <span style={{ position: "relative", zIndex: 1 }}>
                {word.text}
              </span>
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
