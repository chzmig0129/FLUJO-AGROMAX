/**
 * plan-stage.ts — etapa 4 del pipeline: filtro editorial y estructura
 * autónoma vía agente Claude (agente que decide veredictos por clip, arma
 * la estructura del curso y escribe plan/{verdicts,structure,audit}.json +
 * plan/decisiones.md).
 *
 * Esta etapa requiere ANTHROPIC_API_KEY configurada (el SDK de Anthropic la
 * resuelve del entorno; Next.js carga .env.local automáticamente al
 * process.env del server). Si falta, se lanza un error claro en vez de
 * dejar que el SDK falle con un mensaje críptico de autenticación.
 */
import { runPlanAgent } from "./plan/agent";

/**
 * Corre la etapa de plan para un job: valida que haya API key configurada y
 * delega en el agente autónomo (runPlanAgent).
 */
export async function runPlanStage(jobId: string): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Configura ANTHROPIC_API_KEY en .env.local para la etapa de plan (agente)"
    );
  }
  await runPlanAgent(jobId);
}
