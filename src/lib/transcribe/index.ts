/**
 * transcribe/index.ts — STUB temporal. La implementación real (correr el
 * motor de transcripción intercambiable sobre jobs/<id>/source/ y escribir
 * transcripts/) llega en otros issues (FLUJO-AGROMAX-nvw.4 y siguientes).
 * Este archivo solo existe para que pipeline.ts compile mientras tanto.
 */

export async function runTranscribeStage(
  _jobId: string,
  _onFileUpdate?: (filename: string, status: string) => void
): Promise<void> {
  throw new Error("pendiente: lo implementa otro issue");
}
