/**
 * plan-stage.ts — etapa 4 del pipeline: filtro editorial y estructura
 * autónoma vía agente Claude (agente que decide veredictos por clip, arma
 * la estructura del curso y escribe plan/{verdicts,structure,audit}.json +
 * plan/decisiones.md).
 *
 * STUB: la implementación real (SDK de Anthropic, tools, presupuesto de
 * frames, escritura de plan/) la agrega un issue posterior
 * (FLUJO-AGROMAX-9u6.3). Este archivo solo existe para que pipeline.ts
 * pueda importar y encadenar la etapa sin esperar a esa implementación.
 */

/**
 * Corre la etapa de plan para un job. Por ahora siempre lanza un error: la
 * lógica real (agente autónomo con tool-runner) todavía no está implementada.
 */
export async function runPlanStage(jobId: string): Promise<void> {
  throw new Error("pendiente: lo implementa otro issue");
}
