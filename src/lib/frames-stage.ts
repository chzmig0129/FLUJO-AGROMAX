/**
 * frames-stage.ts — etapa de muestreo de frames de referencia con ffmpeg
 * (etapa 3.5 del pipeline).
 *
 * STUB: la implementación real (lectura de media.json/summary.json, cálculo
 * de timestamps según narración, extracción con ffmpeg y escritura del
 * manifest) queda pendiente para otro issue (FLUJO-AGROMAX-vd5.2). Este stub
 * solo existe para que pipeline.ts compile mientras tanto.
 */
import type { FramesManifest } from "./types";

/**
 * Corre la etapa de muestreo de frames para un job. Pendiente de
 * implementación: por ahora siempre lanza un error.
 */
export async function runFramesStage(
  jobId: string
): Promise<FramesManifest> {
  void jobId;
  throw new Error("pendiente: lo implementa otro issue");
}
