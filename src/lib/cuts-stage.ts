/**
 * cuts-stage.ts — etapa 5C del pipeline: cortes deterministas derivados de
 * los huecos entre segmentos de la transcripción de Whisper, escritos en
 * jobs/<id>/plan/cuts/<lessonId>.json.
 *
 * Esta es la pieza más "inspeccionable" del pipeline: cada corte propuesto
 * debe poder explicarse leyendo este archivo. No hay heurísticas ocultas ni
 * agentes de por medio — todo sale de sumar/restar segundos de Whisper con
 * las constantes de constants.ts.
 *
 * IDEA GENERAL por cada segmento (clip + rango de tiempo) de cada lección:
 *   1. Si la lección es 'demo': no se toca nada, todo el segmento se
 *      conserva tal cual (el silencio ES el contenido de una demo).
 *   2. Si es 'normal': se toma la transcripción de Whisper del clip y se
 *      buscan los huecos (tramos sin habla) DENTRO del rango del segmento
 *      —incluyendo el hueco inicial (0 → primer segmento hablado) y el
 *      final (último segmento hablado → fin del rango), si corresponden—.
 *      Los huecos suficientemente largos (> GAP_MIN_SECONDS) se recortan,
 *      dejando siempre un colchón de aire (CUT_PADDING_SECONDS) a cada lado
 *      para nunca comerse el borde de una palabra.
 *
 * CONVENCIÓN DE FRAMES: un FrameRange {startFrame, endFrame} es un intervalo
 * semiabierto [startFrame, endFrame) — es decir, incluye el frame
 * `startFrame` pero NO el frame `endFrame`. Esta convención es la que hace
 * que "cuts + keep particionan el rango del segmento sin huecos ni
 * traslapes" sea aritméticamente trivial: basta con que los extremos
 * coincidan (el endFrame de un tramo es el startFrame del siguiente).
 *
 * INVARIANTE: igual que las demás etapas deterministas (5A/5B), esta etapa
 * SOLO LEE de source/ (indirectamente, vía transcripts/ que ya fueron
 * generados en la etapa 3); jamás escribe, mueve ni borra nada ahí dentro.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  CUT_PADDING_SECONDS,
  GAP_MIN_SECONDS,
  MIN_CUT_FRAMES,
  PROXY_FPS,
} from "./constants";
import {
  readSilenceJson,
  readStructureJson,
  transcriptsDir,
  writeCutsFile,
} from "./jobs";
import type {
  CutRange,
  CutsClip,
  CutsFile,
  FrameRange,
  SilenceInterval,
  SilenceJson,
} from "./types";
import type { TranscriptResult, TranscriptSegment } from "./transcribe/types";

/**
 * Lee transcripts/<base>.json de un clip (sin extensión) de un job. Devuelve
 * null si el archivo no existe en vez de lanzar un error: la etapa lo trata
 * como "clip sin transcript" (caso borde que no debería darse en una
 * lección, pero se maneja con un warning en vez de reventar todo el job).
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
 * Un tramo sin habla, en segundos, dentro del rango [rangeStart, rangeEnd)
 * de un segmento de estructura.
 */
interface GapSeconds {
  start: number;
  end: number;
}

/**
 * Calcula los huecos (tramos sin habla) entre los segmentos de Whisper que
 * caen dentro de [rangeStart, rangeEnd], recortados (clamped) a ese rango.
 *
 * Incluye, si corresponden:
 *   - el hueco inicial: rangeStart → inicio del primer segmento hablado
 *     dentro del rango (si el primer segmento no arranca justo en
 *     rangeStart).
 *   - los huecos internos: fin de un segmento hablado → inicio del
 *     siguiente.
 *   - el hueco final: fin del último segmento hablado → rangeEnd (si el
 *     último segmento no termina justo en rangeEnd).
 *
 * Si no hay NINGÚN segmento de Whisper dentro del rango (clip sin habla
 * detectada en ese tramo), se trata todo [rangeStart, rangeEnd] como un
 * único hueco — caso borde legítimo, no debería ser común en una lección
 * 'normal' pero es la interpretación consistente del algoritmo.
 */
