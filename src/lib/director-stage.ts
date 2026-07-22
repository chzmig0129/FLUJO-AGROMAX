/**
 * director-stage.ts — "director de edición": jefe del loop de corrección
 * automática que lee TODOS los veredictos de QA de un job (Gate 1, Gate 2
 * por clase, Gate 3 por módulo, auditoría de subtítulos) y decide/ejecuta
 * los fixes, vía el comando headless `/director-edicion` de Claude Code
 * (suscripción), usando el motor genérico de `plan/claude-code-engine.ts`.
 *
 * A diferencia de los jueces (Gate 1/2/3), el director no solo lee y
 * escribe un veredicto: EDITA archivos de `plan/` (captions, briefs de
 * overlay, cuts/structure) y re-dispara etapas del pipeline vía `curl` a
 * los endpoints locales de la propia app — por eso necesita herramientas
 * más amplias (`Bash(*)`, no solo `Bash(node:*)`/`Bash(ffmpeg:*)` como el
 * resto de las etapas), configurables vía CLAUDE_DIRECTOR_TOOLS.
 *
 * `runDirectorStage` es fire-and-forget desde la ruta HTTP: no verifica en
 * disco un contrato de salida único como las demás etapas (el director
 * puede terminar sin ningún fix si los gates ya estaban verdes), pero el
 * comando `.claude/commands/director-edicion.md` sí exige siempre escribir
 * `qa/director-reporte.md` — la verificación de ese archivo queda para
 * quien inspeccione el job después (UI/otra etapa), no bloquea esta
 * función.
 */
import { runCommandViaClaudeCode, resolveModelForRole } from "./plan/claude-code-engine";

/** Timeout máximo (en minutos) para la corrida completa del comando /director-edicion. */
function resolveDirectorTimeoutMin(): number {
  const minutes = Number(process.env.DIRECTOR_TIMEOUT_MIN ?? "120");
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 120;
}

/**
 * Herramientas permitidas para el CLI headless del director. A diferencia
 * del default acotado de `claude-code-engine.ts` (pensado para etapas de
 * solo lectura + un output puntual), el director necesita editar archivos
 * de plan libremente y correr `curl` contra los endpoints locales de la
 * app (y eventualmente scripts python) para re-disparar etapas — de ahí
 * `Bash(*)` en vez de patrones acotados por binario.
 *
 * Configurable vía CLAUDE_DIRECTOR_TOOLS (string separado por comas), ej.:
 *   CLAUDE_DIRECTOR_TOOLS="Read,Write,Edit,Bash(curl:*),Bash(node:*)"
 */
const DEFAULT_DIRECTOR_TOOLS = ["Read", "Write", "Edit", "Bash(*)"];

function resolveDirectorAllowedTools(): string[] {
  const raw = process.env.CLAUDE_DIRECTOR_TOOLS;
  if (!raw || !raw.trim()) return DEFAULT_DIRECTOR_TOOLS;
  const parsed = raw
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_DIRECTOR_TOOLS;
}

/**
 * Corre la etapa de director invocando `/director-edicion <jobId>` vía
 * `runCommandViaClaudeCode`, con el modelo resuelto para el rol `director`
 * (ver `resolveModelForRole`) y las herramientas amplias que necesita para
 * editar plan/ y re-disparar etapas del pipeline con `curl`.
 *
 * No verifica salidas en disco tras la corrida (a diferencia de
 * `runGate2Stage`/`runGate3Stage`/`runCaptionsAuditStage`): el trabajo del
 * director es correctivo, no siempre produce el mismo artefacto, y su
 * propio comando (`director-edicion.md`) ya exige escribir
 * `qa/director-reporte.md` como parte de su contrato interno.
 */
export async function runDirectorStage(jobId: string): Promise<void> {
  await runCommandViaClaudeCode({
    command: "director-edicion",
    args: jobId,
    model: resolveModelForRole("director"),
    timeoutMin: resolveDirectorTimeoutMin(),
    allowedTools: resolveDirectorAllowedTools(),
  });
}
