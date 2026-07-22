/**
 * assembly/palmier/overlays.ts — aplica los overlays didácticos y el logo de
 * marca sobre el timeline ya armado en Palmier (backend "palmier", etapa 11
 * de ensamblaje headless).
 *
 * REGLA DURA DE DISEÑO (`add_clips`): jamás `trackIndex 0`, y para
 * "reemplazar" contenido de una capa nunca se borra primero — se agrega
 * ENCIMA, en un track nuevo. Por eso cada llamada a `add_clips` de este
 * archivo omite `trackIndex` en TODAS sus entries: la app auto-crea un track
 * compartido nuevo para ese lote (el tool rechaza mezclar entries con/sin
 * `trackIndex` en la misma llamada, así que overlays y logo van en llamadas
 * separadas — cada una termina en su propio track nuevo).
 *
 * Schemas reales consultados vía `tools/list` (solo lectura) contra la app
 * viva: `import_media` (source.path, devuelve {mediaRef,status} y corre en
 * background — hay que pollear `get_media` con `ids` hasta que
 * `generationStatus` desaparezca), `add_clips` (entries[]: mediaRef,
 * startFrame, endFrame — trackIndex opcional/omitido acá a propósito),
 * `set_clip_properties` (clipIds[], transform: centerX/centerY/width/height,
 * opacity), `set_keyframes` (clipId, property, keyframes: filas
 * `[frame, ...values]` CLIP-RELATIVAS, 0 = primer frame del clip).
 */
import path from "node:path";
import type { PalmierClient } from "./mcp-client";
import type { LessonAssemblyPlan, OverlayTimelineItem } from "../types";
import {
  OVERLAY_ANCHOR_X,
  OVERLAY_ANCHOR_Y,
  OVERLAY_WIDTH,
  OVERLAY_WIDTH_WIDE,
  OVERLAY_FADE_FRAMES,
} from "../../constants";

/* ------------------------------------------------------------------ *
 * Constantes del logo de marca (top-right). Son del diseño y solo se usan
 * acá: no hay equivalente de logo en la capa de overlays de Remotion, así
 * que no viven en constants.ts junto a las de OVERLAY_*.
 * ------------------------------------------------------------------ */
/** Centro horizontal del logo, como fracción del ancho del frame. */
const LOGO_CENTER_X = 0.93;
/** Centro vertical del logo, como fracción del alto del frame. */
const LOGO_CENTER_Y = 0.1;
/** Ancho del logo, como fracción del ancho del frame. */
const LOGO_WIDTH = 0.085;
/** Alto del logo, como fracción del alto del frame. */
const LOGO_HEIGHT = 0.154;
/** Opacidad fija del logo durante toda la clase. */
const LOGO_OPACITY = 0.85;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ImportMediaResult {
  mediaRef?: string;
  status?: string;
}

interface MediaAsset {
  id?: string;
  generationStatus?: "preparing" | "generating" | "downloading" | "failed";
}

/**
 * Importa un archivo local a la librería de Palmier y espera (polling de
 * `get_media`) a que quede listo, es decir, sin `generationStatus` pendiente.
 */
async function importAndWait(
  client: PalmierClient,
  absPath: string,
  name: string,
  timeoutMs = 30_000
): Promise<string> {
  const imported = (await client.call("import_media", {
    source: { path: absPath },
    name,
  })) as ImportMediaResult;
  const mediaRef = imported?.mediaRef;
  if (!mediaRef) {
    throw new Error(
      `Palmier import_media no devolvió mediaRef para "${absPath}": ${JSON.stringify(imported)}`
    );
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = (await client.call("get_media", { ids: [mediaRef] })) as
      | { assets?: MediaAsset[] }
      | MediaAsset[]
      | null;
    const assets = Array.isArray(res) ? res : res?.assets ?? [];
    const asset = assets.find((a) => a?.id === mediaRef);
    if (asset && !asset.generationStatus) return mediaRef;
    if (asset?.generationStatus === "failed") {
      throw new Error(
        `Palmier import_media falló al importar "${absPath}" (mediaRef ${mediaRef}).`
      );
    }
    await sleep(400);
  }
  throw new Error(
    `Palmier import_media: timeout esperando a que "${absPath}" (mediaRef ${mediaRef}) quede listo.`
  );
}

/**
 * Extrae los clip ids devueltos por `add_clips`, tolerando las formas
 * razonables de respuesta (array de ids, array de objetos con `id`/`clipId`,
 * o el array envuelto en `clipIds`/`clips`/`ids`) ya que el schema de
 * `tools/list` solo documenta el input de la tool.
 */
