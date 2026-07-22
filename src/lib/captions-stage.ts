/**
 * captions-stage.ts — etapa determinista post-cortes del pipeline: agrupa
 * las palabras con marca de tiempo de la transcripción de Whisper en
 * captions cortos y las remapea al timeline de SALIDA de cada clase
 * (después de aplicar los cortes de silencio de plan/cuts/<lessonId>.json),
 * escritos en jobs/<id>/plan/captions/<lessonId>.json.
 *
 * Sin modelo de por medio: es aritmética pura sobre lo que ya calcularon las
 * etapas 3 (transcripción) y 5C (cortes). Si algo sale mal acá, tiene que
 * poder explicarse leyendo este archivo.
 *
 * CONVENCIÓN DE FRAMES DE SALIDA: igual que plan/cuts, los rangos son
 * semiabiertos [startFrame, endFrame). Los frames son relativos al PRIMER
 * frame de CONTENIDO de la clase (el primer frame del primer tramo "keep"),
 * SIN el offset del intro: es Lesson.tsx (etapa 11) quien suma
 * introDurationInFrames al renderizar, tanto para los tramos de video como
 * para (cuando se integren) los captions.
 *
 * ORDEN: replica EXACTO el orden en el que assembly/plan.ts (líneas ~195-206)
 * arma el timeline de una clase — iterar los clips de CutsFile.clips en
 * orden, y dentro de cada uno sus `keep` en orden, con un cursor acumulador
 * de duraciones "keep" (la misma idea que el cursor de Lesson.tsx:38-57,
 * salvo que ahí arranca en introDurationInFrames y acá arranca en 0 porque
 * el intro se suma después).
 *
 * MAPEO DE UNA PALABRA AL TIMELINE DE SALIDA: cada `keep` de un CutsClip
 * describe un rango de frames EN EL ESPACIO DE FRAMES DEL CLIP FUENTE (no
 * relativo al segmento): segStartFrame/segEndFrame salen de
 * `Math.round(segment.startSeconds * fps)` en cuts-stage.ts, y por lo tanto
 * el frame de una palabra de Whisper (`Math.round(word.start * fps)`, en ese
 * mismo espacio) se puede comparar DIRECTO contra los `keep` de ese mismo
 * CutsClip (que representa un segmento = clip + rango de tiempo).
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  readCutsFiles,
  transcriptsDir,
  writeCaptionsJson,
} from "./jobs";
import type { Caption, CaptionWord, CaptionsFile, CutsFile } from "./types";
import type {
  TranscriptResult,
  TranscriptSegment,
} from "./transcribe/types";

/** Máximo de palabras por caption, antes de forzar un corte de grupo. */
const CAPTION_MAX_WORDS = 3;

/** Hueco (en segundos, tiempo del clip fuente) que fuerza un corte de grupo. */
const CAPTION_GAP_SECONDS = 0.6;

/** Duración mínima (en frames de salida) para conservar un caption. */
const MIN_CAPTION_FRAMES = 2;

/**
 * Lee transcripts/<base>.json de un clip (sin extensión) de un job. Devuelve
 * null si el archivo no existe (mismo criterio tolerante que cuts-stage.ts).
 */
async function readClipTranscript(
  jobId: string,
  clip: string
): Promise<TranscriptResult | null> {
  const base = path.basename(clip, path.extname(clip));
  const filePath = path.join(transcriptsDir(jobId), `${base}.json`);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as TranscriptResult;
  } catch {
    return null;
  }
}

/**
 * Un tramo de la clase que replica, en orden, el timeline de salida de
 * assembly/plan.ts: un `keep` de un CutsClip con el frame de salida en el
 * que arranca (`cursor`).
 */
interface KeepEntry {
  clip: string;
  startFrame: number;
  endFrame: number;
  cursor: number;
}

/**
 * Reconstruye el timeline de "keep" de una clase EXACTAMENTE en el mismo
 * orden y con el mismo cursor acumulador que assembly/plan.ts:195-206 (y por
 * lo tanto, salvo el offset del intro, que Lesson.tsx:38-57).
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

/** Una palabra ya remapeada al timeline de salida, con su procedencia para agrupar. */
interface MappedWord {
  text: string;
  outStartFrame: number;
  outEndFrame: number;
  /** Segundo de inicio en el clip fuente (para el chequeo de hueco > 0.6s). */
  sourceStartSeconds: number;
  /** Segundo de fin en el clip fuente. */
  sourceEndSeconds: number;
  /** Referencia al segmento de Whisper de origen, para detectar su frontera. */
  segmentRef: TranscriptSegment;
  /** Índice del KeepEntry (tramo del timeline de salida) al que pertenece. */
  entryIndex: number;
}

/**
 * Localiza, dentro de un `keep` FrameRange, si un frame (en el espacio de
 * frames del clip fuente) cae dentro de él. Los `keep` de un CutsClip vienen
 * ordenados y sin traslapes (son el complemento de los `cuts`), así que basta
 * un recorrido lineal.
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
 * Mapea todas las palabras de la transcripción de un clip al timeline de
 * salida de la clase, descartando las que caen completas en un tramo
 * cortado (`cuts`) y clampeando al `keep` las que cruzan su borde.
 */
