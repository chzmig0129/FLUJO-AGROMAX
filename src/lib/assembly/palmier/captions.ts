/**
 * assembly/palmier/captions.ts — captions nativas de Palmier con el estilo de
 * marca, más el reemplazo por captions auditadas (plan.captions, ya
 * corregidas por otro worker) donde el texto transcrito por Palmier difiera.
 *
 * SCHEMA REAL (verificado con `tools/list` contra la app viva, no supuesto):
 *  - `add_captions`: transcribe el audio del timeline y crea un track de
 *    captions con un `captionGroupId` compartido. Devuelve
 *    `{captionGroupId, clipCount, frameRange, style, textPreview}` (el
 *    "caption group summary"). Acepta `animation` (uno de los presets, acá
 *    "highlightBlock"), `highlightColor` (hex, palabra activa), `maxWords`
 *    (tope de palabras por caption) y `style` — el mismo "partial style
 *    patch" que `update_text` (fontName, fontSize, bold, color, outline
 *    {enabled,color,width}, shadow {enabled,blur,color,offset{x,y},opacity},
 *    tracking, alignment, background…). También `transform.centerX/centerY`
 *    (0–1) para la posición del bloque; el tamaño se auto-ajusta.
 *  - `get_timeline`: sin `captionDetail`, los captions de un track vienen
 *    resumidos como `captionGroups` (no expone clips individuales). Con
 *    `captionDetail:true` (ventaneado con `startFrame`/`endFrame`, ambos en
 *    frames de PROYECTO) se expanden a filas por-clip, documentadas en la
 *    descripción de la tool como `[clipId, startFrame, endFrame, text]`,
 *    capadas a 200 por grupo. El shape exacto (tupla posicional vs. objeto
 *    con esas keys) no se pudo confirmar en vivo porque la app no tenía un
 *    proyecto abierto durante el desarrollo de este archivo ("Editor not
 *    available"); `extractCaptionRows`/`parseCaptionRow` de abajo aceptan
 *    ambas formas a propósito, defensivamente.
 *  - `update_text`: aplica un patch a clips de texto puntuales (`clipIds`)
 *    o a un `captionGroupId` completo. Acá SIEMPRE se apunta con `clipIds`
 *    a un único caption clip (nunca al grupo completo) para no pisar el
 *    texto de las demás captions del grupo, y SOLO se manda `content`
 *    (nunca frames/timing — ver regla dura más abajo).
 *
 * TRADE-OFF ACEPTADO DEL DISEÑO: `update_text` puede aplanar el resaltado
 * karaoke palabra-por-palabra del caption tocado (el clip pasa a animarse
 * como un bloque de texto en vez de resaltar cada palabra en su frame). Se
 * acepta ese costo a cambio de que el texto en pantalla sea el auditado y
 * no el crudo transcripto por Palmier. Por eso el reemplazo es *solo texto*
 * y nunca toca `startFrame`/`endFrame`.
 *
 * REGLA DURA: las captions viven en el track 0. Este archivo nunca llama
 * `add_clips`/`add_texts` (no toca clips de video/imagen ni overlays), así
 * que no hay riesgo de pisar ese track — solo usa `add_captions` (que crea
 * su propio track de captions) y `update_text` (que no toma `trackIndex`).
 */
import {
  BRAND_GREEN,
  CAPTION_CENTER_Y,
  CAPTION_FONT_SIZE,
  CAPTION_HIGHLIGHT,
  CAPTION_OUTLINE_PX,
  CAPTION_SHADOW,
} from "../../constants";
import type { Caption, LessonAssemblyPlan } from "../types";
import type { PalmierClient } from "./mcp-client";

/** Máximo de palabras por caption (regla del diseño). */
const CAPTION_MAX_WORDS = 3;

/** Tamaño de ventana de frames por llamada a get_timeline (regla del diseño). */
const TIMELINE_WINDOW_FRAMES = 1500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extrae el `captionGroupId` de la respuesta de `add_captions`. */
function extractCaptionGroupId(result: unknown): string {
  if (isRecord(result) && typeof result.captionGroupId === "string") {
    return result.captionGroupId;
  }
  throw new Error(
    `Palmier add_captions: la respuesta no trae "captionGroupId". Recibido: ${JSON.stringify(result).slice(0, 300)}`
  );
}

