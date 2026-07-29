/**
 * assembly/ffmpeg/ass.ts — genera un archivo de subtítulos ASS a partir de
 * `plan.captions`, para que el backend "ffmpeg" los queme con el filtro
 * `subtitles` (libass) en vez de dibujarlos en React (remotion/Captions.tsx).
 *
 * REPLICA, no clona, el estilo visual de Captions.tsx:
 *  - Posición: cada línea se centra exactamente en
 *    (width/2, height*CAPTION_CENTER_Y) vía `\an5\pos(x,y)` — el mismo punto
 *    que Captions.tsx ubica con `top: height*CAPTION_CENTER_Y` +
 *    `translateY(-50%)` + `alignItems:center`.
 *  - Tipografía: Poppins Bold, CAPTION_FONT_SIZE (los valores de
 *    constants.ts están calibrados a PROXY_HEIGHT=1080, que es exactamente
 *    `PlayResY` de este script, así que el tamaño en px coincide 1:1).
 *  - Contorno/sombra: Outline=CAPTION_OUTLINE_PX, Shadow≈CAPTION_SHADOW.
 *
 * APROXIMACIÓN ACEPTADA (documentada a propósito): Captions.tsx resalta la
 * palabra activa con un BLOQUE DE FONDO detrs del texto (no cambia su
 * color), para no afectar el layout de las palabras vecinas. libass no
 * soporta dibujar una caja de fondo por palabra sin overrides `\p` (drawing
 * mode) por evento, que complicarían mucho el generador para un backend que
 * ya replica todo lo demás con fidelidad. En su lugar se usa el mecanismo
 * karaoke NATIVO de ASS (`\k`, por palabra): el texto pasa de blanco
 * (SecondaryColour, "por cantar") al verde de marca (PrimaryColour, "ya
 * cantado") en el instante exacto en que cada palabra se vuelve activa. El
 * timing (qué palabra está resaltada y cuándo) es idéntico al de
 * Captions.tsx; solo cambia CÓMO se pinta el resalte (color de texto en vez
 * de bloque detrás).
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import os from "node:os";
import {
  CAPTION_CENTER_Y,
  CAPTION_FONT_SIZE,
  CAPTION_HIGHLIGHT,
  CAPTION_OUTLINE_PX,
  CAPTION_SHADOW,
} from "../../constants";
import type { Caption, LessonAssemblyPlan } from "../types";

/** Ruta al .ttf Bold versionado en el repo (misma fuente que usa Intro.tsx). */
export const POPPINS_BOLD_TTF = path.join(
  process.cwd(),
  "remotion",
  "fonts",
  "Poppins-Bold.ttf"
);

/** Nombre de familia registrado dentro del .ttf (usado por `Fontname` del estilo ASS). */
const ASS_FONT_FAMILY = "Poppins";

/** Frames por centisegundo (unidad nativa de tiempo de ASS): 1cs = 10ms. */
function framesToCentiseconds(frames: number, fps: number): number {
  return Math.max(0, Math.round((frames / fps) * 100));
}

/** Formatea un frame absoluto (ya en el timeline de SALIDA) a "H:MM:SS.cc". */
function formatAssTimestamp(frames: number, fps: number): string {
  const totalCentiseconds = framesToCentiseconds(Math.max(0, frames), fps);
  const centiseconds = totalCentiseconds % 100;
  const totalSeconds = Math.floor(totalCentiseconds / 100);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const pad2 = (n: number) => n.toString().padStart(2, "0");
  return `${hours}:${pad2(minutes)}:${pad2(seconds)}.${pad2(centiseconds)}`;
}

/**
 * Escapa un texto de caption para vivir dentro de una línea `Dialogue:` de
 * ASS: las llaves `{}` abren/cierran override tags (nunca deben venir del
 * texto transcripto) y los saltos de línea se convierten a `\N` (el salto de
 * línea "duro" de ASS).
 */
function escapeAssText(text: string): string {
  return text
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r\n/g, "\\N")
    .replace(/\n/g, "\\N");
}