function extractClipIds(result: unknown, expectedCount: number): string[] {
  const asIdArray = (val: unknown): string[] | null => {
    if (!Array.isArray(val)) return null;
    const ids = val.map((v) => {
      if (typeof v === "string") return v;
      const obj = v as { id?: unknown; clipId?: unknown } | null;
      return typeof obj?.id === "string" ? obj.id : typeof obj?.clipId === "string" ? obj.clipId : undefined;
    });
    return ids.every((id): id is string => typeof id === "string") ? ids : null;
  };

  const direct = asIdArray(result);
  if (direct) return direct;

  const obj = result as { clipIds?: unknown; clips?: unknown; ids?: unknown } | null;
  const fromClipIds = asIdArray(obj?.clipIds);
  if (fromClipIds) return fromClipIds;
  const fromClips = asIdArray(obj?.clips);
  if (fromClips) return fromClips;
  const fromIds = asIdArray(obj?.ids);
  if (fromIds) return fromIds;

  throw new Error(
    `Palmier add_clips: no se pudieron extraer ${expectedCount} clip id(s) de la respuesta: ${JSON.stringify(result)}`
  );
}

/**
 * Transform normalizado (0-1 del canvas) de un overlay, según la fórmula del
 * diseño: ancla a la izquierda, width fijo según si el overlay es "ancho"
 * (aspect < 0.6, ej. 16:9) o "cuadrado", y height derivado para preservar el
 * aspecto real del PNG sobre un canvas 1920x1080.
 */
function overlayTransform(item: OverlayTimelineItem, planWidth: number, planHeight: number) {
  const width = item.aspect < 0.6 ? OVERLAY_WIDTH_WIDE : OVERLAY_WIDTH;
  const height = (item.aspect * width * planWidth) / planHeight;
  return { centerX: OVERLAY_ANCHOR_X, centerY: OVERLAY_ANCHOR_Y, width, height };
}

/**
 * Keyframes de opacidad clip-relativos: fade in/out de `OVERLAY_FADE_FRAMES`
 * en los extremos del rango del overlay. Si el clip es más corto que
 * `2 * OVERLAY_FADE_FRAMES`, el fade se acorta a la mitad de la duración para
 * no superponer el fade-in con el fade-out.
 */
function fadeOpacityKeyframes(durationFrames: number): Array<[number, number]> {
  const lastFrame = Math.max(0, durationFrames - 1);
  const fade = Math.min(OVERLAY_FADE_FRAMES, Math.max(1, Math.floor(durationFrames / 2)));
  if (durationFrames <= fade * 2) {
    return [
      [0, 0],
      [fade, 1],
      [lastFrame, 0],
    ];
  }
  return [
    [0, 0],
    [fade, 1],
    [durationFrames - fade, 1],
    [lastFrame, 0],
  ];
}

/**
 * Aplica los overlays didácticos de `plan.overlays` (si hay) y siempre el
 * logo de marca, cada uno en su propio track nuevo (nunca `trackIndex`, y
 * agregados ENCIMA de lo existente, no reemplazando nada).
 */
export async function applyOverlays(
  client: PalmierClient,
  plan: LessonAssemblyPlan,
  jobId: string,
  introFrames: number
): Promise<void> {
  // `introFrames` es el offset REAL pasado por backend.ts: 0 si el intro
  // estaba planeado pero no se insertó de verdad (archivo ausente en disco u
  // otra falla), nunca derivado de `plan.intro` a ciegas (ver FLUJO-AGROMAX-2tl).
  if (plan.overlays.length > 0) {
    const mediaRefs: string[] = [];
    for (const item of plan.overlays) {
      const absPath = path.join(plan.publicRoot, item.file);
      mediaRefs.push(await importAndWait(client, absPath, `overlay-${item.key}`));
    }

    // Un solo lote, SIN trackIndex en ninguna entry: la app crea un track
    // nuevo compartido para todos los overlays de esta clase.
    const addResult = await client.call("add_clips", {
      entries: plan.overlays.map((item, i) => ({
        mediaRef: mediaRefs[i],
        startFrame: item.startFrame + introFrames,
        endFrame: item.endFrame + introFrames,
      })),
    });
    const clipIds = extractClipIds(addResult, plan.overlays.length);

    for (let i = 0; i < plan.overlays.length; i++) {
      const item = plan.overlays[i];
      const clipId = clipIds[i];
      const transform = overlayTransform(item, plan.width, plan.height);
      await client.call("set_clip_properties", { clipIds: [clipId], transform });

      const duration = item.endFrame - item.startFrame;
      await client.call("set_keyframes", {
        clipId,
        property: "opacity",
        keyframes: fadeOpacityKeyframes(duration),
      });
    }
  }

  // Logo de marca: SIEMPRE (con o sin overlays), en su propio track nuevo
  // (otra llamada a add_clips SIN trackIndex), top-right, toda la clase.
  const logoPath = path.join(process.cwd(), "public", "agromax-logo.png");
  const logoMediaRef = await importAndWait(client, logoPath, `logo-${jobId}`);
  const logoAddResult = await client.call("add_clips", {
    entries: [{ mediaRef: logoMediaRef, startFrame: 0, endFrame: plan.expectedFrames }],
  });
  const [logoClipId] = extractClipIds(logoAddResult, 1);

  await client.call("set_clip_properties", {
    clipIds: [logoClipId],
    transform: {
      centerX: LOGO_CENTER_X,
      centerY: LOGO_CENTER_Y,
      width: LOGO_WIDTH,
      height: LOGO_HEIGHT,
    },
    opacity: LOGO_OPACITY,
  });
}
