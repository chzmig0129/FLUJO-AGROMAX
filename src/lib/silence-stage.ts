/**
 * silence-stage.ts — etapa 5A del pipeline: detección de silencio con
 * ffmpeg silencedetect sobre los clips 'leccion' de la estructura, para
 * escribir jobs/<id>/probe/silence.json.
 *
 * Solo procesa los clips que aparecen en algún segments[] de plan/structure.json
 * (es decir, los que el agente clasificó como 'leccion' y usó en la
 * estructura del curso). El resto de los clips (broll/descartar/otro_curso)
 * no se tocan acá.
 *
 * INVARIANTE: igual que frames-stage.ts y transcribe/index.ts, esta etapa
 * SOLO LEE de source/ (para correr ffmpeg silencedetect); jamás escribe,
 * mueve ni borra nada ahí dentro.
 *
 * Se procesa un clip a la vez (secuencial): silencedetect es rápido (no
 * decodifica a un archivo de salida, solo analiza el audio con -f null) y no
 * vale la pena la complejidad de un pool de concurrencia para esta etapa.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { resolveFfmpegBin } from "./ffmpeg";
import { SILENCE_MIN_D, SILENCE_NOISE_DB, CUT_PADDING_SECONDS } from "./constants";
import {
  readMediaJson,
  readStructureJson,
  sourcePath,
  writeSilenceJson,
} from "./jobs";
import type { SilenceClip, SilenceInterval, SilenceJson, StructureJson } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Descubre los clips 'leccion' únicos a partir de plan/structure.json: son
 * los que aparecen en algún segments[] de alguna lección de algún módulo.
 * Devuelve, por clip, el `kind` resuelto (fallback 'normal' si la lección no
 * trae kind, por ejemplo structure.json viejo).
 *
 * Si un mismo clip aparece en más de una lección con kind distinto (caso
 * borde real: rumen-final.mp4 en el job de prueba está en una lección
 * 'normal' Y en una lección 'demo'), se resuelve como 'demo' apenas
 * CUALQUIER lección lo use como demostración — sin importar el orden en que
 * aparezcan las lecciones. Criterio conservador y no arbitrario (a
 * diferencia de "gana la primera lección"): si a ese clip se le recorta
 * silencio pensando que es contenido normal, se rompería la lección demo que
 * lo usa (ahí el silencio ES el contenido). cuts-stage.ts sí decide el kind
 * correctamente por SEGMENTO (cada lección obtiene su propio CutsClip con su
 * kind real); esto solo afecta el resumen agregado por clip de
 * probe/silence.json que se muestra en la UI (🖐 badge / tabla de shrink).
 */
function collectLessonClips(structure: StructureJson): Map<string, "demo" | "normal"> {
  const clips = new Map<string, "demo" | "normal">();
  for (const mod of structure.modules) {
    for (const lesson of mod.lessons) {
      const kind = lesson.kind ?? "normal";
      for (const segment of lesson.segments) {
        const existing = clips.get(segment.clip);
        // 'demo' es "pegajoso": una vez que alguna lección lo marca como
        // demo, ninguna lección 'normal' posterior lo puede degradar.
        if (existing !== "demo") {
          clips.set(segment.clip, kind);
        }
      }
    }
  }
  return clips;
}

/** Línea 'lavfi.silence_start=X' del stdout de ametadata. */
const SILENCE_START_REGEX = /lavfi\.silence_start=\s*(-?\d+(?:\.\d+)?)/;

/** Línea 'lavfi.silence_end=Y' del stdout de ametadata. */
const SILENCE_END_REGEX = /lavfi\.silence_end=\s*(-?\d+(?:\.\d+)?)/;

/** Línea 'lavfi.silence_duration=Z' del stdout de ametadata. */
const SILENCE_DURATION_REGEX =
  /lavfi\.silence_duration=\s*(-?\d+(?:\.\d+)?)/;