/** Color en el formato `&HAABBGGRR` que usa ASS, a partir de un hex `#RRGGBB` y alpha 0-255. */
function toAssColor(hex: string, alpha = 0): string {
  const clean = hex.replace("#", "");
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  const aa = alpha.toString(16).padStart(2, "0").toUpperCase();
  return `&H${aa}${b}${g}${r}`.toUpperCase();
}

/**
 * Construye la línea `Dialogue:` de un caption completo: un solo evento con
 * tags `\k<cs>` por palabra (más `\k` de relleno para huecos entre palabras,
 * si los hubiera) para que libass sweepee el karaoke exactamente como
 * Captions.tsx activa/desactiva cada palabra por frame.
 */
function buildDialogueLine(
  caption: Caption,
  offsetFrames: number,
  fps: number,
  width: number,
  height: number
): string {
  const startFrame = caption.startFrame + offsetFrames;
  const endFrame = caption.endFrame + offsetFrames;

  const posX = Math.round(width / 2);
  const posY = Math.round(height * CAPTION_CENTER_Y);

  let cursor = caption.startFrame;
  const parts: string[] = [`{\\an5\\pos(${posX},${posY})}`];

  for (const word of caption.words) {
    const gapFrames = word.startFrame - cursor;
    if (gapFrames > 0) {
      parts.push(`{\\k${framesToCentiseconds(gapFrames, fps)}}`);
    }
    const durationFrames = Math.max(1, word.endFrame - word.startFrame);
    parts.push(`{\\k${framesToCentiseconds(durationFrames, fps)}}${escapeAssText(word.text)} `);
    cursor = word.endFrame;
  }

  // Sin words (caption sin desglose palabra a palabra): se muestra la línea
  // completa sin resalte karaoke, mejor que no mostrar nada.
  if (caption.words.length === 0) {
    parts.push(escapeAssText(caption.text));
  }

  const text = parts.join("");
  return `Dialogue: 0,${formatAssTimestamp(startFrame, fps)},${formatAssTimestamp(endFrame, fps)},Default,,0,0,0,,${text}`;
}

/**
 * Genera el contenido completo de un archivo .ass para `plan.captions`.
 * `offsetFrames` es la duración del intro REALMENTE insertado (0 si no hay
 * intro en el timeline de salida) — mismo significado que en
 * Captions.tsx/Overlays.tsx.
 */
export function buildAssContent(plan: LessonAssemblyPlan, offsetFrames: number): string {
  const primary = toAssColor(CAPTION_HIGHLIGHT, 0); // "ya cantado": verde de marca
  const secondary = toAssColor("#FFFFFF", 0); // "por cantar": blanco (color base de Captions.tsx)
  const outline = toAssColor("#000000", 0);
  const shadowColor = toAssColor("#000000", Math.round((1 - CAPTION_SHADOW.opacity) * 255));

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${plan.width}`,
    `PlayResY: ${plan.height}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${ASS_FONT_FAMILY},${CAPTION_FONT_SIZE},${primary},${secondary},${outline},${shadowColor},-1,0,0,0,100,100,0,0,1,${CAPTION_OUTLINE_PX},${CAPTION_SHADOW.offsetY},5,20,20,20,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const dialogueLines = plan.captions
    .filter((caption) => caption.endFrame > caption.startFrame)
    .map((caption) => buildDialogueLine(caption, offsetFrames, plan.fps, plan.width, plan.height));

  return `${header}\n${dialogueLines.join("\n")}\n`;
}

/**
 * Escribe el .ass de una clase a un archivo temporal fuera de `publicRoot`
 * (no es un asset del job, es un artefacto de render efímero de este
 * backend) y devuelve su ruta absoluta. El llamador es responsable de
 * borrarlo cuando termine (éxito o error).
 */
export async function writeAssFile(
  plan: LessonAssemblyPlan,
  offsetFrames: number
): Promise<string> {
  const content = buildAssContent(plan, offsetFrames);
  const filePath = path.join(
    os.tmpdir(),
    `agromax-captions-${plan.jobId}-${plan.lessonId}-${process.pid}.ass`
  );
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}