/**
 * Extrae, si viene, el frame final del grupo de captions recién creado
 * (`frameRange.end`) para acotar el barrido de ventanas. Devuelve `null` si
 * el server no lo reportó — en ese caso se usa el rango del plan.
 */
function extractGroupFrameRangeEnd(result: unknown): number | null {
  if (isRecord(result) && isRecord(result.frameRange)) {
    const end = result.frameRange.end;
    if (typeof end === "number") return end;
  }
  return null;
}

/** Una fila de caption individual leída de `get_timeline({captionDetail:true})`. */
interface CaptionClipRow {
  clipId: string;
  startFrame: number;
  endFrame: number;
  text: string;
}

/**
 * Parsea un clip crudo devuelto por `get_timeline` a una `CaptionClipRow`.
 * Acepta tanto la forma tupla `[clipId, startFrame, endFrame, text]`
 * (la documentada literalmente en la descripción de la tool) como una forma
 * objeto con esas mismas keys u alias razonables (`id`/`start`/`end`/
 * `content`), por si el server real difiere del texto de la doc. Si el
 * clip trae `captionGroupId` y no coincide con el grupo que estamos
 * auditando, se descarta (evita tocar captions de otro grupo preexistente
 * en el proyecto).
 */
function parseCaptionRow(clip: unknown, captionGroupId: string): CaptionClipRow | null {
  if (Array.isArray(clip)) {
    const [clipId, startFrame, endFrame, text] = clip;
    if (
      typeof clipId === "string" &&
      typeof startFrame === "number" &&
      typeof endFrame === "number" &&
      typeof text === "string"
    ) {
      return { clipId, startFrame, endFrame, text };
    }
    return null;
  }
  if (isRecord(clip)) {
    const rowGroupId = typeof clip.captionGroupId === "string" ? clip.captionGroupId : undefined;
    if (rowGroupId !== undefined && rowGroupId !== captionGroupId) return null;
    const clipId =
      typeof clip.clipId === "string"
        ? clip.clipId
        : typeof clip.id === "string"
          ? clip.id
          : undefined;
    const startFrame =
      typeof clip.startFrame === "number"
        ? clip.startFrame
        : typeof clip.start === "number"
          ? clip.start
          : undefined;
    const endFrame =
      typeof clip.endFrame === "number"
        ? clip.endFrame
        : typeof clip.end === "number"
          ? clip.end
          : undefined;
    const text =
      typeof clip.text === "string"
        ? clip.text
        : typeof clip.content === "string"
          ? clip.content
          : undefined;
    if (clipId && typeof startFrame === "number" && typeof endFrame === "number" && typeof text === "string") {
      return { clipId, startFrame, endFrame, text };
    }
  }
  return null;
}

/** Recorre `tracks[].clips` de una respuesta de get_timeline y junta las filas de caption del grupo dado. */
function extractCaptionRows(timelineResult: unknown, captionGroupId: string): CaptionClipRow[] {
  const rows: CaptionClipRow[] = [];
  if (!isRecord(timelineResult)) return rows;
  const tracks = timelineResult.tracks;
  if (!Array.isArray(tracks)) return rows;
  for (const track of tracks) {
    if (!isRecord(track)) continue;
    const clips = track.clips;
    if (!Array.isArray(clips)) continue;
    for (const clip of clips) {
      const row = parseCaptionRow(clip, captionGroupId);
      if (row) rows.push(row);
    }
  }
  return rows;
}

/**
 * Encuentra, entre las captions auditadas del plan, la que más solapa en
 * frames ABSOLUTOS (ya con el offset de intro sumado) con una fila leída de
 * Palmier. Devuelve `null` si ninguna se solapa.
 */
function bestOverlapMatch(
  row: CaptionClipRow,
  planCaptions: Caption[],
  introOffsetFrames: number
): Caption | null {
  let best: Caption | null = null;
  let bestOverlap = 0;
  for (const caption of planCaptions) {
    const absStart = caption.startFrame + introOffsetFrames;
    const absEnd = caption.endFrame + introOffsetFrames;
    const overlap = Math.min(row.endFrame, absEnd) - Math.max(row.startFrame, absStart);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = caption;
    }
  }
  return best;
}

