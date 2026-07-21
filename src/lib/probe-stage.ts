/**
 * probe-stage.ts — etapa 2 del pipeline: corre ffprobe sobre cada archivo de
 * jobs/<id>/source/ y escribe jobs/<id>/probe/media.json con la metadata
 * técnica necesaria para etapas futuras (edición/transcode).
 *
 * INVARIANTE: nunca muta jobs/<id>/source/ — solo se lee (ver invariante
 * documentada en jobs.ts). Esta etapa es idempotente: re-correrla vuelve a
 * leer source/ y sobreescribe probe/media.json por completo.
 */
import path from "node:path";
import fs from "node:fs/promises";
import type { MediaInfo } from "./types";
import { probeRaw } from "./probe";
import { sourcePath, writeMediaJson } from "./jobs";

/**
 * Parsea un r_frame_rate de ffprobe tipo "30000/1001" o "25/1" a un número
 * con 2 decimales. Devuelve 0 si el formato es inválido o el denominador es 0.
 */
function parseFrameRate(rFrameRate: string | undefined): number {
  if (!rFrameRate) return 0;
  const [numStr, denStr] = rFrameRate.split("/");
  const num = Number(numStr);
  const den = Number(denStr ?? "1");
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return Math.round((num / den) * 100) / 100;
}

/**
 * Corre ffprobe (vía probeRaw) sobre todos los archivos de jobs/<id>/source/,
 * ordenados por nombre (localeCompare), construye un MediaInfo por archivo y
 * persiste el arreglo completo en probe/media.json.
 */
export async function runProbeStage(jobId: string): Promise<MediaInfo[]> {
  const dir = sourcePath(jobId);
  const entries = await fs.readdir(dir);
  const sorted = [...entries].sort((a, b) => a.localeCompare(b));

  const results: MediaInfo[] = [];
  for (const filename of sorted) {
    // Secuencial: evita saturar recursos al invocar ffprobe repetidamente.
    const filePath = path.join(dir, filename);
    const raw = await probeRaw(filePath);

    const streams: any[] = Array.isArray(raw?.streams) ? raw.streams : [];
    const videoStream = streams.find((s) => s?.codec_type === "video");
    const audioStream = streams.find((s) => s?.codec_type === "audio");

    const width = videoStream?.width ?? 0;
    const height = videoStream?.height ?? 0;
    const fps = videoStream ? parseFrameRate(videoStream.r_frame_rate) : 0;
    const videoCodec = videoStream?.codec_name ?? "";
    const durationSeconds = parseFloat(raw?.format?.duration ?? "") || 0;
    const audioChannels = audioStream?.channels ?? 0;
    const audioSampleRate = audioStream
      ? Number(audioStream.sample_rate) || 0
      : 0;

    // needsTranscode: cubre tanto horizontales como verticales usando el
    // lado mayor/menor (no width/height fijos), ya que un vertical de
    // 1080x1920 no debe marcarse por su "width" chico. Hoy solo se registra
    // el dato: la decisión de transcodificar la toma una etapa futura.
    const longSide = Math.max(width, height);
    const shortSide = Math.min(width, height);
    const needsTranscode = longSide > 1920 || shortSide > 1080 || fps > 30;

    results.push({
      filename,
      width,
      height,
      fps,
      videoCodec,
      durationSeconds,
      audioChannels,
      audioSampleRate,
      needsTranscode,
    });
  }

  await writeMediaJson(jobId, results);
  return results;
}
