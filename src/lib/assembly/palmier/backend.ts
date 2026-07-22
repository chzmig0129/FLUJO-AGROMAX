/**
 * assembly/palmier/backend.ts — implementación de AssemblyBackend sobre
 * PalmierPro (la app de escritorio, vía MCP). El protocolo de transporte
 * (SSE, sesión, cola serializada) vive en ./mcp-client.ts; este módulo es el
 * ÚNICO que conoce la SECUENCIA de tools que arma una clase.
 *
 * DIFERENCIAS CON EL DISEÑO ORIGINAL, documentadas porque salen de consultar
 * los schemas reales con `tools/list` contra la app viva (ver
 * ./mcp-client.ts para el ejemplo de curl):
 *
 *  - NO se llama `ripple_delete_ranges`. `plan.timeline` (ver ../types.ts,
 *    `TimelineEntry`) YA es la lista de tramos "keep": agregar cada tramo
 *    con `add_clips({source:[startSeconds,endSeconds]})` arma la clase
 *    completa sin nunca haber puesto lo descartado, así que no hay nada que
 *    recortar después. Es el camino más simple y evita depender del formato
 *    exacto del CutsFile dentro de este backend.
 *  - El intro se inserta AL FINAL de la secuencia de clips, no al principio.
 *    `insert_clips` ripplea (empuja a la derecha) todo clip en o después de
 *    `atFrame`; agregando primero todo el contenido desde el frame 0 y
 *    recién después `insert_clips({atFrame:0})` del intro, el intro empuja
 *    el contenido ya puesto — no hace falta reservar el hueco de antemano
 *    ni recalcular offsets de nada más.
 *  - `create_timeline` YA activa la timeline nueva (dixit su propia
 *    descripción en tools/list: "Creates a timeline and switches to it").
 *    Se llama `set_active_timeline` igual, en forma defensiva/idempotente,
 *    tal como pide el diseño, pero no es estrictamente necesario.
 *  - `import_media` con `source.path` apuntando a un DIRECTORIO lo importa
 *    recursivamente y replica esa carpeta como "folder" de medios (no existe
 *    una tool separada de "importar carpeta"). Se importa a un folder con el
 *    `lessonId` para poder recuperar los `mediaRef` después con
 *    `get_media({folder})`, matcheando assets por nombre de archivo
 *    (import_media nombra el asset con el basename del path cuando no se
 *    pasa `name` explícito).
 *  - `export_project` acepta `outputPath` directo: se le pasa el
 *    `<final>.tmp.mp4` de `verify.ts` (`tempPathFor`) para que
 *    `verifyAndCommit()` sea, letra por letra, el mismo juez que usa
 *    Remotion — Palmier nunca escribe la ruta final él mismo.
 *
 * NO VALIDADO EN VIVO: la forma exacta de la respuesta de `create_timeline`
 * y de `export_project` (el `jobId` de background). Durante el desarrollo de
 * este backend la app estaba abierta pero SIN ningún proyecto abierto
 * (`manage_project list` → `openCount:0`), así que no había timeline activa
 * contra la que probar una mutación real (y las mutaciones estaban
 * prohibidas para este worker). Se documenta la mejor hipótesis del shape
 * (buscar `timelineId`/`jobId` en las formas plausibles del payload) y se
 * falla con un error explícito y accionable si ninguna calza, en vez de
 * asumir en silencio. El smoke E2E contra la app corre después.
 *
 * CAVEAT DE AUDIO (fuera de alcance de este issue): a diferencia de
 * Remotion, que fuerza una única pista de audio continua rellenando con
 * silencio los tramos mudos (ver remotion/backend.ts / enforceAudioTrack),
 * este backend no inserta silencio explícito donde `hasAudio === false`.
 * `verifyAndCommit` solo exige que la salida tenga ALGUNA pista de audio,
 * no que sea continua sin huecos — aceptable para la primera versión del
 * backend Palmier, pero documentado para no darlo por sentado.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import type {
  AssemblyBackend,
  IntroRenderInput,
  LessonAssemblyPlan,
  RenderArtifact,
  RenderProgress,
} from "../types";
import { PalmierClient } from "./mcp-client";
import { remotionBackend } from "../remotion/backend";
import { tempPathFor, verifyAndCommit } from "../verify";
import { applyCaptions } from "./captions";
import { applyOverlays } from "./overlays";

/** Instancia única del cliente MCP del proceso: comparte la cola serializada
 * entre `assembleLesson`, `applyCaptions` y `applyOverlays`. */
const client = new PalmierClient();

