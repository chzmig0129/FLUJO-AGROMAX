/**
 * Overlays.tsx — capa de overlays didácticos sobre el ensamblaje de una
 * clase (etapa 11), colocados por Gate 1 y remapeados por
 * overlays-timeline-stage.ts.
 *
 * ENTRADA: `overlays` en frames relativos al primer frame de CONTENIDO (sin
 * intro) — mismo contrato/convención que `Captions` (ver
 * src/lib/assembly/types.ts, `OverlayTimelineItem`, y la CONVENCIÓN DE
 * FRAMES [start, end) semiabierta). `offsetFrames` es la duración del intro
 * en el timeline de SALIDA: se suma al frame relativo de cada overlay para
 * ubicarlo en el frame real de Lesson.
 *
 * SIN ESTADO: los overlays activos se recalculan en cada frame a partir de
 * useCurrentFrame() con un filtro lineal — nada de useEffect ni useState,
 * mismo principio que Captions.tsx y el cursor del timeline de Lesson.tsx.
 *
 * ANCLAJE ESQUINA SUPERIOR IZQUIERDA + FADE (FLUJO-AGROMAX-r8q): el overlay
 * ya no se centra sobre un punto — se ancla por su esquina superior
 * izquierda a (OVERLAY_MARGIN_X*width, OVERLAY_MARGIN_Y*height), es decir,
 * queda por encima de la altura de la cabeza del presentador (que ocupa el
 * centro y los dos tercios inferiores del frame). El ancho de display es
 * OVERLAY_WIDTH_FRACTION del ancho del canvas (antes ocupaba más y tapaba la
 * cara al gesticular), salvo que ese ancho produzca un alto mayor a
 * OVERLAY_MAX_HEIGHT_FRACTION del canvas (FLUJO-AGROMAX-p8x) — en ese caso
 * (overlays verticales) el tamaño se recalcula desde el alto máximo,
 * conservando `overlay.aspect` = alto/ancho real del PNG. La opacidad
 * hace fade in/out de OVERLAY_FADE_FRAMES en los bordes de su rango de
 * vida, clampeado para no invertirse en overlays muy cortos.
 *
 * ORDEN EN Lesson.tsx: se monta ENTRE el video y `Captions` — los captions
 * siempre quedan encima, nunca tapados por un overlay.
 */
import React from "react";
import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { LessonCompositionProps } from "../src/lib/assembly/types";
import { OVERLAY_FADE_FRAMES } from "../src/lib/constants";

/* ------------------------------------------------------------------ *
 * Anclaje y tamaño del overlay (FLUJO-AGROMAX-r8q). Locales a este
 * componente: la esquina/margen/ancho son una decisión de layout de la capa
 * de Remotion, no compartida con el pipeline de Palmier
 * (src/lib/assembly/palmier/overlays.ts sigue su propia constante).
 * ------------------------------------------------------------------ */

/** Esquina de anclaje del overlay: superior izquierda, para no taparle la
 * cara al presentador (que ocupa el centro y los dos tercios inferiores). */
const OVERLAY_CORNER: "top-left" = "top-left";

/** Margen horizontal desde el borde izquierdo, como fracción del ancho del canvas (~4.5%). */
const OVERLAY_MARGIN_X = 0.045;

/** Margen vertical desde el borde superior, como fracción del alto del canvas (~4.5%). */
const OVERLAY_MARGIN_Y = 0.045;

/** Ancho de display del overlay, como fracción del ancho del canvas (~28%, antes 0.34-0.44). */
const OVERLAY_WIDTH_FRACTION = 0.28;

/** Alto máximo de display del overlay, como fracción del alto del canvas (FLUJO-AGROMAX-p8x):
 * los overlays con aspect vertical (formularios altos, 3+ renglones) se recalculan desde este
 * límite en vez de desde OVERLAY_WIDTH_FRACTION, para no extenderse hacia la zona del
 * instructor (centro y dos tercios inferiores del frame). Los overlays anchos/cuadrados nunca
 * lo alcanzan y quedan al 28% de ancho como antes. */
const OVERLAY_MAX_HEIGHT_FRACTION = 0.42;

/* ------------------------------------------------------------------ *
 * Placa blanca semiopaca detrás de cada overlay (legibilidad sobre
 * video, FLUJO-AGROMAX-4t7). El Gate 1 juzga el PNG aislado (fondo
 * transparente); el Gate 2 juzga el video real, donde el PNG solo (trazo
 * negro fino) queda ilegible sobre metrajes claros. La placa se dibuja
 * en Remotion, detrás del <Img>, dimensionada al box renderizado del
 * overlay (no al canvas) + padding, y comparte EXACTAMENTE la misma
 * opacidad de entrada/salida que el PNG (ver `opacity` más abajo): nunca
 * aparece/desaparece antes o después del overlay.
 *
 * Todos los valores están expresados en píxeles "a 1080p" (canvas de
 * referencia 1920x1080) y se escalan por PLATE_SCALE_BASE_WIDTH para
 * seguir viéndose bien si el canvas cambiara de resolución.
 * ------------------------------------------------------------------ */

/** Ancho de referencia (px) sobre el que están calibradas las constantes de la placa. */
const PLATE_SCALE_BASE_WIDTH = 1920;

/** Opacidad de la placa blanca (no del overlay): ~90% para no ocultar el metraje detrás. */
const PLATE_OPACITY = 0.9;

/** Radio de esquinas redondeadas de la placa, en px a 1080p. */
const PLATE_RADIUS_PX = 20;