/**
 * Corre ffmpeg silencedetect sobre un clip y devuelve la lista de intervalos
 * de silencio.
 *
 * POR QUÉ NO SE PARSEA EL LOG DE ffmpeg (bug real, no paranoia):
 * silencedetect reporta sus hallazgos por el LOGGER, en nivel `info`. Con
 * `-v error` esas líneas se suprimen por completo y ffmpeg sale con código 0
 * y sin una sola línea de silencio — indistinguible de "este clip no tiene
 * silencios". Eso hacía que TODOS los clips de un job salieran con 0
 * silencios y shrink 100%, y el resultado parecía plausible (audio de campo,
 * poco silencio) en vez de parecer un bug. Verificado sobre el mismo
 * archivo: `-v error` → 0 silencios, `-v info` → 6.
 *
 * La solución no es subir el nivel de log (volvería a romperse si alguien lo
 * baja, y arrastra el ruido de ffmpeg al stderr): es pedirle a
 * `ametadata=mode=print:file=-` que escriba las marcas por STDOUT como datos.
 * Esa salida no depende de la verbosidad del logger.
 *
 * `-vn` descarta el video: silencedetect solo necesita el audio, y no
 * decodificar 4K hace la etapa muchísimo más rápida.
 *
 * Si el clip TERMINA en silencio, ffmpeg nunca emite el silence_end
 * correspondiente (el análisis corta en el EOF sin cerrar el tramo abierto):
 * en ese caso cerramos ese último intervalo con `durationSeconds` (la
 * duración real del clip, de probe/media.json).
 */
async function detectSilences(
  srcFile: string,
  durationSeconds: number
): Promise<SilenceInterval[]> {
  const ffmpegBin = resolveFfmpegBin();

  let stdout = "";
  try {
    const result = await execFileAsync(
      ffmpegBin,
      [
        "-v",
        "error",
        "-i",
        srcFile,
        // Sin video: silencedetect solo mira el audio.
        "-vn",
        "-af",
        `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_D},ametadata=mode=print:file=-`,
        "-f",
        "null",
        "-",
      ],
      // Un clip largo con muchos silencios genera bastantes líneas de
      // metadata; el buffer amplio evita un ENOBUFS espurio.
      { maxBuffer: 32 * 1024 * 1024 }
    );
    stdout = result.stdout;
  } catch (err) {
    // Si ffmpeg falla a mitad de camino, igual aprovechamos las marcas que
    // alcanzó a imprimir en vez de perder el análisis parcial.
    const stdoutFromError = (err as { stdout?: string }).stdout;
    if (typeof stdoutFromError === "string" && stdoutFromError.length > 0) {
      stdout = stdoutFromError;
    } else {
      throw err;
    }
  }

  const silences: SilenceInterval[] = [];
  let openStart: number | null = null;
  let pendingEnd: number | null = null;

  // ametadata imprime una clave por línea, en orden:
  //   lavfi.silence_start=28.5611
  //   lavfi.silence_end=29.0667
  //   lavfi.silence_duration=0.505578
  for (const line of stdout.split("\n")) {
    const startMatch = SILENCE_START_REGEX.exec(line);
    if (startMatch) {
      openStart = Number(startMatch[1]);
      pendingEnd = null;
      continue;
    }

    const endMatch = SILENCE_END_REGEX.exec(line);
    if (endMatch) {
      pendingEnd = Number(endMatch[1]);
      continue;
    }

    const durationMatch = SILENCE_DURATION_REGEX.exec(line);
    if (durationMatch && openStart !== null && pendingEnd !== null) {
      silences.push({
        start: openStart,
        end: pendingEnd,
        duration: Number(durationMatch[1]),
      });
      openStart = null;
      pendingEnd = null;
    }
  }

  // Silencio abierto que llegó hasta el EOF sin un silence_end: lo cerramos
  // con la duración real del clip (probe/media.json), no con lo que diga
  // ffmpeg (que a veces reporta timestamps ligeramente distintos al EOF).
  if (openStart !== null) {
    const end = durationSeconds;
    const duration = Math.max(0, end - openStart);
    silences.push({ start: openStart, end, duration });
  }

  return silences;
}

