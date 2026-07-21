/**
 * probe-stage.ts — STUB temporal. La implementación real (correr ffprobe
 * sobre jobs/<id>/source/ y escribir probe/media.json) llega en otro issue
 * (FLUJO-AGROMAX-nvw.3). Este archivo solo existe para que pipeline.ts
 * compile mientras tanto.
 */
import type { MediaInfo } from "./types";

export async function runProbeStage(_jobId: string): Promise<MediaInfo[]> {
  throw new Error("pendiente: lo implementa otro issue");
}
