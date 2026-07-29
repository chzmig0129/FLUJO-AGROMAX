/**
 * Fábrica genérica de motores de transcripción respaldados por un script
 * Python persistente (modo `--serve`). Cada script (transcribe_mlx.py,
 * transcribe_faster.py, ...) carga su modelo UNA sola vez y luego atiende,
 * secuencialmente, requests JSONL por stdin ({videoPath, language}, uno por
 * línea), respondiendo UNA línea JSON por request con el contrato
 * normalizado: {language, duration, segments} o {error} si esa transcripción
 * puntual falló. Node no interpreta formatos nativos de Whisper: solo confía
 * en ese contrato de salida.
 *
 * El proceso --serve se lanza de forma perezosa (lazy) al primer clip de la
 * corrida y se reutiliza para todos los clips subsiguientes, evitando
 * recargar el modelo por cada archivo. Si el proceso muere a mitad de una
 * corrida, se relanza y se reintenta el clip en curso una única vez.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import type { TranscribeEngine, TranscriptResult } from "./types";

/** Ruta al intérprete Python del entorno virtual dedicado a transcripción. */
function resolvePythonBin(): string {
  return (
    process.env.PYTHON_BIN ??
    path.join(process.cwd(), ".venv-whisper", "bin", "python")
  );
}

/** Timeout máximo (en minutos) para una transcripción individual. */
function resolveTimeoutMs(): number {
  const minutes = Number(process.env.TRANSCRIBE_TIMEOUT_MIN ?? "60");
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 60;
  return safeMinutes * 60 * 1000;
}

/**
 * Tiempo de inactividad (ms) tras el cual el proceso --serve se apaga solo
 * si no llegan más requests. El engine no recibe una señal explícita de
 * "fin de etapa" (la etapa llamadora solo invoca transcribe() por clip), así
 * que usamos inactividad como proxy razonable para no dejar el proceso -y el
 * modelo cargado en RAM/GPU- vivo indefinidamente tras terminar una corrida.
 */
function resolveIdleTimeoutMs(): number {
  const ms = Number(process.env.TRANSCRIBE_IDLE_TIMEOUT_MS ?? "20000");
  return Number.isFinite(ms) && ms > 0 ? ms : 20000;
}

/** Forma cruda que debe tener el JSON emitido por los scripts Python. */
interface RawTranscribeOutput {
  language: string;
  duration: number;
  segments: TranscriptResult["segments"];
}

/** Request enviado al proceso --serve, uno por línea de stdin. */
interface ServeRequest {
  videoPath: string;
  language: string;
}

/**
 * Lector de líneas completas sobre un stream: acumula chunks fragmentados y
 * entrega una línea a la vez, en orden, aunque varias lleguen pegadas en un
 * mismo chunk. Si el stream se cierra sin más líneas pendientes, cualquier
 * espera en curso resuelve con `null`.
 */
