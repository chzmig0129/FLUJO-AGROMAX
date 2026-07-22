/**
 * overlays-timeline-stage.ts — etapa determinista post-Gate 1 del pipeline:
 * remapea los overlays didácticos aprobados (o, a falta de Gate 1, los que
 * ya tienen su PNG final) al timeline de SALIDA de cada clase, con el MISMO
 * algoritmo keep-aware que captions-stage.ts, escritos en
 * jobs/<id>/plan/overlays-timeline/<lessonId>.json.
 *
 * Sin modelo de por medio: es aritmética pura sobre lo que ya calcularon las
 * etapas 5C (cortes), 7 (briefs de overlays) y Gate 1 (QA visual). Si algo
 * sale mal acá, tiene que poder explicarse leyendo este archivo.
 *
 * CONVENCIÓN DE FRAMES DE SALIDA: igual que plan/cuts y plan/captions, los
 * rangos son semiabiertos [startFrame, endFrame). Los frames son relativos
 * al PRIMER frame de CONTENIDO de la clase (el primer frame del primer
 * tramo "keep"), SIN el offset del intro: es Lesson.tsx (etapa 11) quien
 * suma introDurationInFrames al renderizar, tanto para los tramos de video
 * como para captions y overlays.
 *
 * ORDEN Y CURSOR: replica EXACTO el mismo `buildKeepTimeline` de
 * captions-stage.ts (ver ese archivo para el razonamiento completo) — se
 * reescribe acá en vez de importarse porque captions-stage.ts no exporta
 * esas piezas internas y no se debe tocar ese archivo para exponerlas.
 *
 * MAPEO DE UN OVERLAY AL TIMELINE DE SALIDA: `brief.at_seconds` es un
 * instante en el tiempo FUENTE del clip citado por `brief.clip`
 * (`Math.round(at_seconds * fps)`, mismo espacio de frames que los `keep` de
 * ese CutsClip). Si ese frame cae dentro de un `keep`, se traduce al frame
 * de salida igual que una palabra de captions-stage. Si cae en un `cut`
 * (hueco recortado), se mueve al inicio del siguiente `keep` del MISMO clip
 * — un dato que ocurre durante un silencio recortado igual debe mostrarse en
 * cuanto vuelve a haber contenido.
 *
 * DURACIÓN DE UN OVERLAY: fija en pantalla (OVERLAY_DISPLAY_SECONDS), salvo
 * que se pase del fin del "keep-chain" de la clase (la suma total de frames
 * de contenido, sin intro): en ese caso se recorta ahí. No se limita al fin
 * del tramo "keep" en el que arrancó — es una duración sobre el timeline de
 * SALIDA ya ensamblado, no sobre el clip fuente.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  assetsDir,
  planDir,
  qaDir,
  readCutsFiles,
} from "./jobs";
import { probeRaw } from "./probe";
import { OVERLAY_DISPLAY_SECONDS } from "./constants";
import type { CutsFile } from "./types";
import type { OverlayTimelineFile, OverlayTimelineItem } from "./assembly/types";

/** Un brief de overlay tal como lo produce la etapa 7 (plan/overlays/<lessonId>.json). */
interface OverlayBriefDisk {
  key: string;
  fact: string;
  at_seconds: number;
  clip: string;
  prompt: string;
  aspect: "wide" | "square";
}

/** Forma en disco de plan/overlays/<lessonId>.json (etapa 7, otro worker la produce). */
interface OverlaysBriefsFileDisk {
  lessonId: string;
  generatedAt: string;
  briefs: OverlayBriefDisk[];
}

/** Un veredicto de imagen dentro de qa/gate1.json (etapa Gate 1). */
interface Gate1ImageVerdict {
  key: string;
  verdict: "APPROVED" | "REJECTED";
}

/** Forma en disco de jobs/<id>/qa/gate1.json (etapa Gate 1, otro worker la produce). */
interface Gate1FileDisk {
  auditedAt: string;
  images: Gate1ImageVerdict[];
}

/** Ruta absoluta al subdirectorio plan/overlays/ de un job (briefs, etapa 7). */
function overlaysBriefsDirPath(jobId: string): string {
  return path.join(planDir(jobId), "overlays");
}

/** Ruta absoluta a plan/overlays/<lessonId>.json de un job. */
function overlaysBriefsJsonPath(jobId: string, lessonId: string): string {
  return path.join(overlaysBriefsDirPath(jobId), `${lessonId}.json`);
}

/** Ruta absoluta al subdirectorio plan/overlays-timeline/ de un job (esta etapa). */
function overlaysTimelineDirPath(jobId: string): string {
  return path.join(planDir(jobId), "overlays-timeline");
}

/** Ruta absoluta a plan/overlays-timeline/<lessonId>.json de un job. */
function overlaysTimelineJsonPath(jobId: string, lessonId: string): string {
  return path.join(overlaysTimelineDirPath(jobId), `${lessonId}.json`);
}

/** Ruta absoluta a jobs/<id>/qa/gate1.json. */
function gate1JsonPath(jobId: string): string {
  return path.join(qaDir(jobId), "gate1.json");
}