/**
 * Calcula cuántos segundos de un silencio son "recortables": se le resta el
 * padding de seguridad (CUT_PADDING_SECONDS) de AMBOS lados, el mismo aire
 * que la etapa 5C deja para no comerse palabras. Si el silencio es más
 * corto que 2×CUT_PADDING_SECONDS, no queda nada recortable (0).
 */
function trimmableSeconds(silence: SilenceInterval): number {
  return Math.max(0, silence.duration - 2 * CUT_PADDING_SECONDS);
}

/**
 * Corre la etapa de detección de silencio (5A) para un job: descubre los
 * clips 'leccion' desde plan/structure.json, corre ffmpeg silencedetect
 * sobre cada uno (secuencial) y escribe probe/silence.json.
 *
 * - Clips de lección 'demo': se miden los silencios igual (informativo, para
 *   inspección en la UI) pero `skipped=true`, `projectedSeconds=rawSeconds` y
 *   `shrinkRatio=1`. Esto es intencional: en una demo el silencio ES el
 *   contenido (el instructor trabajando con las manos en silencio mientras
 *   se ve la técnica), no aire muerto a recortar.
 * - Clips de lección 'normal': se suma la parte RECORTABLE de cada silencio
 *   (ver trimmableSeconds) para obtener totalSilentSeconds, se proyecta
 *   projectedSeconds = rawSeconds - totalSilentSeconds y se mide
 *   shrinkRatio = projectedSeconds / rawSeconds directamente de esos
 *   números — NO se asume un porcentaje fijo de ahorro; si el clip no tiene
 *   silencios recortables, shrinkRatio queda en 1.0 (sin sorpresas, se usa
 *   siempre lo medido).
 *
 * Idempotente: sobrescribe por completo probe/silence.json en cada corrida.
 * NUNCA toca jobs/<id>/source/: solo lo lee para correr ffmpeg (ver
 * invariante en el header de este archivo).
 */
export async function runSilenceStage(jobId: string): Promise<SilenceJson> {
  const structure = await readStructureJson(jobId);
  if (!structure) {
    throw new Error(
      "No hay plan/structure.json: corre la etapa de plan antes de detectar silencios"
    );
  }

  const media = await readMediaJson(jobId);
  const lessonClips = collectLessonClips(structure);

  const clips: SilenceClip[] = [];

  // Secuencial: un clip a la vez, en el orden en que aparecen en la
  // estructura (silencedetect es rápido, no hace falta paralelizar).
  for (const [filename, kind] of lessonClips) {
    const mediaEntry = media?.find((m) => m.filename === filename);
    const rawSeconds = mediaEntry?.durationSeconds ?? 0;
    const srcFile = path.join(sourcePath(jobId), filename);

    const silences = await detectSilences(srcFile, rawSeconds);
    const skipped = kind === "demo";

    let totalSilentSeconds: number;
    let projectedSeconds: number;
    let shrinkRatio: number;

    if (skipped) {
      // Demo: el silencio ES el contenido, no se proyecta ningún recorte.
      totalSilentSeconds = silences.reduce((sum, s) => sum + s.duration, 0);
      projectedSeconds = rawSeconds;
      shrinkRatio = 1;
    } else {
      totalSilentSeconds = silences.reduce((sum, s) => sum + trimmableSeconds(s), 0);
      projectedSeconds = Math.max(0, rawSeconds - totalSilentSeconds);
      // 0 silencios (o silencios sin nada recortable) → shrinkRatio 1.0: no
      // asumimos ningún porcentaje de ahorro, es lo que efectivamente se mide.
      shrinkRatio = rawSeconds > 0 ? projectedSeconds / rawSeconds : 1;
    }

    clips.push({
      filename,
      kind,
      skipped,
      silences,
      count: silences.length,
      totalSilentSeconds,
      rawSeconds,
      projectedSeconds,
      shrinkRatio,
    });
  }

  const silenceJson: SilenceJson = {
    generatedAt: new Date().toISOString(),
    clips,
  };

  await writeSilenceJson(jobId, silenceJson);
  return silenceJson;
}
