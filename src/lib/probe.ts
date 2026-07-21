/**
 * Análisis de metadata de video con ffprobe (via ffprobe-static).
 * Server-only: usa child_process para invocar el binario de ffprobe.
 * Nunca lanza excepción por un archivo inválido: siempre devuelve VideoFileMeta
 * con los issues correspondientes.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import type { VideoFileMeta, VideoIssue } from "./types";

const execFileAsync = promisify(execFile);

// El export de ffprobe-static varía según versión: puede ser un string (la
// ruta directa al binario) o un objeto { path }. Resolvemos ambos casos.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffprobeStatic = require("ffprobe-static") as { path?: string } | string;
const ffprobePath: string =
  typeof ffprobeStatic === "string" ? ffprobeStatic : ffprobeStatic.path ?? "ffprobe";

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
}

interface FfprobeFormat {
  duration?: string;
}

interface FfprobeOutput {
  format?: FfprobeFormat;
  streams?: FfprobeStream[];
}

/**
 * Analiza un único archivo de video con ffprobe y devuelve su metadata,
 * acumulando issues detectados. Nunca lanza: cualquier fallo se traduce en
 * issues sobre el VideoFileMeta retornado.
 */
export async function probeVideo(filePath: string): Promise<VideoFileMeta> {
  const filename = path.basename(filePath);

  let output: FfprobeOutput | null = null;
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ]);
    output = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    // ffprobe falló (archivo corrupto, no es un video, binario no lo pudo leer, etc.)
    output = null;
  }

  const videoStream = output?.streams?.find((s) => s.codec_type === "video");

  if (!output || !videoStream) {
    // No hay stream de video: el archivo no es un video válido.
    // No acumulamos zero_duration/no_audio encima de este caso.
    return {
      filename,
      durationSeconds: 0,
      hasAudio: false,
      width: 0,
      height: 0,
      issues: ["not_a_video"],
    };
  }

  const hasAudio = Boolean(output.streams?.some((s) => s.codec_type === "audio"));
  const durationSeconds = parseFloat(output.format?.duration ?? "") || 0;
  const width = videoStream.width ?? 0;
  const height = videoStream.height ?? 0;

  const issues: VideoIssue[] = [];
  if (durationSeconds <= 0) {
    issues.push("zero_duration");
  }
  if (!hasAudio) {
    issues.push("no_audio");
  }

  return {
    filename,
    durationSeconds,
    hasAudio,
    width,
    height,
    issues,
  };
}

/**
 * Corre probeVideo secuencialmente sobre todos los archivos de un directorio,
 * ordenados por nombre (orden alfabético estable vía localeCompare).
 */
export async function probeAll(dir: string): Promise<VideoFileMeta[]> {
  const entries = await fs.readdir(dir);
  const sorted = [...entries].sort((a, b) => a.localeCompare(b));

  const results: VideoFileMeta[] = [];
  for (const entry of sorted) {
    // Secuencial: evita saturar recursos al invocar ffprobe repetidamente.
    const meta = await probeVideo(path.join(dir, entry));
    results.push(meta);
  }
  return results;
}