/** Ruta absoluta al PNG final de un overlay aprobado: assets/overlays/final/<key>.png. */
function overlayFinalPngPath(jobId: string, key: string): string {
  return path.join(assetsDir(jobId), "overlays", "final", `${key}.png`);
}

/** Ruta pública (relativa a assets/) del PNG final de un overlay, tal como se escribe en disco. */
function overlayFinalPngPublicPath(key: string): string {
  return `overlays/final/${key}.png`;
}

/**
 * Lee plan/overlays/<lessonId>.json de forma tolerante: si el archivo no
 * existe o no parsea, devuelve `[]` (0 briefs para esa lección es un
 * resultado válido de la etapa 7, y su ausencia total no debe romper esta
 * etapa).
 */
async function readOverlayBriefs(
  jobId: string,
  lessonId: string
): Promise<OverlayBriefDisk[]> {
  try {
    const raw = await fs.readFile(overlaysBriefsJsonPath(jobId, lessonId), "utf-8");
    const parsed = JSON.parse(raw) as OverlaysBriefsFileDisk;
    return Array.isArray(parsed?.briefs) ? parsed.briefs : [];
  } catch {
    return [];
  }
}

/**
 * Lee jobs/<id>/qa/gate1.json de forma tolerante: devuelve `null` si el
 * archivo no existe o no parsea — Gate 1 puede no haber corrido todavía, y
 * en ese caso esta etapa cae al criterio de "el PNG final ya existe" (ver
 * `isOverlayApproved`).
 */
