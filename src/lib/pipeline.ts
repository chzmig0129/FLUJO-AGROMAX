/**
 * pipeline.ts — orquestador del pipeline completo de un job: probe →
 * transcripción. Pensado para correr en background (el llamador NO debe
 * hacer await de runPipeline en un request HTTP; es fire-and-forget).
 *
 * Es idempotente: correrlo de nuevo sobre un job ya probado/transcrito
 * simplemente vuelve a correr probe y transcribe, sobreescribiendo
 * probe/media.json y transcripts/.
 */
import { updateJobStatus } from "./jobs";
import { runProbeStage } from "./probe-stage";
import { runTranscribeStage } from "./transcribe/index";

/**
 * Registro en memoria de pipelines corriendo, para evitar disparar dos
 * corridas simultáneas del mismo job (por ejemplo si el usuario hace click
 * dos veces en "re-transcribir"). Vive solo mientras el proceso Node está
 * arriba: no persiste entre reinicios, lo cual está bien porque solo se usa
 * para deduplicar requests concurrentes.
 */
const running = new Map<string, Promise<void>>();

/** Indica si ya hay un pipeline corriendo en memoria para ese job. */
export function isPipelineRunning(jobId: string): boolean {
  return running.has(jobId);
}

/**
 * Corre el pipeline completo (probe + transcribe) para un job. Si ya hay
 * una corrida en curso para el mismo jobId, devuelve esa misma promesa en
 * vez de arrancar una nueva (deduplicación).
 */
export function runPipeline(jobId: string): Promise<void> {
  const existing = running.get(jobId);
  if (existing) {
    return existing;
  }

  const promise = executePipeline(jobId).finally(() => {
    // Limpiar el registro al terminar (éxito o error) para permitir
    // futuras corridas (por ejemplo re-transcribir).
    running.delete(jobId);
  });

  running.set(jobId, promise);
  return promise;
}

/** Ejecuta las etapas de probe y transcribe en secuencia, con manejo de error. */
async function executePipeline(jobId: string): Promise<void> {
  try {
    // Etapa 2: probe.
    await updateJobStatus(jobId, "probing", {
      stages: { probe: { startedAt: new Date().toISOString() } },
    });
    await runProbeStage(jobId);
    await updateJobStatus(jobId, "probed", {
      stages: { probe: { finishedAt: new Date().toISOString() } },
    });

    // Etapa 3: transcripción.
    await updateJobStatus(jobId, "transcribing", {
      stages: { transcribe: { startedAt: new Date().toISOString() } },
    });
    await runTranscribeStage(jobId);
    await updateJobStatus(jobId, "transcribed", {
      stages: { transcribe: { finishedAt: new Date().toISOString() } },
    });
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Error desconocido en el pipeline";
    await updateJobStatus(jobId, "error", { errorMessage });
  }
}
