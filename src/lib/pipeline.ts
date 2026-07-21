/**
 * pipeline.ts — orquestador del pipeline completo de un job: probe →
 * transcripción → muestreo de frames. Pensado para correr en background (el
 * llamador NO debe hacer await de runPipeline en un request HTTP; es
 * fire-and-forget).
 *
 * Es idempotente: correrlo de nuevo sobre un job ya probado/transcrito/
 * muestreado simplemente vuelve a correr probe, transcribe y frames,
 * sobreescribiendo probe/media.json, transcripts/ y frames/.
 */
import { runFramesStage } from "./frames-stage";
import { readJobJson, updateJobStatus } from "./jobs";
import { runProbeStage } from "./probe-stage";
import { runTranscribeStage } from "./transcribe/index";
import type { JobStatus } from "./types";

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

    // Etapa 3.5: muestreo de frames de referencia.
    await updateJobStatus(jobId, "sampling", {
      stages: { frames: { startedAt: new Date().toISOString() } },
    });
    await runFramesStage(jobId);
    await updateJobStatus(jobId, "sampled", {
      stages: { frames: { finishedAt: new Date().toISOString() } },
    });
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Error desconocido en el pipeline";
    await updateJobStatus(jobId, "error", { errorMessage });
  }
}

/**
 * Estados a partir de los cuales tiene sentido (re)correr solo la etapa de
 * frames: el job ya tiene transcripts/ generado (o incluso ya pasó por la
 * etapa de muestreo antes, lo cual es válido para re-muestrear).
 */
const FRAMES_READY_STATUSES: JobStatus[] = [
  "transcribed",
  "sampling",
  "sampled",
];

/**
 * Corre solo la etapa de muestreo de frames para un job ya transcrito
 * (permite re-muestrear sin volver a correr probe/transcribe). Reutiliza el
 * mismo registro `running` que runPipeline para evitar corridas concurrentes
 * del mismo job, sea cual sea la etapa que las disparó.
 */
export function runFramesOnly(jobId: string): Promise<void> {
  const existing = running.get(jobId);
  if (existing) {
    return existing;
  }

  const promise = executeFramesOnly(jobId).finally(() => {
    running.delete(jobId);
  });

  running.set(jobId, promise);
  return promise;
}

/** Ejecuta únicamente la etapa de frames, validando el status previo del job. */
async function executeFramesOnly(jobId: string): Promise<void> {
  try {
    const current = await readJobJson(jobId);
    if (!FRAMES_READY_STATUSES.includes(current.status)) {
      throw new Error(
        `No se puede muestrear frames: el job "${jobId}" debe estar transcrito primero (status actual: "${current.status}")`
      );
    }

    await updateJobStatus(jobId, "sampling", {
      stages: { frames: { startedAt: new Date().toISOString() } },
    });
    await runFramesStage(jobId);
    await updateJobStatus(jobId, "sampled", {
      stages: { frames: { finishedAt: new Date().toISOString() } },
    });
  } catch (err) {
    const errorMessage =
      err instanceof Error
        ? err.message
        : "Error desconocido en el muestreo de frames";
    await updateJobStatus(jobId, "error", { errorMessage });
  }
}