/** Intervalo de poll para import_media / export_project (background jobs). */
const POLL_INTERVAL_MS = 3_000;
/** Tope de espera para que `import_media` termine de traer los proxies. */
const IMPORT_TIMEOUT_MS = 10 * 60_000;
/** Tope de espera para que `export_project` complete el render. */
const EXPORT_TIMEOUT_MS = 30 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

/**
 * Extrae un `timelineId` de la respuesta de `create_timeline`, probando las
 * formas plausibles del schema (ver "NO VALIDADO EN VIVO" en el header).
 */
function extractTimelineId(result: unknown): string | null {
  const r = toRecord(result);
  if (!r) return null;
  const direct = r.timelineId ?? r.id;
  if (typeof direct === "string") return direct;
  const nested = toRecord(r.timeline);
  const nestedId = nested?.timelineId ?? nested?.id;
  return typeof nestedId === "string" ? nestedId : null;
}

/** Extrae un `jobId` de la respuesta de `export_project`. Ver mismo caveat. */
function extractJobId(result: unknown): string | null {
  const r = toRecord(result);
  if (!r) return null;
  const direct = r.jobId ?? r.id;
  return typeof direct === "string" ? direct : null;
}

/**
 * Shape real de un asset registrado por Palmier (verificado en vivo, no el
 * supuesto original): `name` es el BASENAME SIN EXTENSIÓN del archivo
 * importado (ej. `"rumen-final"` para `rumen-final.mp4`), y `folder` es la
 * ruta de carpeta bajo la que quedó registrado (ej. `"lesson-1/proxies"`
 * cuando se importó un directorio `proxies` bajo el folder `"lesson-1"`).
 */
type MediaAsset = {
  id?: unknown;
  name?: unknown;
  folder?: unknown;
  generationStatus?: unknown;
};

function extractAssets(result: unknown): MediaAsset[] {
  const r = toRecord(result);
  const assets = r?.assets;
  return Array.isArray(assets) ? (assets as MediaAsset[]) : [];
}

/** Basename de un path SIN extensión, para matchear contra `asset.name`. */
function basenameNoExt(p: string): string {
  return path.basename(p, path.extname(p));
}

/**
 * Carpeta bajo la que `import_media` registra los assets de un DIRECTORIO
 * importado con `folder` = `lessonId`: replica el nombre del directorio como
 * subcarpeta (ej. `import_media({source:{path:".../proxies"}, folder:"lesson-1"})`
 * registra los assets bajo `"lesson-1/proxies"`).
 */
function importedDirFolder(lessonId: string, dir: string): string {
  return `${lessonId}/${path.basename(dir)}`;
}

/**
 * Importa cada directorio único que contiene los proxies referenciados por
 * el plan (normalmente uno solo: jobs/<id>/assets/proxies), más el intro si
 * existe en disco, todo bajo un folder de medios con el `lessonId`. Devuelve
 * ese folder para que el llamador arme el mapa nombre→mediaRef después.
 */
async function importSources(plan: LessonAssemblyPlan): Promise<string> {
  const folder = plan.lessonId;
  const proxyDirs = new Set(plan.timeline.map((entry) => path.dirname(entry.sourcePath)));

  for (const dir of proxyDirs) {
    await client.call("import_media", { source: { path: dir }, folder });
  }

  if (plan.intro) {
    try {
      await fs.access(plan.intro.sourcePath);
      await client.call("import_media", { source: { path: plan.intro.sourcePath }, folder });
    } catch {
      // Igual que remotion: un intro que no está en disco se ensambla sin
      // él en vez de fallar el import.
    }
  }

  return folder;
}

