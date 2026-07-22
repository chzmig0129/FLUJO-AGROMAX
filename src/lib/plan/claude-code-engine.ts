/**
 * claude-code-engine.ts — motor de la etapa 4 que delega en el comando
 * headless `/plan-etapa4` de Claude Code (suscripción), en vez del agente
 * vía SDK de agent.ts (que exige ANTHROPIC_API_KEY). Ejecuta el CLI `claude`
 * en modo no interactivo (`-p`), esperando que la propia sesión de Claude
 * Code lea el job, razone y escriba los 4 archivos de `plan/` descritos en
 * .claude/commands/plan-etapa4.md.
 *
 * El CLI puede salir con código 0 sin haber completado el trabajo real (por
 * ejemplo si se detuvo antes de escribir los archivos), así que además de
 * revisar el exit code verificamos en disco que `plan/structure.json` y
 * `plan/audit.json` existen y que structure.json trae al menos un módulo.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { jobPath } from "../jobs";
import type { StructureJson } from "../types";

/**
 * Binario del CLI de Claude Code. Configurable vía CLAUDE_BIN porque en
 * Windows el binario instalado por npm suele ser un shim `claude.cmd`, que
 * `spawn` no puede ejecutar directamente con `shell: false` (limitación de
 * Node en Windows con archivos .cmd/.bat) — en ese caso forzamos shell:true.
 */
function resolveClaudeBin(): string {
  return process.env.CLAUDE_BIN ?? "claude";
}

/** Timeout máximo (en minutos) para la corrida completa del comando. */
function resolveTimeoutMs(): number {
  const minutes = Number(process.env.PLAN_TIMEOUT_MIN ?? "45");
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 45;
  return safeMinutes * 60 * 1000;
}

/**
 * Lista de herramientas permitidas para el CLI headless. Deliberadamente NO
 * usamos `--dangerously-skip-permissions` (acceso total, sin gate alguno):
 * el comando /plan-etapa4 solo necesita leer el job, escribir los archivos
 * de plan/ y correr `node -e` (que usa ffmpeg-static) para extraer frames.
 * Acotar las herramientas limita el radio de daño si el modelo se desvía
 * del prompt del comando.
 *
 * Sintaxis de `--allowedTools` del CLI de Claude Code: se repite el flag o
 * se listan varios valores separados por espacio como argumentos propios,
 * cada uno un nombre de herramienta o un patrón `Tool(regla:*)` para acotar
 * subcomandos (ej. `Bash(node:*)` permite `node ...` pero no otros
 * binarios). Ver `claude --help` / docs de "Permissions" del CLI.
 *
 * Configurable vía CLAUDE_PLAN_TOOLS (string separado por comas) para poder
 * ampliar la lista sin recompilar, ej.:
 *   CLAUDE_PLAN_TOOLS="Read,Write,Edit,Bash(node:*),Bash(ffmpeg:*),Bash(ls:*)"
 */
const DEFAULT_ALLOWED_TOOLS = ["Read", "Write", "Edit", "Bash(node:*)", "Bash(ffmpeg:*)"];

function resolveAllowedTools(): string[] {
  const raw = process.env.CLAUDE_PLAN_TOOLS;
  if (!raw || !raw.trim()) return DEFAULT_ALLOWED_TOOLS;
  const parsed = raw
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_TOOLS;
}

/**
 * Corre la etapa de plan invocando `claude -p "/plan-etapa4 <jobId>"` de
 * forma headless. cwd = raíz del repo (process.cwd()), donde vive
 * .claude/commands/plan-etapa4.md, para que el CLI resuelva el comando.
 */
export async function runPlanViaClaudeCode(jobId: string): Promise<void> {
  const claudeBin = resolveClaudeBin();
  // Windows: los shims .cmd/.bat que instala npm no son ejecutables PE
  // directos, así que spawn necesita shell:true para resolverlos vía cmd.exe.
  const useShell = claudeBin.toLowerCase().endsWith(".cmd") || claudeBin.toLowerCase().endsWith(".bat");

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      claudeBin,
      [
        "-p",
        `/plan-etapa4 ${jobId}`,
        "--allowedTools",
        ...resolveAllowedTools(),
        "--output-format",
        "json",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        shell: useShell,
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeoutMs = resolveTimeoutMs();
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `Etapa de plan (claude-code) excedió el timeout de ${timeoutMs / 60000} min para el job '${jobId}'`,
        ),
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      console.error(`[plan:claude-code] ${text.trimEnd()}`);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `Falló la etapa de plan (claude-code) para '${jobId}': no se pudo iniciar '${claudeBin}' (${err.message})`,
        ),
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        const tail = stderr.trim().slice(-2000);
        reject(
          new Error(
            `Falló la etapa de plan (claude-code) para '${jobId}' (código ${code}): ${tail || "sin stderr"}`,
          ),
        );
        return;
      }

      void stdout; // el JSON de resumen del CLI no se usa: la verificación real es en disco.
      resolve();
    });
  });

  await verifyPlanOutputs(jobId);
}

/**
 * Verifica que la corrida haya producido salidas reales, porque el CLI
 * puede terminar con exit code 0 sin haber escrito nada (ej. si se detuvo
 * pidiendo confirmación o abortó a mitad de camino).
 */
async function verifyPlanOutputs(jobId: string): Promise<void> {
  const structurePath = path.join(jobPath(jobId), "plan", "structure.json");
  const auditPath = path.join(jobPath(jobId), "plan", "audit.json");

  const [structureExists, auditExists] = await Promise.all([
    fileExists(structurePath),
    fileExists(auditPath),
  ]);

  if (!structureExists || !auditExists) {
    const missing = [
      !structureExists ? "plan/structure.json" : null,
      !auditExists ? "plan/audit.json" : null,
    ]
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `La etapa de plan (claude-code) terminó sin generar ${missing} para el job '${jobId}'. El comando /plan-etapa4 no completó su trabajo.`,
    );
  }

  let structure: StructureJson;
  try {
    const raw = await fs.readFile(structurePath, "utf-8");
    structure = JSON.parse(raw) as StructureJson;
  } catch (err) {
    throw new Error(
      `La etapa de plan (claude-code) generó plan/structure.json inválido para el job '${jobId}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!Array.isArray(structure.modules) || structure.modules.length === 0) {
    throw new Error(
      `La etapa de plan (claude-code) generó plan/structure.json sin módulos para el job '${jobId}' — el comando /plan-etapa4 no completó su trabajo.`,
    );
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
