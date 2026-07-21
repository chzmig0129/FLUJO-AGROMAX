/**
 * assembly/verify.ts — verificación de que un render llegó a COMPLETO de
 * verdad, y el commit atómico del archivo final.
 *
 * EL FALLO SILENCIOSO CLÁSICO de esta etapa es dar por bueno un MP4 porque
 * "el archivo existe". Un proceso muerto a mitad de camino deja un archivo
 * que existe, pesa MB y hasta abre en algunos reproductores — pero le faltan
 * los últimos minutos de la clase. Por eso acá:
 *
 *   1. El backend NUNCA escribe en la ruta final. Escribe en <final>.tmp.mp4,
 *      en el mismo directorio (mismo filesystem ⇒ el rename es atómico).
 *   2. Sobre ese .tmp corre ffprobe como JUEZ INDEPENDIENTE del renderer:
 *      no se confía en el exit code del que escribió el archivo.
 *   3. La prueba dura es contar PAQUETES reales del stream de video
 *      (-count_packets): un MP4 truncado devuelve menos paquetes que los
 *      frames esperados aunque su header diga otra cosa. La duración del
 *      contenedor sola no alcanza.
 *   4. Recién si todo pasa: fs.rename(.tmp → final). Si algo falla, se borra
 *      el .tmp y no aparece nada en render/.
 *   5. El sidecar render/<lessonId>.json se escribe DESPUÉS del rename, y es
 *      la única marca de "completo" que lee el resto del sistema.
 *
 * Este módulo es compartido por todos los backends a propósito: la definición
 * de "render completo" no puede depender de quién lo produjo.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ffprobePath } from "../probe";
import { RENDER_FRAME_TOLERANCE } from "../constants";

const execFileAsync = promisify(execFile);

/** Lo que ffprobe reporta de un archivo ya escrito, normalizado. */
export interface ProbedRender {
  packetCount: number;
  durationSeconds: number;
  sizeBytes: number;
  width: number;
  height: number;
  fps: number;
  hasAudioStream: boolean;
}

/** Expectativas contra las que se juzga un archivo renderizado. */
export interface RenderExpectation {
  expectedFrames: number;
  width: number;
  height: number;
  fps: number;
  /**
   * Si true, se exige pista de audio en la salida. El ensamblaje de una
   * clase siempre debe tenerla (aunque algunos tramos sean mudos); un intro
   * mudo, no.
   */
  requireAudio: boolean;
}

/**
 * Ruta del archivo temporal asociado a una salida final.
 *
 * OJO CON LA EXTENSIÓN: el temporal termina en ".tmp.mp4", no en ".tmp". Un
 * intermedio sin contenedor claro rompe a las herramientas que deducen el
 * formato por la extensión: ffmpeg falla con "Unable to find a suitable
 * output format" (por eso proxy-stage.ts pasa "-f mp4" explícito) y Remotion
 * directamente se niega ("the output filename must end in mp4, mkv o mov").
 * Mantener el .mp4 al final deja el contenedor explícito para cualquier
 * backend.
 *
 * Que el nombre NO sea "<lessonId>.mp4" también es deliberado: la ruta que
 * sirve los renders resuelve el sidecar por basename, así que un temporal
 * jamás puede colarse como si fuera un render verificado.
 */
export function tempPathFor(finalPath: string): string {
  return `${finalPath}.tmp.mp4`;
}

/**
 * Corre ffprobe sobre un archivo contando paquetes de video reales. Es más
 * caro que leer solo el header — y esa es exactamente la idea: leer el
 * header es lo que no detecta un archivo truncado.
 */