/** Poll de `get_media({folder, pending:true})` hasta que no quede nada pendiente. */
async function waitForImportsReady(folder: string): Promise<void> {
  const deadline = Date.now() + IMPORT_TIMEOUT_MS;
  for (;;) {
    const result = await client.call("get_media", { folder, pending: true });
    const pending = extractAssets(result);
    if (pending.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Palmier: los medios importados a "${folder}" no terminaron de procesarse tras ${IMPORT_TIMEOUT_MS / 1000}s.`
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * Mapa `"${folder}::${basenameSinExt}"` → mediaRef, para TODOS los assets del
 * proyecto: `get_media` SIN argumentos devuelve todos los assets (no filtra
 * por `folder`, a diferencia de lo asumido originalmente), y `asset.name` ya
 * viene sin extensión — el filtrado por carpeta se hace acá, en JS.
 */
async function buildMediaMap(): Promise<Map<string, string>> {
  const result = await client.call("get_media", {});
  const assets = extractAssets(result);
  const map = new Map<string, string>();
  for (const asset of assets) {
    if (
      typeof asset.id === "string" &&
      typeof asset.name === "string" &&
      typeof asset.folder === "string"
    ) {
      map.set(`${asset.folder}::${asset.name}`, asset.id);
    }
  }
  return map;
}

function mediaRefFor(map: Map<string, string>, sourcePath: string, folder: string): string {
  const name = basenameNoExt(sourcePath);
  const key = `${folder}::${name}`;
  const ref = map.get(key);
  if (!ref) {
    throw new Error(
      `Palmier: no se encontró el asset importado para "${name}" en la carpeta "${folder}" (esperado en get_media tras import_media).`
    );
  }
  return ref;
}

/**
 * Ubica el índice del track de video donde `add_clips` (sin `trackIndex`
 * explícito por entrada) creó los clips del contenido: la primera pista de
 * video del `get_timeline` con al menos `expectedClipCount` clips.
 */
async function findContentVideoTrackIndex(expectedClipCount: number): Promise<number> {
  const result = await client.call("get_timeline", {});
  const r = toRecord(result);
  const tracks = Array.isArray(r?.tracks) ? (r!.tracks as Array<Record<string, unknown>>) : [];
  for (const track of tracks) {
    if (track.type !== "video") continue;
    const clips = Array.isArray(track.clips) ? track.clips : [];
    if (clips.length >= expectedClipCount) {
      const index = track.index;
      if (typeof index === "number") return index;
    }
  }
  // Track 0 está reservado (captions, ver captions.ts línea ~40): si ninguna
  // pista de `get_timeline` calza con el conteo esperado de clips, el schema
  // real difiere de lo asumido y NO se debe asumir 0 en silencio — eso podría
  // insertar el intro sobre el track reservado. Fallar claro.
  throw new Error(
    `Palmier: no se pudo ubicar el track de video de contenido (se esperaban >= ${expectedClipCount} clips en alguna pista "video" de get_timeline). El track 0 está reservado para captions y no se usa como fallback.`
  );
}

/** Arma los `entries` de `add_clips` para todo `plan.timeline`, secuencial desde el frame 0. */
function buildClipEntries(
  plan: LessonAssemblyPlan,
  mediaMap: Map<string, string>
): Array<{ mediaRef: string; startFrame: number; source: [number, number] }> {
  let cursor = 0;
  return plan.timeline.map((entry) => {
    const folder = importedDirFolder(plan.lessonId, path.dirname(entry.sourcePath));
    const mediaRef = mediaRefFor(mediaMap, entry.sourcePath, folder);
    const clip = {
      mediaRef,
      startFrame: cursor,
      source: [entry.startFrame / plan.fps, entry.endFrame / plan.fps] as [number, number],
    };
    cursor += entry.endFrame - entry.startFrame;
    return clip;
  });
}

/** Poll de `manage_exports` hasta que el job de export termine (o falle). */
async function waitForExport(
  jobId: string,
  expectedFrames: number,
  onProgress?: (p: RenderProgress) => void
): Promise<void> {
  const deadline = Date.now() + EXPORT_TIMEOUT_MS;
  for (;;) {
    const result = await client.call("manage_exports", { action: "list" });
    const r = toRecord(result);
    // Shape real verificado en vivo: {"exports":[{filename, jobId, path, progress, status}]}.
    // `jobs` y el array plano se conservan como fallback defensivo por si el backend cambia.
    const jobs = Array.isArray(r?.exports)
      ? (r!.exports as Array<Record<string, unknown>>)
      : Array.isArray(r?.jobs)
        ? (r!.jobs as Array<Record<string, unknown>>)
        : Array.isArray(result)
          ? (result as Array<Record<string, unknown>>)
          : [];
    const job = jobs.find((j) => j.jobId === jobId || j.id === jobId);
    if (job) {
      const status = String(job.status ?? "").toLowerCase();
      const progress = typeof job.progress === "number" ? job.progress : 0;
      onProgress?.({
        frame: Math.round((progress / 100) * expectedFrames),
        totalFrames: expectedFrames,
      });
      if (status === "completed" || status === "done" || status === "success") return;
      if (status === "failed" || status === "error" || status === "canceled" || status === "cancelled") {
        const warnings = job.warnings ?? job.result ?? "";
        throw new Error(
          `Palmier: el export "${jobId}" terminó en estado "${status}": ${JSON.stringify(warnings)}`
        );
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Palmier: el export "${jobId}" no completó tras ${EXPORT_TIMEOUT_MS / 1000}s (nunca se confía en que el archivo exista sin ver "completed").`
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export const palmierBackend: AssemblyBackend = {
  name: "palmier",

  async isAvailable() {
    try {
      await client.health();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },

  /** Etapa 9: el intro sigue siendo Remotion (no cambia con el backend de ensamblaje). */
  async renderIntro(input: IntroRenderInput, onProgress?: (p: RenderProgress) => void) {
    return remotionBackend.renderIntro(input, onProgress);
  },

  /** Etapa 11: secuencia real contra Palmier, una llamada MCP a la vez. */
  async assembleLesson(
    plan: LessonAssemblyPlan,
    onProgress?: (p: RenderProgress) => void
  ): Promise<RenderArtifact> {
    await client.health();

    const created = await client.call("create_timeline", { name: plan.lessonId });
    const timelineId = extractTimelineId(created);
    if (timelineId) {
      // create_timeline ya activa la timeline nueva; esto es defensivo/
      // idempotente, tal como pide el diseño (ver header del archivo).
      await client.call("set_active_timeline", { timelineId });
    }

    await client.call("set_project_settings", {
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
    });

    const importFolder = await importSources(plan);
    await waitForImportsReady(importFolder);
    const mediaMap = await buildMediaMap();

    const clipEntries = buildClipEntries(plan, mediaMap);
    await client.call("add_clips", { entries: clipEntries });

    // El intro se inserta solo si de verdad existe en disco: una clase sin
    // intro renderizado se ensambla igual (sin él), como en remotion/backend.ts.
    let introInserted = false;
    if (plan.intro) {
      try {
        await fs.access(plan.intro.sourcePath);
        const introRef = mediaRefFor(mediaMap, plan.intro.sourcePath, importFolder);
        const videoTrackIndex = await findContentVideoTrackIndex(clipEntries.length);
        await client.call("insert_clips", {
          trackIndex: videoTrackIndex,
          atFrame: 0,
          entries: [{ mediaRef: introRef, durationFrames: plan.intro.durationInFrames }],
        });
        introInserted = true;
      } catch {
        introInserted = false;
      }
    }

    // Palmier auto-conforma la resolución del timeline a la del PRIMER clip
    // agregado (verificado en vivo: aunque set_project_settings 1920x1080 se
    // llamó ANTES de add_clips/insert_clips, el timeline terminó en 607x1080).
    // Por eso se repite acá, después de add_clips y del insert del intro y
    // antes de captions/overlays/export, igual que la advertencia del diseño
    // sobre el auto-conform a 4K cuando el primer clip viene en esa resolución.
    await client.call("set_project_settings", {
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
    });

    // Offset REAL de intro para captions/overlays: 0 si el intro estaba
    // planeado pero no se llegó a insertar (archivo ausente en disco u otra
    // falla), nunca derivado de `plan.intro` a ciegas (ver FLUJO-AGROMAX-2tl).
    const introFrames = introInserted ? (plan.intro?.durationInFrames ?? 0) : 0;

    // Captions/overlays son contratos aparte (issues FLUJO-AGROMAX-9d0.3 y
    // FLUJO-AGROMAX-9d0.4): se llaman acá, entre insertar el intro y
    // exportar, tolerando que no hagan nada si el plan no trae captions u
    // overlays.
    await applyCaptions(client, plan, plan.jobId, introFrames);
    await applyOverlays(client, plan, plan.jobId, introFrames);

    const expectedFrames = introInserted
      ? plan.expectedFrames
      : plan.expectedFrames - (plan.intro?.durationInFrames ?? 0);

    const tmpPath = tempPathFor(plan.outputPath);
    await fs.mkdir(path.dirname(plan.outputPath), { recursive: true });
    await fs.rm(tmpPath, { force: true });

    const exportResult = await client.call("export_project", {
      mode: "video",
      codec: "H.264",
      resolution: "1080p",
      outputPath: tmpPath,
      overwrite: true,
    });
    const jobId = extractJobId(exportResult);
    if (!jobId) {
      throw new Error(
        `Palmier: la respuesta de export_project no trajo un jobId reconocible: ${JSON.stringify(exportResult)}`
      );
    }
    await waitForExport(jobId, expectedFrames, onProgress);

    // Mismo juez que remotion: ffprobe sobre el .tmp, y recién si pasa se
    // promueve a la ruta final con rename atómico.
    const probed = await verifyAndCommit(plan.outputPath, {
      expectedFrames,
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      requireAudio: true,
    });

    return {
      path: plan.outputPath,
      backend: "palmier",
      frames: probed.packetCount,
      durationSeconds: probed.durationSeconds,
      sizeBytes: probed.sizeBytes,
      renderedAt: new Date().toISOString(),
    } satisfies RenderArtifact;
  },

  /** No-op: Palmier no bundlea nada del lado del cliente, no hay cache que invalidar. */
  invalidateBundleCache(_publicRoot: string) {
    // Intencionalmente vacío — ver AssemblyBackend.invalidateBundleCache en ../types.
  },
};