function mapClipWords(
  clip: string,
  transcript: TranscriptResult,
  fps: number,
  entries: KeepEntry[]
): MappedWord[] {
  const mapped: MappedWord[] = [];

  for (const segment of transcript.segments) {
    for (const word of segment.words) {
      const text = word.word.trim();
      if (!text) continue;

      const frameProxy = Math.round(word.start * fps);
      const entryIndex = findContainingKeepIndex(entries, clip, frameProxy);
      if (entryIndex === -1) {
        // La palabra cae completa en un tramo cortado (gap): se descarta.
        continue;
      }
      const entry = entries[entryIndex];

      let endFrameProxy = Math.round(word.end * fps);
      // Clamp al keep que contiene el inicio de la palabra, y garantizar al
      // menos 1 frame de duración en el espacio del clip fuente.
      endFrameProxy = Math.min(endFrameProxy, entry.endFrame);
      endFrameProxy = Math.max(endFrameProxy, frameProxy + 1);

      const outStartFrame = entry.cursor + (frameProxy - entry.startFrame);
      const outEndFrame = entry.cursor + (endFrameProxy - entry.startFrame);

      mapped.push({
        text,
        outStartFrame,
        outEndFrame,
        sourceStartSeconds: word.start,
        sourceEndSeconds: word.end,
        segmentRef: segment,
        entryIndex,
      });
    }
  }

  return mapped;
}

/**
 * Agrupa una lista de palabras YA remapeadas y en orden de salida en
 * captions: máximo CAPTION_MAX_WORDS palabras, rompiendo también en frontera
 * de segmento de Whisper, cuando el hueco entre palabras (dentro del mismo
 * tramo "keep") supera CAPTION_GAP_SECONDS, o al cruzar de un keep a otro.
 * Descarta captions con duración de salida menor a MIN_CAPTION_FRAMES.
 * Garantiza que no haya solapes entre captions consecutivos (clampeando el
 * inicio del siguiente si hiciera falta).
 */
function groupIntoCaptions(words: MappedWord[]): Caption[] {
  const captions: Caption[] = [];
  let group: MappedWord[] = [];

  const flush = () => {
    if (group.length === 0) return;
    let startFrame = group[0].outStartFrame;
    const endFrame = group[group.length - 1].outEndFrame;

    const last = captions[captions.length - 1];
    if (last && startFrame < last.endFrame) {
      // Salvaguarda: no debería pasar dado el orden del timeline, pero se
      // evita cualquier solape clampeando el inicio al fin del anterior.
      startFrame = last.endFrame;
    }

    if (endFrame - startFrame >= MIN_CAPTION_FRAMES) {
      const words_: CaptionWord[] = group.map((w) => ({
        text: w.text,
        startFrame: w.outStartFrame,
        endFrame: w.outEndFrame,
      }));
      captions.push({
        text: group.map((w) => w.text).join(" "),
        startFrame,
        endFrame,
        words: words_,
      });
    }
    group = [];
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const prev = group[group.length - 1];

    if (prev) {
      const crossedKeep = word.entryIndex !== prev.entryIndex;
      const crossedSegment = word.segmentRef !== prev.segmentRef;
      const gapSeconds = word.sourceStartSeconds - prev.sourceEndSeconds;
      const bigGap = !crossedKeep && gapSeconds > CAPTION_GAP_SECONDS;
      const full = group.length >= CAPTION_MAX_WORDS;

      if (crossedKeep || crossedSegment || bigGap || full) {
        flush();
      }
    }

    group.push(word);
  }
  flush();

  return captions;
}

/**
 * Corre la etapa de captions para un job: lee cada plan/cuts/<lessonId>.json
 * ya generado por la etapa de cortes (5C) junto con los transcripts/ de sus
 * clips, y por cada lección genera plan/captions/<lessonId>.json con las
 * palabras de Whisper agrupadas y remapeadas al timeline de salida.
 *
 * Idempotente: sobrescribe por completo cada archivo de plan/captions/ en
 * cada corrida.
 */
export async function runCaptionsStage(jobId: string): Promise<void> {
  const cutsFiles = await readCutsFiles(jobId);

  const transcriptCache = new Map<string, TranscriptResult | null>();
  async function getTranscript(clip: string): Promise<TranscriptResult | null> {
    if (!transcriptCache.has(clip)) {
      transcriptCache.set(clip, await readClipTranscript(jobId, clip));
    }
    return transcriptCache.get(clip) ?? null;
  }

  for (const cutsFile of cutsFiles) {
    const fps = cutsFile.fps;
    const entries = buildKeepTimeline(cutsFile);

    // Cache de transcript por clip (un mismo clip fuente puede aparecer en
    // más de un CutsClip de la misma lección).
    const clipsSeen = new Set<string>();
    const allWords: MappedWord[] = [];

    for (const clipCuts of cutsFile.clips) {
      if (clipsSeen.has(clipCuts.clip)) continue;
      clipsSeen.add(clipCuts.clip);

      const transcript = await getTranscript(clipCuts.clip);
      if (!transcript) {
        console.warn(
          `[captions-stage] job ${jobId}: sin transcript para el clip "${clipCuts.clip}" ` +
            `(lección "${cutsFile.lessonId}"); no se generan captions para ese clip`
        );
        continue;
      }

      allWords.push(...mapClipWords(clipCuts.clip, transcript, fps, entries));
    }

    // Las palabras de cada clip ya salen ordenadas por su propio orden de
    // aparición en el transcript, pero para respetar el orden del timeline
    // de salida (que puede intercalar tramos de distintos clips) se ordena
    // el conjunto final por el frame de salida.
    allWords.sort((a, b) => a.outStartFrame - b.outStartFrame);

    const captions = groupIntoCaptions(allWords);

    const captionsFile: CaptionsFile = {
      lessonId: cutsFile.lessonId,
      fps,
      generatedAt: new Date().toISOString(),
      captions,
    };

    await writeCaptionsJson(jobId, captionsFile);
  }
}
