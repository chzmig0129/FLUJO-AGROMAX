/**
 * claude-code-engine.ts — motor genérico que delega en comandos headless de
 * Claude Code (suscripción), en vez del agente vía SDK de agent.ts (que
 * exige ANTHROPIC_API_KEY). Ejecuta el CLI `claude` en modo no interactivo
 * (`-p`), esperando que la propia sesión de Claude Code lea el job, razone y
 * escriba los archivos de salida que el comando invocado describa.
 *
 * `runCommandViaClaudeCode` es la función genérica (spawn + timeout +
 * captura de stderr + taskkill en win32): la usa cualquier etapa que delegue
 * en un comando de `.claude/commands/*.md` recibiendo el jobId como
 * `$ARGUMENTS`. `runPlanViaClaudeCode` es el wrapper histórico de la etapa 4
 * (`/plan-etapa4`), que además verifica en disco que la corrida produjo
 * salidas reales, porque el CLI puede salir con código 0 sin haber
 * completado el trabajo (por ejemplo si se detuvo antes de escribir los
 * archivos).
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

/** Timeout máximo (en minutos) para la corrida completa del comando /plan-etapa4. */
function resolvePlanTimeoutMin(): number {
  const minutes = Number(process.env.PLAN_TIMEOUT_MIN ?? "45");
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 45;
}

/** Timeout por defecto (en minutos) cuando `runCommandViaClaudeCode` no recibe `timeoutMin` explícito. */
const DEFAULT_TIMEOUT_MIN = 45;

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
 * Mata el árbol de procesos del hijo al expirar el timeout.
 *
 * En Windows con `useShell: true` (caso `claude.cmd`), `spawn` lanza
 * `cmd.exe` como proceso directo, y `cmd.exe` a su vez lanza `claude.cmd`
 * -> `node claude` como nietos. Llamar `child.kill('SIGKILL')` en ese caso
 * solo mata a `cmd.exe`: en Windows eso NO derriba a los procesos
 * hijos/nietos (limitación conocida de Node — `spawn` con `shell:true` no
 * crea un grupo de procesos que `kill` pueda derribar completo), así que el
 * proceso real de `claude`/`node` (y cualquier `Bash(node:*)`/`Bash(ffmpeg:*)`
 * que haya lanzado) queda huérfano corriendo en background. Por eso en
 * Windows usamos `taskkill /PID <pid> /T /F`, que sí mata recursivamente
 * todo el árbol de descendientes del PID indicado.
 *
 * En macOS/Linux, `shell:false` hace que el hijo directo de `spawn` sea el
 * propio proceso `claude`, así que `SIGKILL` sobre ese PID basta.
 */
function killProcessTree(pid: number | undefined, useShell: boolean): void {
  if (!pid) return;
  if (process.platform === "win32" && useShell) {
    // /T mata el árbol completo (hijos y nietos), /F fuerza la terminación.
    spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      shell: false,
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // El proceso ya pudo haber terminado por su cuenta; no hay nada más
    // que hacer aquí.
  }
}

/** Opciones de `runCommandViaClaudeCode`. */
export interface RunCommandViaClaudeCodeOptions {
  /** Nombre del comando de `.claude/commands/<command>.md`, sin la barra inicial. */
  command: string;
  /** Argumentos que recibirá el comando como `$ARGUMENTS` (ej. el jobId). */
  args?: string;
  /** Timeout en minutos para la corrida completa. Por defecto `DEFAULT_TIMEOUT_MIN`. */
  timeoutMin?: number;
  /** Herramientas permitidas para el CLI headless. Por defecto `resolveAllowedTools()`. */
  allowedTools?: string[];
}

/**
 * Corre un comando headless de Claude Code invocando
 * `claude -p "/<command> <args>"`. cwd = raíz del repo (process.cwd()),
 * donde vive `.claude/commands/<command>.md`, para que el CLI lo resuelva.
 *
 * Mecánica genérica compartida por cualquier etapa que delegue en un
 * comando: mismo binario configurable (CLAUDE_BIN), mismas herramientas
 * permitidas por defecto, mismo manejo de timeout con `taskkill` en win32, y
 * misma captura de stderr. No verifica artefactos en disco — eso es
 * responsabilidad de quien llame (cada etapa conoce sus propias salidas
 * esperadas).
 */
export async function runCommandViaClaudeCode(
  opts: RunCommandViaClaudeCodeOptions,
): Promise<void> {
  const { command, args, timeoutMin, allowedTools } = opts;
  const claudeBin = resolveClaudeBin();
  // Windows: los shims .cmd/.bat que instala npm no son ejecutables PE
  // directos, así que spawn necesita shell:true para resolverlos vía cmd.exe.
  const useShell = claudeBin.toLowerCase().endsWith(".cmd") || claudeBin.toLowerCase().endsWith(".bat");
  const prompt = args ? `/${command} ${args}` : `/${command}`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      claudeBin,
      [
        "-p",
        prompt,
        "--allowedTools",
        ...(allowedTools ?? resolveAllowedTools()),
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

    const safeTimeoutMin =
      Number.isFinite(timeoutMin) && (timeoutMin as number) > 0 ? (timeoutMin as number) : DEFAULT_TIMEOUT_MIN;
    const timeoutMs = safeTimeoutMin * 60 * 1000;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(child.pid, useShell);
      reject(
        new Error(
          `El comando '/${command}' (claude-code) excedió el timeout de ${timeoutMs / 60000} min (args: '${args ?? ""}')`,
        ),
      );
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      console.error(`[${command}:claude-code] ${text.trimEnd()}`);
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(
        new Error(
          `Falló el comando '/${command}' (claude-code, args: '${args ?? ""}'): no se pudo iniciar '${claudeBin}' (${err.message})`,
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
            `Falló el comando '/${command}' (claude-code, args: '${args ?? ""}') (código ${code}): ${tail || "sin stderr"}`,
          ),
        );
        return;
      }

      void stdout; // el JSON de resumen del CLI no se usa: la verificación real es en disco.
      resolve();
    });
  });
}

/**
 * Corre la etapa de plan invocando `/plan-etapa4 <jobId>` vía
 * `runCommandViaClaudeCode`, y luego verifica en disco que la corrida
 * produjo salidas reales (ver `verifyPlanOutputs`). Sin cambios de
 * comportamiento respecto a la versión previa a la generalización del motor.
 */
export async function runPlanViaClaudeCode(jobId: string): Promise<void> {
  await runCommandViaClaudeCode({
    command: "plan-etapa4",
    args: jobId,
    timeoutMin: resolvePlanTimeoutMin(),
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