async function readGate1File(jobId: string): Promise<Gate1FileDisk | null> {
  try {
    const raw = await fs.readFile(gate1JsonPath(jobId), "utf-8");
    const parsed = JSON.parse(raw) as Gate1FileDisk;
    return Array.isArray(parsed?.images) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * true si el archivo indicado existe en disco (chequeo barato, sin leerlo).
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide si un overlay debe entrar al timeline: si hay qa/gate1.json, SOLO
 * las keys con verdict "APPROVED"; si no hay gate1.json todavía, todas las
 * keys que ya tengan su PNG final en disco (assets/overlays/final/<key>.png)
 * — el criterio "best effort" para poder previsualizar antes de que corra
 * Gate 1.
 */
async function isOverlayApproved(
  jobId: string,
  key: string,
  gate1: Gate1FileDisk | null
): Promise<boolean> {
  if (gate1) {
    return gate1.images.some((img) => img.key === key && img.verdict === "APPROVED");
  }
  return fileExists(overlayFinalPngPath(jobId, key));
}

/**
 * Un tramo de la clase que replica, en orden, el timeline de salida de
 * assembly/plan.ts (y por lo tanto de captions-stage.ts): un `keep` de un
 * CutsClip con el frame de salida en el que arranca (`cursor`).
 */
interface KeepEntry {
  clip: string;
  startFrame: number;
  endFrame: number;
  cursor: number;
}

/**
 * Reconstruye el timeline de "keep" de una clase EXACTAMENTE en el mismo
 * orden y con el mismo cursor acumulador que assembly/plan.ts:195-206 y
 * captions-stage.ts:buildKeepTimeline (ver ahí el razonamiento completo).
 */
function buildKeepTimeline(cutsFile: CutsFile): KeepEntry[] {
  const entries: KeepEntry[] = [];
  let cursor = 0;

  for (const clipCuts of cutsFile.clips) {
    for (const keep of clipCuts.keep) {
      const duration = keep.endFrame - keep.startFrame;
      if (duration <= 0) continue;
      entries.push({
        clip: clipCuts.clip,
        startFrame: keep.startFrame,
        endFrame: keep.endFrame,
        cursor,
      });
      cursor += duration;
    }
  }

  return entries;
}

/**
 * Localiza, dentro de un `keep` FrameRange, si un frame (en el espacio de
 * frames del clip fuente) cae dentro de él. Mismo criterio que
 * captions-stage.ts:findContainingKeepIndex.
 */
function findContainingKeepIndex(
  entries: KeepEntry[],
  clip: string,
  frame: number
): number {
  return entries.findIndex(
    (e) => e.clip === clip && frame >= e.startFrame && frame < e.endFrame
  );
}

/**
 * Busca, entre los `keep` de un mismo clip, el primero que arranca DESPUÉS
 * del frame dado — "el siguiente keep" al que se mueve un overlay cuyo
 * `at_seconds` cayó dentro de un corte. `entries` conserva el orden de
 * aparición de assembly/plan.ts, así que el primer match ya es el más
 * cercano hacia adelante.
 */
function findNextKeepAfter(
  entries: KeepEntry[],
  clip: string,
  frame: number
): KeepEntry | null {
  return entries.find((e) => e.clip === clip && e.startFrame > frame) ?? null;
}

/**
 * Traduce el frame de salida del contenido total de la clase (intro-agnóstico):
 * suma de todas las duraciones "keep". Es el límite contra el que se clampea
 * la duración en pantalla de cada overlay.
 */
function totalContentFrames(entries: KeepEntry[]): number {
  if (entries.length === 0) return 0;
  const last = entries[entries.length - 1];
  return last.cursor + (last.endFrame - last.startFrame);
}

/**
 * Sonda el aspecto real (alto/ancho) del PNG final de un overlay con
 * ffprobe (probeRaw, ya usado por assembly/plan.ts para audio de proxies).
 * ffprobe también sabe leer imágenes fijas (las trata como un stream de
 * video de un solo frame). Si la sonda falla, se cae al aspecto declarado
 * en el brief ("wide" ~ 16:9, "square" ~ 1:1) para no bloquear el timeline
 * por un detalle cosmético.
 */
async function probeOverlayAspect(
  pngPath: string,
  fallback: "wide" | "square"
): Promise<number> {
  const raw = (await probeRaw(pngPath)) as
    | { streams?: Array<{ width?: number; height?: number }> }
    | null;
  const stream = raw?.streams?.find(
    (s) => typeof s.width === "number" && typeof s.height === "number" && s.width > 0 && s.height > 0
  );
  if (stream && stream.width && stream.height) {
    return stream.height / stream.width;
  }
  return fallback === "wide" ? 0.5 : 1;
}

/**
 * Corre la etapa de timeline de overlays para un job: por cada
 * plan/cuts/<lessonId>.json ya generado (etapa 5C), lee los briefs de
 * overlays de esa lección (etapa 7) y el veredicto global de Gate 1 (si
 * existe), remapea los aprobados al timeline de salida y escribe
 * plan/overlays-timeline/<lessonId>.json.
 *
 * Idempotente: sobrescribe por completo cada archivo de
 * plan/overlays-timeline/ en cada corrida.
 */
export async function runOverlaysTimelineStage(jobId: string): Promise<void> {
  const cutsFiles = await readCutsFiles(jobId);
  const gate1 = await readGate1File(jobId);

  await fs.mkdir(overlaysTimelineDirPath(jobId), { recursive: true });

  for (const cutsFile of cutsFiles) {
    const fps = cutsFile.fps;
    const entries = buildKeepTimeline(cutsFile);
    const contentFrames = totalContentFrames(entries);

    const briefs = await readOverlayBriefs(jobId, cutsFile.lessonId);
    const items: OverlayTimelineItem[] = [];

    for (const brief of briefs) {
      const approved = await isOverlayApproved(jobId, brief.key, gate1);
      if (!approved) continue;

      if (!(await fileExists(overlayFinalPngPath(jobId, brief.key)))) {
        console.warn(
          `[overlays-timeline-stage] job ${jobId}: overlay "${brief.key}" aprobado pero sin PNG final ` +
            `(lección "${cutsFile.lessonId}"); se omite`
        );
        continue;
      }

      const frameProxy = Math.round(brief.at_seconds * fps);
      const entryIndex = findContainingKeepIndex(entries, brief.clip, frameProxy);

      let startFrame: number;
      if (entryIndex !== -1) {
        const entry = entries[entryIndex];
        startFrame = entry.cursor + (frameProxy - entry.startFrame);
      } else {
        // El instante cae en un corte: se mueve al inicio del siguiente keep
        // del mismo clip.
        const next = findNextKeepAfter(entries, brief.clip, frameProxy);
        if (!next) {
          console.warn(
            `[overlays-timeline-stage] job ${jobId}: overlay "${brief.key}" cae después del último ` +
              `tramo conservado del clip "${brief.clip}" (lección "${cutsFile.lessonId}"); se omite`
          );
          continue;
        }
        startFrame = next.cursor;
      }

      const endFrame = Math.min(
        startFrame + Math.round(OVERLAY_DISPLAY_SECONDS * fps),
        contentFrames
      );
      if (endFrame <= startFrame) continue;

      const aspect = await probeOverlayAspect(
        overlayFinalPngPath(jobId, brief.key),
        brief.aspect
      );

      items.push({
        key: brief.key,
        file: overlayFinalPngPublicPath(brief.key),
        startFrame,
        endFrame,
        aspect,
      });
    }

    items.sort((a, b) => a.startFrame - b.startFrame);

    const overlaysTimelineFile: OverlayTimelineFile = {
      lessonId: cutsFile.lessonId,
      fps,
      overlays: items,
    };

    await fs.writeFile(
      overlaysTimelineJsonPath(jobId, cutsFile.lessonId),
      JSON.stringify(overlaysTimelineFile, null, 2),
      "utf-8"
    );
  }
}

/**
 * Verifica (tolerante) si el job tiene `plan/cuts/` con al menos un archivo
 * y `plan/overlays/` con al menos un archivo — los dos prerequisitos reales
 * de esta etapa. Se usa desde la ruta HTTP para responder 400 sin encolar
 * nada.
 */
export async function hasOverlaysTimelinePrerequisites(jobId: string): Promise<boolean> {
  const cutsFiles = await readCutsFiles(jobId);
  if (cutsFiles.length === 0) return false;

  let entries: string[];
  try {
    entries = await fs.readdir(overlaysBriefsDirPath(jobId));
  } catch {
    return false;
  }
  return entries.some((entry) => entry.endsWith(".json"));
}