function computeGaps(
  segments: TranscriptSegment[],
  rangeStart: number,
  rangeEnd: number
): GapSeconds[] {
  // Solo interesan los segmentos hablados que se solapan con el rango del
  // segmento de estructura, ordenados por inicio, y recortados (clamped) a
  // ese rango para no arrastrar habla que está fuera del segmento.
  const overlapping = segments
    .filter((s) => s.start < rangeEnd && s.end > rangeStart)
    .map((s) => ({
      start: Math.max(s.start, rangeStart),
      end: Math.min(s.end, rangeEnd),
    }))
    .sort((a, b) => a.start - b.start);

  const gaps: GapSeconds[] = [];
  let cursor = rangeStart;

  for (const seg of overlapping) {
    if (seg.start > cursor) {
      gaps.push({ start: cursor, end: seg.start });
    }
    // avanzar el cursor solo hacia adelante: dos segmentos hablados
    // solapados entre sí (no debería pasar, pero por las dudas) no deben
    // hacer retroceder el cursor y generar un hueco negativo.
    cursor = Math.max(cursor, seg.end);
  }

  if (rangeEnd > cursor) {
    gaps.push({ start: cursor, end: rangeEnd });
  }

  return gaps;
}

/** true si [aStart, aEnd) se solapa con [bStart, bEnd). */
function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * Convierte un hueco (en segundos) candidato a corte en un CutRange en
 * frames, o null si el hueco no es recortable (demasiado corto, el padding
 * se come el hueco entero, o el resultado queda por debajo de
 * MIN_CUT_FRAMES tras recortar y clampear al segmento).
 *
 * REDONDEO CONSERVADOR (por qué ceil en el inicio y floor en el fin): el
 * corte real que se aplica es SIEMPRE en frames enteros, pero el hueco y el
 * padding están en segundos. Si redondeáramos "al frame más cercano" en
 * ambos extremos, podríamos terminar incluyendo en el corte un frame que en
 * realidad ya pertenece al borde de una palabra hablada (el redondeo podría
 * "acercar" el corte hacia la habla). En cambio:
 *   - ceil(inicio): el frame de inicio del corte se redondea HACIA ADELANTE
 *     (más tarde), es decir el corte empieza más tarde de lo estrictamente
 *     necesario → el margen de aire que queda antes del corte (del lado de
 *     la habla previa) solo puede agrandarse, nunca achicarse.
 *   - floor(fin): el frame de fin del corte se redondea HACIA ATRÁS (más
 *     temprano), el corte termina antes de lo estrictamente necesario → el
 *     margen de aire que queda después del corte (del lado de la habla
 *     siguiente) también solo puede agrandarse.
 * En ambos casos el redondeo AGRANDA el aire alrededor del corte, jamás se
 * come una palabra. El costo es conservar algún frame de silencio de más
 * ocasionalmente — un precio aceptable frente al riesgo de cortar audio.
 */
function gapToCut(
  gap: GapSeconds,
  fps: number,
  segStartFrame: number,
  segEndFrame: number,
  silences: SilenceInterval[]
): CutRange | null {
  const gapSeconds = gap.end - gap.start;
  if (gapSeconds <= GAP_MIN_SECONDS) {
    // Hueco demasiado corto para valer la pena recortarlo.
    return null;
  }

  const cutStartSeconds = gap.start + CUT_PADDING_SECONDS;
  const cutEndSeconds = gap.end - CUT_PADDING_SECONDS;
  if (cutEndSeconds <= cutStartSeconds) {
    // El padding de ambos lados se comió el hueco entero: nada que cortar.
    return null;
  }

  // Redondeo conservador — ver comentario arriba de la función.
  let startFrame = Math.ceil(cutStartSeconds * fps);
  let endFrame = Math.floor(cutEndSeconds * fps);

  // Clamp al rango de frames del segmento de estructura: el corte nunca
  // puede salirse del segmento al que pertenece. Clampear solo puede
  // ACHICAR el corte (nunca agrandarlo), así que la propiedad de "nunca
  // come habla" se preserva.
  startFrame = Math.max(startFrame, segStartFrame);
  endFrame = Math.min(endFrame, segEndFrame);

  if (endFrame - startFrame < MIN_CUT_FRAMES) {
    // Tras padding + redondeo + clamp, no queda un corte que valga la pena.
    return null;
  }

  const finalStartSeconds = startFrame / fps;
  const finalEndSeconds = endFrame / fps;
  const confirmedBySilence = silences.some((s) =>
    overlaps(finalStartSeconds, finalEndSeconds, s.start, s.end)
  );

  return {
    startFrame,
    endFrame,
    startSeconds: finalStartSeconds,
    endSeconds: finalEndSeconds,
    gapSeconds,
    confirmedBySilence,
  };
}

