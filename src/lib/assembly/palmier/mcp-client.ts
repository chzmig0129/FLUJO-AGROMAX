/**
 * assembly/palmier/mcp-client.ts — cliente HTTP determinista al MCP de
 * PalmierPro (la app de escritorio corriendo en esta Mac).
 *
 * PROTOCOLO (verificado a mano contra la app viva, no supuesto):
 *  - Un único endpoint POST (default http://127.0.0.1:19789/mcp, override
 *    con env PALMIER_MCP_URL) que habla JSON-RPC 2.0 sobre HTTP.
 *  - La respuesta NO es JSON plano: siempre es `text/event-stream`, incluso
 *    para una llamada request/response normal (no hay streaming real de
 *    progreso en esta ruta — es un solo evento útil por respuesta). Forma
 *    observada del body crudo:
 *
 *      id: 2_2
 *      data:
 *
 *      id: 2_3
 *      event: message
 *      data: {"id":2,"jsonrpc":"2.0","result":{...}}
 *
 *    Es decir: puede haber un evento "keepalive" previo con `data:` vacío
 *    (sin payload) antes del evento real con el JSON-RPC completo. El
 *    contrato de este cliente es "tomar el ÚLTIMO `data:` con contenido no
 *    vacío del cuerpo completo" — de ahí sale directo el JSON-RPC response.
 *  - La primera llamada (`initialize`) devuelve un header `MCP-Session-Id`
 *    que hay que reenviar en todas las siguientes llamadas (incluida la
 *    notification `notifications/initialized`).
 *  - `notifications/initialized` es una notification (sin `id`): la app
 *    responde 202 Accepted con body vacío, no SSE. No hay nada que parsear.
 *  - `tools/call` no es el método top-level para listar herramientas: para
 *    eso existe `tools/list` (top-level, no pasa por `tools/call`).
 *  - El resultado de una tool exitosa llega en
 *    `result.content: [{type:"text", text: "..."}]`. El `text` puede ser:
 *      - JSON serializado (la mayoría de las tools de lectura, ej.
 *        manage_project list -> `{"openCount":0,"projects":[...]}`), o
 *      - texto plano (ej. mensajes de error).
 *    Este cliente intenta `JSON.parse` sobre ese texto y, si falla, deja el
 *    string tal cual — así `call()` sirve tanto para tools que devuelven
 *    JSON como para las que devuelven prosa.
 *  - Error de tool: `result.isError === true`, con el mensaje humano en
 *    `content[0].text` (ej. `"Editor not available"` cuando no hay timeline
 *    activo). NO llega como `error` JSON-RPC top-level en este caso — el
 *    error vive DENTRO de un result 200 OK.
 *
 * REGLA DURA DE DISEÑO: dos llamadas concurrentes a este MCP cuelgan la
 * app. Por eso `call()` encola internamente (promise chain) y garantiza que
 * nunca hay dos requests en vuelo a la vez, sin importar cuántos callers
 * concurrentes usen el mismo `PalmierClient`.
 */

const DEFAULT_MCP_URL = "http://127.0.0.1:19789/mcp";
const DEFAULT_TIMEOUT_MS = 120_000;
/** Backoff inicial (ms) y factor de multiplicación entre reintentos de "busy". */
const BUSY_RETRY_INITIAL_DELAY_MS = 5_000;
const BUSY_RETRY_BACKOFF_FACTOR = 1.5;
/** Patrón de error reintentable: Palmier ocupado con otra acción del editor. */
const BUSY_ERROR_PATTERN = /editor action is in progress/i;

/** Número de reintentos para el error "busy" de Palmier (env PALMIER_BUSY_RETRIES). */
function getBusyRetries(): number {
  const raw = process.env.PALMIER_BUSY_RETRIES;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Error específico de "no se pudo ni conectar" (server caído/URL mala). */
class PalmierConnectionError extends Error {}

interface JsonRpcResponse {
  id?: number | string;
  jsonrpc: "2.0";
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Extrae el último bloque `data:` no vacío de un cuerpo SSE crudo y lo
 * parsea como JSON. Devuelve `null` si no hay ningún bloque con contenido
 * (ej. una respuesta a una notification, que no debería llegar por acá).
 */
function parseLastSseJson(raw: string): unknown {
  const blocks = raw.split(/\r?\n\r?\n/);
  let lastPayload: string | null = null;
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.startsWith("data:"));
    if (lines.length === 0) continue;
    const payload = lines
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim();
    if (payload.length > 0) lastPayload = payload;
  }
  if (lastPayload === null) return null;
  try {
    return JSON.parse(lastPayload);
  } catch (err) {
    throw new Error(
      `Palmier MCP: no se pudo parsear el último evento SSE como JSON: ${(err as Error).message}. Payload: ${lastPayload.slice(0, 500)}`
    );
  }
}