/** Padding entre el borde del PNG renderizado y el borde de la placa, en px a 1080p. */
const PLATE_PADDING_PX = 28;

/** Difuminado de la sombra de la placa, en px a 1080p (sombra muy suave, sin borde duro). */
const PLATE_SHADOW_BLUR_PX = 22;

/** Desplazamiento vertical de la sombra de la placa, en px a 1080p. */
const PLATE_SHADOW_OFFSET_Y_PX = 6;

/** Opacidad de la sombra de la placa (independiente de PLATE_OPACITY). */
const PLATE_SHADOW_OPACITY = 0.16;

type OverlaysProps = {
  overlays: LessonCompositionProps["overlays"];
  /** Frame de salida en el que empieza el contenido (duración del intro). */
  offsetFrames: number;
};

/**
 * Opacidad de fade in/out para un rango [startFrame, endFrame) dado el frame
 * actual (ya relativo al contenido). El fade se clampea a la mitad de la
 * duración del overlay para que el punto de fade-out nunca quede antes que
 * el de fade-in (`interpolate` exige un inputRange estrictamente creciente).
 */
function overlayOpacity(
  contentFrame: number,
  startFrame: number,
  endFrame: number
): number {
  const duration = Math.max(1, endFrame - startFrame);
  const fade = Math.max(1, Math.min(OVERLAY_FADE_FRAMES, Math.floor(duration / 2)));
  const fadeInEnd = startFrame + fade;
  const fadeOutStart = Math.max(fadeInEnd + 1, endFrame - fade);

  if (fadeOutStart >= endFrame) {
    // Overlay demasiado corto para dos tramos de fade distintos: un único
    // triángulo de opacidad centrado en fadeInEnd.
    return interpolate(contentFrame, [startFrame, fadeInEnd, endFrame], [0, 1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }

  return interpolate(
    contentFrame,
    [startFrame, fadeInEnd, fadeOutStart, endFrame],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
}

export const Overlays: React.FC<OverlaysProps> = ({ overlays, offsetFrames }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  // Frame relativo al primer frame de CONTENIDO: la misma base que usan los
  // startFrame/endFrame de overlays (igual que Captions).
  const contentFrame = frame - offsetFrames;

  const active = overlays.filter(
    (overlay) => contentFrame >= overlay.startFrame && contentFrame < overlay.endFrame
  );

  if (active.length === 0) {
    return null;
  }

  // Escala de las constantes de la placa (calibradas a 1920px de ancho) al
  // ancho real del canvas de salida.
  const plateScale = width / PLATE_SCALE_BASE_WIDTH;
  const platePadding = PLATE_PADDING_PX * plateScale;
  const plateRadius = PLATE_RADIUS_PX * plateScale;
  const plateShadowBlur = PLATE_SHADOW_BLUR_PX * plateScale;
  const plateShadowOffsetY = PLATE_SHADOW_OFFSET_Y_PX * plateScale;

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {active.map((overlay) => {
        // `aspect` es alto/ancho real del PNG (ver assembly/types.ts). Punto
        // de partida: ancho fijo a OVERLAY_WIDTH_FRACTION del canvas, alto
        // derivado (displayWidth * aspect). Si ese alto supera
        // OVERLAY_MAX_HEIGHT_FRACTION*height (overlay vertical), se
        // recalcula al revés desde el alto máximo — el ancho se reduce en
        // consecuencia para conservar el aspect ratio del PNG. La placa se
        // dimensiona al box resultante (no al canvas), + padding.
        let displayWidth = OVERLAY_WIDTH_FRACTION * width;
        let displayHeight = displayWidth * overlay.aspect;
        const maxHeight = OVERLAY_MAX_HEIGHT_FRACTION * height;
        if (displayHeight > maxHeight) {
          displayHeight = maxHeight;
          displayWidth = displayHeight / overlay.aspect;
        }
        // Misma opacidad para la placa y el PNG: comparten enter/exit
        // exactamente, sin desfase.
        const opacity = overlayOpacity(contentFrame, overlay.startFrame, overlay.endFrame);
        // Anclaje por esquina superior izquierda (OVERLAY_CORNER): sin
        // `transform: translate(...)`, el borde superior izquierdo de la
        // placa/PNG queda exactamente en (left, top).
        const left = width * OVERLAY_MARGIN_X;
        const top = height * OVERLAY_MARGIN_Y;

        return (
          <React.Fragment key={`${overlay.key}-${overlay.startFrame}`}>
            <div
              style={{
                position: "absolute",
                left,
                top,
                width: displayWidth + platePadding * 2,
                height: displayHeight + platePadding * 2,
                borderRadius: plateRadius,
                backgroundColor: `rgba(255, 255, 255, ${PLATE_OPACITY})`,
                boxShadow: `0 ${plateShadowOffsetY}px ${plateShadowBlur}px rgba(0, 0, 0, ${PLATE_SHADOW_OPACITY})`,
                opacity,
              }}
            />
            <Img
              src={staticFile(overlay.file)}
              style={{
                position: "absolute",
                // La placa tiene padding alrededor del PNG: el PNG se
                // desplaza `platePadding` desde la esquina de la placa para
                // quedar centrado dentro de ella.
                left: left + platePadding,
                top: top + platePadding,
                width: displayWidth,
                height: displayHeight,
                opacity,
              }}
            />
          </React.Fragment>
        );
      })}
    </AbsoluteFill>
  );
};