/**
 * Calcula el complemento de una lista de cortes (ordenados, sin traslapes,
 * ya clampeados al segmento) dentro de [segStartFrame, segEndFrame): los
 * tramos de frames que SÍ se conservan.
 */
function computeKeep(
  cuts: CutRange[],
  segStartFrame: number,
  segEndFrame: number
): FrameRange[] {
  const sorted = [...cuts].sort((a, b) => a.startFrame - b.startFrame);
  const keep: FrameRange[] = [];
  let cursor = segStartFrame;

  for (const cut of sorted) {
    if (cut.startFrame > cursor) {
      keep.push({ startFrame: cursor, endFrame: cut.startFrame });
    }
    cursor = Math.max(cursor, cut.endFrame);
  }

  if (segEndFrame > cursor) {
    keep.push({ startFrame: cursor, endFrame: segEndFrame });
  }

  return keep;
}

/**
 * Construye el CutsClip de un segmento (clip + rango) de una lección
 * 'normal', a partir de su transcripción de Whisper y (opcionalmente) de
 * probe/silence.json del clip para marcar confirmedBySilence.
 */
function buildNormalCutsClip(
  segment: { clip: string; startSeconds: number; endSeconds: number },
  transcript: TranscriptResult,
  fps: number,
  silences: SilenceInterval[]
): CutsClip {
  const segStartFrame = Math.round(segment.startSeconds * fps);
  const segEndFrame = Math.round(segment.endSeconds * fps);

  const gaps = computeGaps(
    transcript.segments,
    segment.startSeconds,
    segment.endSeconds
  );

  const cuts: CutRange[] = [];
  for (const gap of gaps) {
    const cut = gapToCut(gap, fps, segStartFrame, segEndFrame, silences);
    if (cut) cuts.push(cut);
  }
  // Ordenados por inicio: los huecos ya salen en orden de computeGaps, pero
  // lo garantizamos explícitamente para que keep/stats sean deterministas.
  cuts.sort((a, b) => a.startFrame - b.startFrame);

  const keep = computeKeep(cuts, segStartFrame, segEndFrame);

  const cutFrames = cuts.reduce((sum, c) => sum + (c.endFrame - c.startFrame), 0);
  const keepFrames = keep.reduce((sum, k) => sum + (k.endFrame - k.startFrame), 0);
  const rawSeconds = segment.endSeconds - segment.startSeconds;
  const projectedSeconds = keepFrames / fps;

  return {
    clip: segment.clip,
    kind: "normal",
    segment: {
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      startFrame: segStartFrame,
      endFrame: segEndFrame,
    },
    cuts,
    keep,
    stats: {
      cutFrames,
      keepFrames,
      rawSeconds,
      projectedSeconds,
    },
  };
}

/**
 * Construye el CutsClip "sin recorte" de un segmento: usado tanto para
 * lecciones 'demo' (el silencio ES el contenido, nunca se recorta) como
 * para el caso borde de un clip 'normal' sin transcript disponible (se
 * conserva todo el segmento y se avisa por consola, en vez de fallar el
 * job entero por un archivo faltante).
 */