/**
 * Aplica las captions nativas de Palmier (estilo de marca) a la clase y
 * corrige el texto de las que Palmier transcribió distinto a la versión
 * auditada de `plan.captions`.
 *
 * 1. Sin captions en el plan: no-op, ninguna llamada al MCP.
 * 2. `add_captions` con el estilo de marca (Poppins Bold 54, blanco, outline
 *    negro 4px, sombra suave, centrado a `CAPTION_CENTER_Y`, máx. 3
 *    palabras, animación `highlightBlock` con resalte verde de marca).
 * 3. Barrido ventaneado (secuencial, ~1500 frames por llamada) de
 *    `get_timeline({captionDetail:true})` sobre el rango que ocupan las
 *    captions, matcheo por solapamiento de frames contra `plan.captions`
 *    (offset de intro = `introFrames`, el offset REAL pasado por backend.ts:
 *    0 si el intro no se llegó a insertar, ver FLUJO-AGROMAX-2tl), y
 *    `update_text` (solo `content`, nunca timing) donde el texto difiera.
 */
export async function applyCaptions(
  client: PalmierClient,
  plan: LessonAssemblyPlan,
  jobId: string,
  introFrames: number
): Promise<void> {
  if (plan.captions.length === 0) return;

  // Offset REAL de intro, pasado por backend.ts: 0 si el intro estaba
  // planeado pero no se insertó de verdad (archivo ausente en disco u otra
  // falla), nunca derivado de `plan.intro` a ciegas (ver FLUJO-AGROMAX-2tl).
  const introOffsetFrames = introFrames;

  const addResult = await client.call("add_captions", {
    animation: "highlightBlock",
    highlightColor: CAPTION_HIGHLIGHT,
    maxWords: CAPTION_MAX_WORDS,
    style: {
      fontName: "Poppins",
      bold: true,
      fontSize: CAPTION_FONT_SIZE,
      color: "#FFFFFF",
      outline: {
        enabled: true,
        color: "#000000",
        width: CAPTION_OUTLINE_PX,
      },
      shadow: {
        enabled: true,
        blur: CAPTION_SHADOW.blur,
        opacity: CAPTION_SHADOW.opacity,
        offset: { x: 0, y: CAPTION_SHADOW.offsetY },
        color: "#000000",
      },
    },
    transform: { centerX: 0.5, centerY: CAPTION_CENTER_Y },
  });

  const captionGroupId = extractCaptionGroupId(addResult);

  // Cota superior del barrido: el mayor entre lo que reporta el plan y lo
  // que reportó Palmier para el grupo recién creado (por si Palmier generó
  // más/menos captions que las auditadas).
  const lastPlanEndFrame = plan.captions.reduce((max, c) => Math.max(max, c.endFrame), 0);
  const planWindowEnd = introOffsetFrames + lastPlanEndFrame;
  const groupWindowEnd = extractGroupFrameRangeEnd(addResult);
  const windowEnd = Math.max(planWindowEnd, groupWindowEnd ?? 0);

  let replaced = 0;
  for (let start = 0; start < windowEnd; start += TIMELINE_WINDOW_FRAMES) {
    const end = Math.min(start + TIMELINE_WINDOW_FRAMES, windowEnd);
    // Secuencial a propósito (regla dura del diseño: nada de llamadas
    // concurrentes contra el MCP de Palmier); el cliente ya serializa, pero
    // acá además esperamos cada ventana antes de pedir la siguiente.
    const timelineResult = await client.call("get_timeline", {
      captionDetail: true,
      startFrame: start,
      endFrame: end,
    });
    const rows = extractCaptionRows(timelineResult, captionGroupId);
    for (const row of rows) {
      const match = bestOverlapMatch(row, plan.captions, introOffsetFrames);
      if (!match) continue;
      if (match.text !== row.text) {
        // Solo `content`: jamás tocar startFrame/endFrame de este clip.
        await client.call("update_text", {
          clipIds: [row.clipId],
          content: match.text,
        });
        replaced++;
      }
    }
  }

  console.log(
    `[palmier/captions] job ${jobId} · ${plan.lessonId}: ${replaced} caption(s) reemplazadas por texto auditado (highlight ${BRAND_GREEN}).`
  );
}
