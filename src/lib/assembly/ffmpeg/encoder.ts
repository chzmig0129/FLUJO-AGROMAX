/**
 * assembly/ffmpeg/encoder.ts — detección (barata y cacheada) de qué encoder
 * h264 usar para el backend "ffmpeg".
 *
 * ORDEN DE PREFERENCIA:
 *   1. h264_nvenc         — GPU NVIDIA (la PC Windows de producción con RTX
 *                           2060 trae el ffmpeg "gyan full build" con esto).
 *   2. h264_videotoolbox   — GPU/media engine de Apple Silicon/Intel (Mac de
 *                           desarrollo), solo se prueba en darwin.
 *   3. libx264             — software, siempre presente en cualquier build de
 *                           ffmpeg con libx264 compilado (el default de
 *                           ffmpeg-static). Red de seguridad universal.
 *
 * POR QUÉ NO ALCANZA CON LEER `ffmpeg -encoders`: esa lista describe qué el
 * binario SABE construir, no si el hardware/driver detrás realmente
 * responde. Un ffmpeg con h264_nvenc compilado en una máquina sin GPU NVIDIA
 * (o con drivers viejos) lista el encoder igual y falla recién al primer
 * frame. Por eso acá se corre un encode real de 1 frame contra una fuente
 * sintética `lavfi` y se juzga por el exit code: si el proceso no truena, el
 * encoder sirve de verdad.
 *
 * CACHE: la detección se corre UNA sola vez por proceso (Promise memoizada a
 * nivel de módulo) — el hardware no cambia entre llamadas, y probar un
 * encode real cuesta un par de cientos de ms que no vale la pena repetir por
 * cada clase de un job con decenas de lecciones.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveFfmpegBin } from "../../ffmpeg";

const execFileAsync = promisify(execFile);

export type FfmpegEncoderName = "h264_nvenc" | "h264_videotoolbox" | "libx264";

/**
 * Argumentos por encoder para producir la salida final (calidad/velocidad).
 * Se centraliza acá porque cada encoder de hardware tiene sus propias flags
 * de control de calidad (nvenc: `-rc`/`-cq`, videotoolbox: `-q:v`, libx264:
 * `-crf`/`-preset`) y el backend no debería tener que conocerlas.
 */
export function encoderOutputArgs(encoder: FfmpegEncoderName): string[] {
  switch (encoder) {
    case "h264_nvenc":
      return ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-cq", "20", "-b:v", "0"];
    case "h264_videotoolbox":
      return ["-c:v", "h264_videotoolbox", "-q:v", "65"];
    case "libx264":
    default:
      return ["-c:v", "libx264", "-preset", "medium", "-crf", "20"];
  }
}

/**
 * Corre un encode de 1 frame sintético (lavfi `color`) contra `/dev/null`
 * equivalente (`-f null -`, que ffmpeg entiende en cualquier plataforma sin
 * necesitar una ruta real) usando el encoder dado. `true` si el proceso
 * termina con exit code 0, `false` ante cualquier error (encoder ausente,
 * sin GPU compatible, driver caído, etc.) — nunca lanza.
 */
async function encoderWorks(ffmpegBin: string, encoder: FfmpegEncoderName): Promise<boolean> {
  try {
    await execFileAsync(
      ffmpegBin,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=64x64:r=30",
        "-frames:v",
        "1",
        "-c:v",
        encoder,
        "-f",
        "null",
        "-",
      ],
      { timeout: 15_000 }
    );
    return true;
  } catch {
    return false;
  }
}

let cachedDetection: Promise<FfmpegEncoderName> | null = null;

/**
 * Devuelve el encoder h264 a usar, detectado y cacheado para el proceso
 * actual. Reintenta la detección real (no de lista) en el orden de
 * preferencia documentado arriba.
 */
export function detectEncoder(): Promise<FfmpegEncoderName> {
  if (cachedDetection) return cachedDetection;

  cachedDetection = (async () => {
    const ffmpegBin = resolveFfmpegBin();

    if (await encoderWorks(ffmpegBin, "h264_nvenc")) {
      return "h264_nvenc";
    }

    if (process.platform === "darwin" && (await encoderWorks(ffmpegBin, "h264_videotoolbox"))) {
      return "h264_videotoolbox";
    }

    return "libx264";
  })();

  return cachedDetection;
}

/** Solo para tests/diagnóstico: descarta la detección cacheada. */
export function resetEncoderCache(): void {
  cachedDetection = null;
}

/** Chequeo barato: ¿el binario de ffmpeg resuelto siquiera arranca? */
export async function ffmpegBinaryAvailable(): Promise<{ ok: boolean; reason?: string }> {
  let ffmpegBin: string;
  try {
    ffmpegBin = resolveFfmpegBin();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: message };
  }

  try {
    await execFileAsync(ffmpegBin, ["-version"], { timeout: 10_000 });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `No se pudo ejecutar el binario de ffmpeg resuelto ("${ffmpegBin}"): ${message}`,
    };
  }
}
