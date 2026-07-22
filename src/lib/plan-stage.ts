/**
 * plan-stage.ts — etapa 4 del pipeline: filtro editorial y estructura
 * autónoma vía agente Claude (agente que decide veredictos por clip, arma
 * la estructura del curso y escribe plan/{verdicts,structure,audit}.json +
 * plan/decisiones.md).
 *
 * Dos motores posibles, elegidos con la variable de entorno PLAN_ENGINE:
 * - 'api' (default): agente vía SDK de Anthropic (runPlanAgent en
 *   ./plan/agent). Requiere ANTHROPIC_API_KEY configurada (el SDK la
 *   resuelve del entorno; Next.js carga .env.local automáticamente al
 *   process.env del server). Si falta, se lanza un error claro en vez de
 *   dejar que el SDK falle con un mensaje críptico de autenticación.
 * - 'claude-code': delega en el comando headless /plan-etapa4 corrido por
 *   el CLI de Claude Code (suscripción, sin tokens de API). No exige
 *   ANTHROPIC_API_KEY. Ver ./plan/claude-code-engine.ts.
 *
 * Nota Windows: el motor 'claude-code' hace spawn del binario `claude`
 * (configurable vía CLAUDE_BIN); en Windows ese binario puede ser un shim
 * `claude.cmd`, que spawn con shell:false no puede ejecutar directamente
 * (limitación de Node) — claude-code-engine.ts detecta la extensión .cmd/
 * .bat y usa shell:true en ese caso.
 */
import { runPlanAgent } from "./plan/agent";
import { runPlanViaClaudeCode } from "./plan/claude-code-engine";

type PlanEngine = "api" | "claude-code";

function resolvePlanEngine(): PlanEngine {
  const raw = process.env.PLAN_ENGINE ?? "api";
  if (raw === "api" || raw === "claude-code") {
    return raw;
  }
  throw new Error(
    `PLAN_ENGINE='${raw}' no es válido. Usa 'api' (default) o 'claude-code'.`,
  );
}

/**
 * Corre la etapa de plan para un job, delegando en el motor configurado por
 * PLAN_ENGINE ('api' por default, o 'claude-code').
 */
export async function runPlanStage(jobId: string): Promise<void> {
  const engine = resolvePlanEngine();

  if (engine === "claude-code") {
    await runPlanViaClaudeCode(jobId);
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "Configura ANTHROPIC_API_KEY en .env.local para la etapa de plan (agente), o usa PLAN_ENGINE=claude-code"
    );
  }
  await runPlanAgent(jobId);
}
