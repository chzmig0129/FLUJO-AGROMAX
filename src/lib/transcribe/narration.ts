/**
 * Detección de narración anti-alucinación.
 *
 * Whisper (mlx-whisper, faster-whisper) tiende a "alucinar" texto sobre
 * silencio o ruido de fondo: frases genéricas como "Gracias por ver el
 * video" o "Subtítulos realizados por la comunidad de Amara.org" aparecen
 * incluso cuando el clip no tiene voz real. Esto es especialmente común en
 * clips B-roll cortos y mudos (tomas de producto, paisajes, etc.) que no
 * deberían clasificarse como "narrados".
 *
 * La heurística combina dos señales:
 * 1. La forma del transcript: un único segmento corto (poca duración o poco
 *    texto) es sospechoso de ser una alucinación aislada más que narración
 *    real.
 * 2. El nivel de energía del audio (RMS en dB, medido con ffmpeg): si el
 *    clip está prácticamente en silencio, un transcript sospechoso confirma
 *    que probablemente es alucinado.
 *
 * Solo cuando AMBAS señales apuntan a "sospechoso" se descarta la narración.
 * Así evitamos falsos negativos en clips cortos pero con voz real y audible.
 */

import { spawn } from "node:child_process";
// ffmpeg-static exporta la ruta al binario de ffmpeg empaquetado, sin
// depender de que el sistema tenga ffmpeg instalado globalmente.
import ffmpegPath from "ffmpeg-static";
import type { TranscriptResult } from "./types";

/** Valor de piso cuando ffmpeg reporta '-inf' dB (silencio digital total). */
const SILENCE_FLOOR_DB = -120;

/** Duración mínima (segundos) para que un único segmento se considere "normal". */
const MIN_SEGMENT_DURATION_SECONDS = 15;

/** Longitud mínima de texto para que un único segmento se considere "normal". */
const MIN_SEGMENT_TEXT_LENGTH = 80;

/** Umbral de RMS (dB) por debajo del cual el audio se considera casi silencio. */
const SILENCE_RMS_THRESHOLD_DB = -45;

/** Expresión regular para extraer 'RMS level dB: <valor>' del stderr de ffmpeg. */
const RMS_LINE_REGEX = /RMS level dB:\s*(-?inf|-?\d+(?:\.\d+)?)/i;

/**
 * Mide la energía global de audio (RMS en dB) de un video usando el filtro
 * `astats` de ffmpeg. Devuelve `null` si el video no tiene pista de audio,
 * si ffmpeg falla, o si no se logra parsear el valor.
 */
export function measureAudioEnergy(videoPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    if (!ffmpegPath) {
      resolve(null);
      return;
    }

    const child = spawn(ffmpegPath, [
      "-i",
      videoPath,
      "-af",
      "astats=measure_overall=RMS_level:measure_perchannel=none",
      "-f",
      "null",
      "-",
    ]);

    let stderr = "";
    let settled = false;

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", () => {
      if (settled) return;
      settled = true;
      resolve(null);
    });

    child.on("close", () => {
      if (settled) return;
      settled = true;

      const match = RMS_LINE_REGEX.exec(stderr);
      if (!match) {
        // No hay pista de audio o ffmpeg no imprimió el estadístico esperado.
        resolve(null);
        return;
      }

      const raw = match[1].toLowerCase();
      if (raw === "-inf" || raw === "inf") {
        // Silencio digital absoluto: lo tratamos como un piso muy bajo en
        // vez de -Infinity para poder compararlo numéricamente sin sorpresas.
        resolve(SILENCE_FLOOR_DB);
        return;
      }

      const value = Number(raw);
      resolve(Number.isFinite(value) ? value : null);
    });
  });
}

/**
 * Decide si un TranscriptResult representa narración real (voz humana con
 * contenido) o si probablemente es una alucinación de Whisper sobre un
 * clip silencioso/casi silencioso.
 *
 * Reglas:
 * - Sin segmentos → no hay narración.
 * - Un único segmento "sospechoso" (corto en duración o en texto) combinado
 *   con audio silencioso o desconocido → se descarta como alucinación.
 * - En cualquier otro caso (varios segmentos, o un segmento largo/con
 *   suficiente texto, o audio claramente audible) se considera narración.
 */
export function detectNarration(
  result: TranscriptResult,
  rmsDb: number | null,
): boolean {
  const segments = result.segments ?? [];

  if (segments.length === 0) {
    return false;
  }

  if (segments.length === 1) {
    const segment = segments[0];
    const duration = segment.end - segment.start;
    const isSuspiciousSegment =
      duration < MIN_SEGMENT_DURATION_SECONDS ||
      segment.text.trim().length < MIN_SEGMENT_TEXT_LENGTH;

    const isSilentOrUnknownAudio =
      rmsDb === null || rmsDb < SILENCE_RMS_THRESHOLD_DB;

    if (isSuspiciousSegment && isSilentOrUnknownAudio) {
      return false;
    }
  }

  return true;
}
