/**
 * run-lock.ts — candado en memoria por (jobId, stage) para evitar disparar
 * dos corridas concurrentes de la MISMA etapa de agente sobre el MISMO job
 * (por ejemplo, doble click en "Generar briefs" mientras la primera corrida
 * de `claude` todavía está en curso).
 *
 * Mismo patrón que el registro `running` de `pipeline.ts`
 * (`isPipelineRunning`/`runPipeline`), pero a nivel de etapa individual en
 * vez de "el pipeline completo del job": ese registro cubre probe/transcribe/
 * frames/plan/prep/assemble (etapas deterministas encadenadas), mientras que
 * este cubre las etapas de agente/QA que se disparan de forma independiente
 * (briefs, generación de overlays, gates, director, empaquetado, auditoría
 * de captions) y que antes no tenían ningún guard: nada impedía lanzar N
 * procesos `claude` concurrentes sobre el mismo job y la misma etapa.
 *
 * Limitación conocida y aceptada: el candado vive solo en memoria del
 * proceso Node de `next`. Si el proceso se reinicia mientras una etapa está
 * "corriendo" según este registro, el candado se pierde (todas las etapas
 * quedan libres de nuevo). Esto es aceptable porque:
 *   - El propósito es deduplicar clicks/requests concurrentes dentro de la
 *     misma vida del proceso, no persistir estado de progreso real (eso ya
 *     vive en disco vía job.json / *.progress.json).
 *   - Un reinicio del server ya interrumpe cualquier proceso hijo en curso
 *     de todos modos, así que no queda una corrida real "huérfana" que el
 *     candado debiera seguir bloqueando.
 */

/** Claves `stage` en vuelo por jobId (`Set<stage>` por job). */
const runningStagesByJob = new Map<string, Set<string>>();

/**
 * Intenta adquirir el candado de `stage` para `jobId`. Devuelve `true` si lo
 * consiguió (no había otra corrida en vuelo para esa etapa de ese job) o
 * `false` si ya estaba tomado (el llamador debe responder 409 y NO disparar
 * la etapa).
 */
export function tryAcquire(jobId: string, stage: string): boolean {
  let stages = runningStagesByJob.get(jobId);
  if (!stages) {
    stages = new Set();
    runningStagesByJob.set(jobId, stages);
  }
  if (stages.has(stage)) {
    return false;
  }
  stages.add(stage);
  return true;
}

/**
 * Libera el candado de `stage` para `jobId`. Debe llamarse SIEMPRE en un
 * `finally` (éxito o error de la etapa) para no dejar el job bloqueado para
 * siempre tras un fallo.
 */
export function release(jobId: string, stage: string): void {
  const stages = runningStagesByJob.get(jobId);
  if (!stages) return;
  stages.delete(stage);
  if (stages.size === 0) {
    runningStagesByJob.delete(jobId);
  }
}

/** Lista las etapas actualmente en vuelo (según este registro) para `jobId`. */
export function runningStages(jobId: string): string[] {
  const stages = runningStagesByJob.get(jobId);
  return stages ? Array.from(stages) : [];
}