function createLineReader(stream: NodeJS.ReadableStream) {
  let buffer = "";
  const pendingLines: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;

  function pushLine(line: string): void {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(line);
    } else {
      pendingLines.push(line);
    }
  }

  function pushClosed(): void {
    closed = true;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter?.(null);
    }
  }

  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      pushLine(line);
    }
  });

  stream.on("close", pushClosed);
  stream.on("end", pushClosed);
  stream.on("error", pushClosed);

  return {
    /** Espera la próxima línea completa; `null` si el stream se cerró sin
     * más líneas pendientes. */
    nextLine(): Promise<string | null> {
      if (pendingLines.length > 0) {
        return Promise.resolve(pendingLines.shift() as string);
      }
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/**
 * Crea un TranscribeEngine que delega la transcripción real a un único
 * proceso Python persistente (--serve), reutilizado para todos los clips de
 * la corrida, respetando el contrato de JSON normalizado descrito arriba.
 */
export function makePythonEngine(
  name: string,
  scriptPath: string,
): TranscribeEngine {
  const pythonBin = resolvePythonBin();
  const timeoutMs = resolveTimeoutMs();
  const idleTimeoutMs = resolveIdleTimeoutMs();

  type Child = ReturnType<typeof spawn>;
  type LineReader = ReturnType<typeof createLineReader>;

  let child: Child | null = null;
  let lineReader: LineReader | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Serializa todos los requests: el proceso --serve procesa un request a la
  // vez (lee 1 línea, responde 1 línea, antes de leer la siguiente). Aunque
  // el llamador (mini-pool de concurrencia de la etapa) invoque transcribe()
  // en paralelo para varios clips, aquí se ponen en fila; el proceso nunca
  // ve dos requests solapados.
  let chain: Promise<unknown> = Promise.resolve();
  // Cuenta requests que ya fueron aceptados por `transcribe()` (encolados en
  // `chain` o ya en curso) y todavía no terminaron (éxito o error). Es la
  // única fuente de verdad sobre "cola vacía y sin request en vuelo": se
  // incrementa de forma síncrona al aceptar un request (antes de esperar
  // turno en `chain`) y se decrementa cuando ese request finalmente se
  // resuelve, sin importar si el proceso tuvo que relanzarse a mitad. El
  // idle timer solo puede armarse cuando este contador vuelve a 0.
  let pendingCount = 0;

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  /** Arma el apagado por inactividad SOLO si de verdad no queda nada
   * pendiente (ni en cola ni en vuelo). Si mientras tanto ya llegó otro
   * request, no hace nada: ese request ya se encargó de desarmar el timer. */
  function scheduleIdleShutdownIfIdle(): void {
    if (pendingCount > 0) return;
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      killChild();
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  /** Mata el proceso --serve activo (si lo hay) y limpia el estado asociado. */
  function killChild(): void {
    clearIdleTimer();
    lineReader = null;
    const current = child;
    child = null;
    if (current) {
      try {
        current.kill("SIGKILL");
      } catch {
        // El proceso ya podía estar muerto; no hay nada más que hacer.
      }
    }
  }

  function spawnChild(): Child {
    const proc = spawn(pythonBin, [scriptPath, "--serve"]);

    // El progreso/diagnóstico del motor viaja por stderr; lo dejamos fluir a
    // console.error con un prefijo que identifica el motor.
    proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      console.error(`[transcribe:${name}] ${text.trimEnd()}`);
    });

    // Un EPIPE al escribir en stdin de un proceso que ya murió no debe
    // tumbar todo el proceso Node por una excepción no capturada.
    proc.stdin.on("error", () => {
      /* se maneja al leer (o no) la respuesta correspondiente */
    });

    proc.on("exit", () => {
      if (child === proc) {
        child = null;
        lineReader = null;
      }
    });

    proc.on("error", () => {
      if (child === proc) {
        child = null;
        lineReader = null;
      }
    });

    child = proc;
    lineReader = createLineReader(proc.stdout);
    return proc;
  }

  /** Asegura que haya un proceso --serve vivo (lazy spawn) y devuelve tanto
   * el proceso como su lector de líneas. */
  function ensureChild(): { proc: Child; reader: LineReader } {
    if (!child || !lineReader) {
      const proc = spawnChild();
      return { proc, reader: lineReader as LineReader };
    }
    return { proc: child, reader: lineReader };
  }

  /** Envía un request al proceso --serve activo y espera su única línea de
   * respuesta, con timeout. Lanza si el proceso muere antes de responder o
   * si se excede el timeout (en ambos casos el proceso queda matado). */
  async function sendOnce(payload: ServeRequest): Promise<RawTranscribeOutput> {
    const { proc, reader } = ensureChild();
    const baseName = path.basename(payload.videoPath);

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);

    let line: string | null;
    try {
      proc.stdin?.write(`${JSON.stringify(payload)}\n`);
      line = await reader.nextLine();
    } finally {
      clearTimeout(timeout);
    }

    if (timedOut) {
      throw new Error(
        `Motor '${name}' excedió el timeout de ${timeoutMs / 60000} min transcribiendo '${baseName}'`,
      );
    }

    if (line === null) {
      killChild();
      throw new Error(
        `El proceso --serve del motor '${name}' terminó inesperadamente antes de responder por '${baseName}'`,
      );
    }

    let parsed: RawTranscribeOutput | { error: string };
    try {
      parsed = JSON.parse(line) as RawTranscribeOutput | { error: string };
    } catch {
      throw new Error(
        `Falló la transcripción de ${baseName}: el motor '${name}' no devolvió JSON válido`,
      );
    }

    if ("error" in parsed) {
      // Error por-clip: el proceso sigue vivo y listo para el siguiente
      // request, no es un fallo de la corrida completa. El armado (o no) del
      // idle timer lo decide el llamador (`transcribe()`) en función de
      // `pendingCount`, no este helper.
      throw new Error(`Falló la transcripción de ${baseName}: ${parsed.error}`);
    }

    return parsed;
  }

  /** Igual que sendOnce, pero si el proceso muere antes de responder (fallo
   * de proceso, no un {"error": ...} por-clip) relanza y reintenta el mismo
   * request una única vez. */
  async function sendWithRetry(payload: ServeRequest): Promise<RawTranscribeOutput> {
    try {
      return await sendOnce(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isProcessDeath = message.includes("terminó inesperadamente");
      if (!isProcessDeath) throw err;

      console.error(
        `[transcribe:${name}] proceso --serve murió; relanzando y reintentando '${path.basename(payload.videoPath)}' una vez`,
      );
      return await sendOnce(payload);
    }
  }

  return {
    name,
    transcribe(videoPath: string, language: string): Promise<TranscriptResult> {
      const payload: ServeRequest = { videoPath, language };
      const task = () => sendWithRetry(payload);

      // Este request queda "en vuelo" desde YA (aunque todavía espere turno
      // en `chain`), así que desarmamos cualquier idle timer pendiente de
      // inmediato y de forma síncrona: no dependemos de que la cola llegue a
      // ejecutar este request para notar que ya no está ociosa.
      pendingCount += 1;
      clearIdleTimer();

      // Encadena tras la tarea anterior (haya tenido éxito o no) para
      // serializar el acceso al proceso --serve: `chain` siempre queda en
      // estado resuelto (nunca rechazado) para que un fallo de un clip no
      // rompa la cola de los siguientes llamadores.
      const result = chain.then(task);
      chain = result.then(
        () => undefined,
        () => undefined,
      );

      // Pase lo que pase con este request (éxito, error por-clip, o muerte
      // de proceso con reintento agotado), al terminar dejamos de contarlo
      // como pendiente y, si con eso la cola queda realmente vacía y sin
      // nada en vuelo, recién ahí armamos el apagado por inactividad.
      result.then(
        () => {
          pendingCount -= 1;
          scheduleIdleShutdownIfIdle();
        },
        () => {
          pendingCount -= 1;
          scheduleIdleShutdownIfIdle();
        },
      );

      return result.then((raw) => ({
        language: raw.language,
        durationSeconds: raw.duration,
        segments: raw.segments,
        narration: true,
      }));
    },
  };
}