/** Intenta parsear `text` como JSON; si falla, devuelve el string tal cual. */
function parseContentText(text: string): unknown {
  if (text.length === 0) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface PalmierClientOptions {
  /** Override de la URL del MCP (por defecto env PALMIER_MCP_URL o localhost). */
  url?: string;
  /** Timeout por llamada en ms (por defecto 120s), configurable por-cliente. */
  timeoutMs?: number;
}

export interface PalmierCallOptions {
  /** Timeout de esta llamada puntual, ms. Si se omite, usa el del cliente. */
  timeoutMs?: number;
}

/**
 * Cliente determinista al MCP de PalmierPro. Una instancia = una cola
 * serializada: nunca hay dos requests HTTP en vuelo a la vez, sin importar
 * cuántos callers usen `call()` concurrentemente.
 */
export class PalmierClient {
  private readonly url: string;
  private readonly defaultTimeoutMs: number;
  private sessionId: string | null = null;
  private nextRequestId = 1;
  /** Cola de serialización: cada operación se encadena a la anterior. */
  private queue: Promise<void> = Promise.resolve();
  /** Promesa única de inicialización (idempotente, se dispara una sola vez). */
  private initPromise: Promise<void> | null = null;
  /** true una vez que confirmamos que manage_project existe en tools/list. */
  private toolsVerified = false;

  constructor(options: PalmierClientOptions = {}) {
    this.url = options.url ?? process.env.PALMIER_MCP_URL ?? DEFAULT_MCP_URL;
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Encola `fn` detrás de cualquier operación previa (éxito o fallo no
   * frena la cola para el siguiente caller) y devuelve su resultado.
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    // La cola en sí nunca debe rechazar: solo nos importa el orden, no el
    // resultado de la operación anterior.
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private nextId(): number {
    return this.nextRequestId++;
  }

  /** POST JSON-RPC crudo, con manejo de timeout y de errores de red. */
  private async postJsonRpc(
    body: Record<string, unknown>,
    timeoutMs: number
  ): Promise<{ json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      };
      if (this.sessionId) headers["MCP-Session-Id"] = this.sessionId;
      try {
        res = await fetch(this.url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          throw new Error(
            `Palmier MCP: timeout de ${timeoutMs}ms esperando respuesta de "${body.method}".`
          );
        }
        throw new PalmierConnectionError(
          `No se pudo conectar a Palmier MCP en ${this.url}: ${(err as Error).message}`
        );
      }
    } finally {
      clearTimeout(timer);
    }

    const headerSessionId = res.headers.get("MCP-Session-Id") ?? res.headers.get("mcp-session-id");
    if (headerSessionId) this.sessionId = headerSessionId;

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Palmier MCP HTTP ${res.status} en "${body.method}": ${text.slice(0, 500)}`
      );
    }

    // Notifications (sin `id`) no llevan response body — 202 Accepted vacío.
    if (!("id" in body)) {
      return { json: null };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    if (contentType.includes("text/event-stream")) {
      return { json: parseLastSseJson(raw) };
    }
    // Fallback defensivo por si algún día responde JSON plano.
    return { json: raw.trim().length > 0 ? JSON.parse(raw) : null };
  }

  /** `initialize` + `notifications/initialized`, una sola vez por cliente. */
  private async doInit(): Promise<void> {
    const timeoutMs = this.defaultTimeoutMs;
    const initBody = {
      jsonrpc: "2.0",
      id: this.nextId(),
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "flujo-agromax", version: "1.0.0" },
      },
    };
    const { json } = await this.postJsonRpc(initBody, timeoutMs);
    const response = json as JsonRpcResponse | null;
    if (response?.error) {
      throw new Error(
        `Palmier MCP initialize falló: ${response.error.message ?? JSON.stringify(response.error)}`
      );
    }
    await this.postJsonRpc(
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      timeoutMs
    );
  }

  /**
   * Garantiza que `initialize` corrió (una sola vez, encolada). Todo caller
   * de `call()`/`listTools()` pasa por acá primero.
   */
  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.enqueue(() => this.doInit());
    }
    return this.initPromise;
  }

  /** Método público explícito, por si un caller quiere forzar el handshake. */
  async init(): Promise<void> {
    await this.ensureInit();
  }

  /** `tools/list` top-level (NO es una tool, es un método JSON-RPC propio). */
  private async listTools(): Promise<string[]> {
    await this.ensureInit();
    return this.enqueue(async () => {
      const { json } = await this.postJsonRpc(
        { jsonrpc: "2.0", id: this.nextId(), method: "tools/list", params: {} },
        this.defaultTimeoutMs
      );
      const response = json as JsonRpcResponse | null;
      if (response?.error) {
        throw new Error(
          `Palmier MCP tools/list falló: ${response.error.message ?? JSON.stringify(response.error)}`
        );
      }
      const tools = (response?.result as { tools?: Array<{ name: string }> } | undefined)
        ?.tools;
      return Array.isArray(tools) ? tools.map((t) => t.name) : [];
    });
  }

  /**
   * Llama a una tool del MCP (`tools/call`). Serializada: espera a que
   * cualquier llamada previa en este cliente termine antes de salir.
   * Devuelve `result.content` ya parseado (JSON si el texto lo era; string
   * si no) y lanza `Error` si la tool devolvió `isError`.
   */
  async call(tool: string, args: object = {}, opts: PalmierCallOptions = {}): Promise<unknown> {
    await this.ensureInit();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    // El retry por "busy" vive DENTRO del callback encolado: así los
    // reintentos de esta llamada ocupan el turno completo de la cola y
    // ninguna otra llamada concurrente puede colarse entre reintentos.
    return this.enqueue(async () => {
      const maxRetries = getBusyRetries();
      let delayMs = BUSY_RETRY_INITIAL_DELAY_MS;
      for (let attempt = 0; ; attempt++) {
        const { json } = await this.postJsonRpc(
          {
            jsonrpc: "2.0",
            id: this.nextId(),
            method: "tools/call",
            params: { name: tool, arguments: args },
          },
          timeoutMs
        );
        const response = json as JsonRpcResponse | null;
        if (response?.error) {
          throw new Error(
            `Palmier MCP (${tool}) error JSON-RPC: ${response.error.message ?? JSON.stringify(response.error)}`
          );
        }
        const result = response?.result;
        if (!result) {
          throw new Error(`Palmier MCP (${tool}): respuesta sin "result".`);
        }
        const content = Array.isArray(result.content) ? result.content : [];
        const text = content.map((c) => c.text ?? "").join("\n");
        if (result.isError) {
          if (BUSY_ERROR_PATTERN.test(text) && attempt < maxRetries) {
            console.warn(
              `Palmier MCP (${tool}): "editor action is in progress", reintento ${attempt + 1}/${maxRetries} en ${delayMs}ms.`
            );
            await sleep(delayMs);
            delayMs *= BUSY_RETRY_BACKOFF_FACTOR;
            continue;
          }
          throw new Error(`Palmier MCP (${tool}): ${text || "error sin detalle"}`);
        }
        return text.length > 0 ? parseContentText(text) : content;
      }
    });
  }

  /**
   * Chequeo de salud: verifica (una vez) que `manage_project` existe en
   * tools/list, y llama `manage_project list` para confirmar que la app
   * responde y que no hay proyectos duplicados abiertos.
   */
  async health(): Promise<{ ok: true }> {
    try {
      if (!this.toolsVerified) {
        const names = await this.listTools();
        if (!names.includes("manage_project")) {
          throw new Error(
            `Palmier MCP: el tool "manage_project" no está disponible (tools/list devolvió: ${names.join(", ")}).`
          );
        }
        this.toolsVerified = true;
      }
      const result = (await this.call("manage_project", { action: "list" })) as {
        openCount?: number;
      };
      const openCount = typeof result?.openCount === "number" ? result.openCount : 0;
      if (openCount > 1) {
        throw new Error(
          `Palmier tiene ${openCount} proyectos abiertos a la vez. Cerrá los duplicados en PalmierPro ` +
            `(Archivo > Cerrar) y dejá abierto solo el proyecto de esta clase antes de reintentar.`
        );
      }
      return { ok: true };
    } catch (err) {
      if (err instanceof PalmierConnectionError) {
        throw new Error("Palmier no está corriendo (abrí PalmierPro en esta máquina).");
      }
      throw err;
    }
  }
}