function buildUncutCutsClip(
  segment: { clip: string; startSeconds: number; endSeconds: number },
  kind: "demo" | "normal",
  fps: number
): CutsClip {
  const segStartFrame = Math.round(segment.startSeconds * fps);
  const segEndFrame = Math.round(segment.endSeconds * fps);
  const keepFrames = segEndFrame - segStartFrame;
  const rawSeconds = segment.endSeconds - segment.startSeconds;

  return {
    clip: segment.clip,
    kind,
    segment: {
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      startFrame: segStartFrame,
      endFrame: segEndFrame,
    },
    cuts: [],
    keep: [{ startFrame: segStartFrame, endFrame: segEndFrame }],
    stats: {
      cutFrames: 0,
      keepFrames,
      rawSeconds,
      // Sin recorte: lo proyectado es igual a lo crudo.
      projectedSeconds: rawSeconds,
    },
  };
}

/**
 * Corre la etapa de cálculo de cortes (5C) para un job: lee
 * plan/structure.json y probe/silence.json, y por cada lección genera
 * plan/cuts/<lessonId>.json con los cortes propuestos de cada uno de sus
 * segmentos (clip + rango).
 *
 * Idempotente: sobrescribe por completo cada archivo de plan/cuts/ en cada
 * corrida (no borra archivos de lecciones que ya no existan en structure.json
 * actual, pero eso es aceptable: readCutsFiles es tolerante y una
 * re-planificación completa del curso ya invalidaría todo el prep de todos
 * modos).
 */
export async function runCutsStage(jobId: string): Promise<void> {
  const structure = await readStructureJson(jobId);
  if (!structure) {
    throw new Error(
      "No hay plan/structure.json: corre la etapa de plan antes de calcular cortes"
    );
  }

  const silenceJson: SilenceJson | null = await readSilenceJson(jobId);
  const silencesByClip = new Map<string, SilenceInterval[]>();
  if (silenceJson) {
    for (const clip of silenceJson.clips) {
      silencesByClip.set(clip.filename, clip.silences);
    }
  }

  // Cache de transcripts por clip: varios segmentos de distintas lecciones
  // pueden referenciar el mismo clip fuente, no vale la pena releerlo del
  // disco cada vez.
  const transcriptCache = new Map<string, TranscriptResult | null>();
  async function getTranscript(clip: string): Promise<TranscriptResult | null> {
    if (!transcriptCache.has(clip)) {
      transcriptCache.set(clip, await readClipTranscript(jobId, clip));
    }
    return transcriptCache.get(clip) ?? null;
  }

  const fps = PROXY_FPS;

  for (const mod of structure.modules) {
    for (const lesson of mod.lessons) {
      const kind = lesson.kind ?? "normal";
      const clips: CutsClip[] = [];

      for (const segment of lesson.segments) {
        if (kind === "demo") {
          // Demo: el silencio ES el contenido, jamás se recorta.
          clips.push(buildUncutCutsClip(segment, "demo", fps));
          continue;
        }

        const transcript = await getTranscript(segment.clip);
        if (!transcript) {
          // Caso borde: un clip 'normal' de una lección sin su
          // transcripción disponible. No debería pasar (toda lección viene
          // de un clip ya transcrito en la etapa 3), pero se avisa por
          // consola y se conserva el segmento entero en vez de fallar todo
          // el job por un archivo faltante.
          console.warn(
            `[cuts-stage] job ${jobId}: sin transcript para el clip "${segment.clip}" ` +
              `(lección "${lesson.id}"); se conserva el segmento completo sin recortes`
          );
          clips.push(buildUncutCutsClip(segment, "normal", fps));
          continue;
        }

        const silences = silencesByClip.get(segment.clip) ?? [];
        clips.push(buildNormalCutsClip(segment, transcript, fps, silences));
      }

      const cutsFile: CutsFile = {
        lessonId: lesson.id,
        lessonTitle: lesson.title,
        fps,
        generatedAt: new Date().toISOString(),
        clips,
      };

      await writeCutsFile(jobId, lesson.id, cutsFile);
    }
  }
}