export async function probeRender(file: string): Promise<ProbedRender> {
  const { stdout } = await execFileAsync(
    ffprobePath,
    [
      "-v",
      "error",
      "-count_packets",
      "-show_entries",
      "stream=codec_type,nb_read_packets,width,height,avg_frame_rate",
      "-show_entries",
      "format=duration,size",
      "-of",
      "json",
      file,
    ],
    // Contar paquetes de una clase larga produce poca salida pero puede
    // tardar; el buffer generoso evita un ENOBUFS espurio.
    { maxBuffer: 16 * 1024 * 1024 }
  );

  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      nb_read_packets?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
    }>;
    format?: { duration?: string; size?: string };
  };

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const hasAudioStream = streams.some((s) => s.codec_type === "audio");

  if (!video) {
    throw new Error("el archivo no tiene stream de video legible");
  }

  // avg_frame_rate viene como fracción ("30/1"); se normaliza a número.
  const [num, den] = (video.avg_frame_rate ?? "0/1").split("/");
  const fps = Number(den) === 0 ? 0 : Number(num) / Number(den);

  return {
    packetCount: Number(video.nb_read_packets ?? 0),
    durationSeconds: Number(parsed.format?.duration ?? 0),
    sizeBytes: Number(parsed.format?.size ?? 0),
    width: Number(video.width ?? 0),
    height: Number(video.height ?? 0),
    fps,
    hasAudioStream,
  };
}

/**
 * Juzga un archivo ya escrito contra las expectativas. Devuelve la lista de
 * fallas (vacía = archivo completo y correcto). No lanza: el llamador decide
 * qué hacer con las fallas (típicamente, borrar el .tmp y propagar).
 */
export function judgeRender(
  probed: ProbedRender,
  expectation: RenderExpectation
): string[] {
  const problems: string[] = [];

  if (probed.sizeBytes <= 0) {
    problems.push("el archivo está vacío");
  }
  if (probed.durationSeconds <= 0) {
    problems.push("el contenedor no reporta duración");
  }

  const frameDelta = Math.abs(probed.packetCount - expectation.expectedFrames);
  if (frameDelta > RENDER_FRAME_TOLERANCE) {
    problems.push(
      `frames incompletos: se esperaban ${expectation.expectedFrames} y el archivo tiene ${probed.packetCount} paquetes de video (probable render truncado)`
    );
  }

  if (
    probed.width !== expectation.width ||
    probed.height !== expectation.height
  ) {
    problems.push(
      `resolución inesperada: ${probed.width}x${probed.height} (se esperaba ${expectation.width}x${expectation.height})`
    );
  }

  // El fps se compara con tolerancia porque avg_frame_rate puede quedar en
  // 30000/1001 o similar según el muxer.
  if (Math.abs(probed.fps - expectation.fps) > 0.5) {
    problems.push(
      `fps inesperado: ${probed.fps.toFixed(3)} (se esperaba ${expectation.fps})`
    );
  }

  if (expectation.requireAudio && !probed.hasAudioStream) {
    problems.push("el render no tiene pista de audio");
  }

  return problems;
}

/**
 * Verifica el .tmp de una salida y, solo si pasa, lo promueve a su ruta
 * final con un rename atómico. Devuelve lo que ffprobe midió (para el
 * sidecar). Si falla, borra el .tmp y lanza con el detalle de las fallas.
 */
export async function verifyAndCommit(
  finalPath: string,
  expectation: RenderExpectation
): Promise<ProbedRender> {
  const tmp = tempPathFor(finalPath);

  let probed: ProbedRender;
  try {
    probed = await probeRender(tmp);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `El render de ${path.basename(finalPath)} no pasó la verificación: ${message}`
    );
  }

  const problems = judgeRender(probed, expectation);
  if (problems.length > 0) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw new Error(
      `El render de ${path.basename(finalPath)} no pasó la verificación: ${problems.join("; ")}`
    );
  }

  // Rename atómico: hasta esta línea, render/<lessonId>.mp4 no existe (o
  // sigue siendo el render viejo, válido). Nunca hay un archivo a medio
  // escribir ocupando la ruta final.
  await fs.rename(tmp, finalPath);
  return probed;
}
