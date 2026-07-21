/**
 * agent.ts — corre el agente autónomo de la etapa 4 (filtro editorial y
 * estructura del curso) con el SDK de Anthropic (tool-runner beta).
 *
 * Lee master.txt (transcripción completa del job), summary.json, media.json,
 * frames/manifest.json y config/domain-heuristics.md; arma el primer turno
 * (heurísticas + master.txt + frames iniciales, con un breakpoint de caché
 * al final del bloque estable); deja que el agente pida frames extra bajo
 * demanda vía la tool `extraer_frames` cuando su confianza es baja; y al
 * recibir `entregar_resultado` escribe plan/{verdicts,structure,audit}.json
 * y plan/decisiones.md.
 *
 * NO se corre el agente real en este issue (cuesta dinero de API): la
 * verificación e2e la hace el Lead por separado.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import type {
  BetaContentBlockParam,
  BetaImageBlockParam,
  BetaTextBlockParam,
  BetaToolResultContentBlockParam,
} from "@anthropic-ai/sdk/resources/beta";
import { extractFramesForClip } from "../frames-stage";
import {
  framesDir,
  readFramesManifest,
  readMediaJson,
  transcriptsDir,
  writeAuditJson,
  writeDecisionesMd,
  writeStructureJson,
  writeVerdictsJson,
} from "../jobs";
import type {
  AuditJson,
  FramesManifest,
  StructureJson,
  Verdict,
} from "../types";
import {
  entregarResultadoInputSchema,
  extraerFramesInputSchema,
} from "./schemas";
import { PLAN_AGENT_SYSTEM_PROMPT } from "./prompt";

/** Modelo usado por el agente de la etapa 4. */
const MODEL = "claude-opus-4-8";

/** Presupuesto máximo de frames extra que puede pedir el agente en una corrida. */
const MAX_FRAMES_PER_CALL = 12;
const MAX_FRAMES_CALLS = 10;
const MAX_TOTAL_EXTRA_FRAMES = 40;

/** Cap global de imágenes en el primer turno (para no reventar el contexto). */
const MAX_INITIAL_IMAGES = 80;

/** Payload que entrega el agente vía la tool `entregar_resultado`. */
interface EntregarResultadoPayload {
  courseTitle: string;
  verdicts: Verdict[];
  modules: StructureJson["modules"];
  decisionesMd: string;
}

/** Lee config/domain-heuristics.md desde la raíz del repo. Si falta, avisa y sigue sin heurísticas. */
async function readDomainHeuristics(): Promise<string | null> {
  const heuristicsPath = path.join(process.cwd(), "config", "domain-heuristics.md");
  try {
    return await fs.readFile(heuristicsPath, "utf-8");
  } catch {
    console.warn(
      "plan-agent: no se encontró config/domain-heuristics.md; el agente correrá solo con el motor genérico"
    );
    return null;
  }
}

/** Lee transcripts/master.txt de un job. Si falta, la etapa de transcripción no corrió. */
async function readMasterTxt(jobId: string): Promise<string> {
  try {
    return await fs.readFile(path.join(transcriptsDir(jobId), "master.txt"), "utf-8");
  } catch {
    throw new Error(
      "No hay transcripts/master.txt: corre la transcripción antes de planear"
    );
  }
}

/** Lee un frame JPG del disco y lo devuelve como bloque de imagen base64 para la API. */
async function readFrameAsImageBlock(
  jobId: string,
  frameFile: string
): Promise<BetaImageBlockParam> {
  const data = await fs.readFile(path.join(framesDir(jobId), frameFile));
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/jpeg",
      data: data.toString("base64"),
    },
  };
}

/**
 * Selecciona qué frames iniciales de un clip incluir en el primer turno:
 * clips narrados -> 1 frame (el 2º de su lista, si existe; si no, el primero
 * disponible); clips sin narración (B-roll) -> hasta 4 frames.
 */
function pickInitialFrames(clip: FramesManifest["clips"][number]) {
  if (clip.frames.length === 0) return [];
  if (clip.narration) {
    return [clip.frames[1] ?? clip.frames[0]];
  }
  return clip.frames.slice(0, 4);
}

/**
 * Construye el contenido del primer user turn: texto de heurísticas +
 * instrucciones de datos, master.txt, frames iniciales (imágenes), y un
 * último bloque de texto con cache_control ephemeral para que el prompt
 * cache cubra todo el bloque estable (las iteraciones posteriores del loop
 * reutilizan ese prefijo a ~0.1x costo).
 */
async function buildInitialUserContent(
  jobId: string,
  heuristics: string | null,
  masterTxt: string,
  manifest: FramesManifest
): Promise<BetaContentBlockParam[]> {
  const content: BetaContentBlockParam[] = [];

  const heuristicsText = heuristics
    ? `## Heurísticas del dominio (config/domain-heuristics.md)\n\n${heuristics}`
    : "## Heurísticas del dominio\n\n(No hay config/domain-heuristics.md disponible; usa solo el motor genérico.)";
  content.push({ type: "text", text: heuristicsText } satisfies BetaTextBlockParam);

  content.push({
    type: "text",
    text: `## Transcripción completa del job (master.txt)\n\n${masterTxt}`,
  } satisfies BetaTextBlockParam);

  let imageCount = 0;
  for (const clip of manifest.clips) {
    if (imageCount >= MAX_INITIAL_IMAGES) break;
    const initialFrames = pickInitialFrames(clip);
    if (initialFrames.length === 0) continue;

    const timestamps = initialFrames.map((f) => `${f.timeSeconds}s`).join(", ");
    content.push({
      type: "text",
      text: `Frames iniciales de ${clip.filename}: t=${timestamps}`,
    } satisfies BetaTextBlockParam);

    for (const frame of initialFrames) {
      if (imageCount >= MAX_INITIAL_IMAGES) break;
      content.push(await readFrameAsImageBlock(jobId, frame.file));
      imageCount += 1;
    }
  }

  // Instrucciones de datos + cierre del bloque estable: cache breakpoint al
  // final para que todo lo de arriba (heurísticas + master.txt + frames
  // iniciales) quede cacheado entre iteraciones del loop.
  content.push({
    type: "text",
    text: "Con esta información (heurísticas, transcripción completa y frames iniciales) evalúa cada clip, pide frames extra con `extraer_frames` solo cuando tu confianza sea menor a 0.6 y los frames disponibles no basten, y entrega tu resultado final con `entregar_resultado` cuando termines.",
    cache_control: { type: "ephemeral" },
  } satisfies BetaTextBlockParam);

  return content;
}

/** Estado acumulado de uso de tokens a través de todas las iteraciones del loop. */
interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/**
 * Corre la etapa de plan completa para un job: arma el primer turno, corre
 * el agente con tool-runner hasta que llame `entregar_resultado`, y escribe
 * plan/{verdicts,structure,audit}.json + plan/decisiones.md.
 */
export async function runPlanAgent(jobId: string): Promise<void> {
  const [heuristics, masterTxt, manifest] = await Promise.all([
    readDomainHeuristics(),
    readMasterTxt(jobId),
    readFramesManifest(jobId),
  ]);
  // media.json no se usa directamente en el prompt (master.txt ya trae
  // duración/narración por clip), pero se lee para validar que la etapa de
  // probe corrió y detectar temprano un job incompleto.
  await readMediaJson(jobId);

  if (!manifest) {
    throw new Error(
      "No hay frames/manifest.json: corre el muestreo de frames antes de planear"
    );
  }

  const client = new Anthropic();

  // Presupuesto de frames extra bajo demanda: se comparte entre todas las
  // llamadas a extraer_frames de esta corrida.
  let framesCallCount = 0;
  let totalExtraFrames = 0;
  const framesCalls: AuditJson["framesCalls"] = [];

  /** Estima cuántos frames devolvería una llamada antes de ejecutarla, para poder rechazarla sin gastar ffmpeg. */
  function estimateFrameCount(
    clipDurationSeconds: number,
    params: { everySeconds?: number | null; count?: number | null; startSeconds?: number | null; endSeconds?: number | null }
  ): number {
    const start = params.startSeconds ?? 0;
    const end = params.endSeconds ?? clipDurationSeconds;
    if (params.count && params.count > 0) return params.count;
    if (params.everySeconds && params.everySeconds > 0) {
      return Math.max(1, Math.floor((end - start) / params.everySeconds) + 1);
    }
    return 4;
  }

  const extraerFramesTool = betaTool({
    name: "extraer_frames",
    description:
      "Extrae frames adicionales de un clip puntual cuando la confianza sobre su veredicto es menor a 0.6 y los frames iniciales no bastan. Límites: 12 frames por llamada, 10 llamadas por corrida, 40 frames extra en total.",
    inputSchema: extraerFramesInputSchema,
    run: async (args) => {
      if (framesCallCount >= MAX_FRAMES_CALLS) {
        return `Error: ya usaste el máximo de ${MAX_FRAMES_CALLS} llamadas a extraer_frames en esta corrida. Decide con la información disponible.`;
      }

      const clipEntry = manifest.clips.find((c) => c.filename === args.clip);
      if (!clipEntry) {
        return `Error: el clip "${args.clip}" no existe en frames/manifest.json de este job.`;
      }

      const estimate = estimateFrameCount(clipEntry.durationSeconds, args);
      if (estimate > MAX_FRAMES_PER_CALL) {
        return `Error: esta llamada pediría aproximadamente ${estimate} frames, que excede el máximo de ${MAX_FRAMES_PER_CALL} por llamada. Reduce el rango o el conteo.`;
      }
      if (totalExtraFrames + estimate > MAX_TOTAL_EXTRA_FRAMES) {
        return `Error: esta llamada excedería el presupuesto total de ${MAX_TOTAL_EXTRA_FRAMES} frames extra de esta corrida (ya usados: ${totalExtraFrames}). Decide con la información disponible.`;
      }

      framesCallCount += 1;

      const params = {
        everySeconds: args.everySeconds ?? undefined,
        count: args.count ?? undefined,
        startSeconds: args.startSeconds ?? undefined,
        endSeconds: args.endSeconds ?? undefined,
      };

      const newFrames = await extractFramesForClip(jobId, args.clip, params);
      totalExtraFrames += newFrames.length;

      framesCalls.push({
        clip: args.clip,
        params: {
          everySeconds: args.everySeconds ?? undefined,
          count: args.count ?? undefined,
          startSeconds: args.startSeconds ?? undefined,
          endSeconds: args.endSeconds ?? undefined,
        },
        framesAdded: newFrames.length,
      });

      if (newFrames.length === 0) {
        return `No se agregaron frames nuevos de ${args.clip} (los timestamps pedidos ya existían en el manifest).`;
      }

      const timestamps = newFrames.map((f) => `${f.timeSeconds}s`).join(", ");
      const result: BetaToolResultContentBlockParam[] = [
        { type: "text", text: `Frames extraídos de ${args.clip}: t=${timestamps}` },
      ];
      for (const frame of newFrames) {
        result.push(await readFrameAsImageBlock(jobId, frame.file));
      }
      return result;
    },
  });

  // Envuelto en un objeto (en vez de una variable suelta) porque TypeScript
  // no puede seguir el control flow de una reasignación hecha dentro del
  // closure `run` de la tool: con un objeto la propiedad se lee/escribe sin
  // problemas de narrowing.
  const captured: { payload: EntregarResultadoPayload | null } = { payload: null };

  const entregarResultadoTool = betaTool({
    name: "entregar_resultado",
    description:
      "Entrega el resultado final de la evaluación: un veredicto por cada clip, la estructura propuesta del curso y el markdown de decisiones. Se llama una sola vez, al terminar.",
    inputSchema: entregarResultadoInputSchema,
    run: async (args) => {
      captured.payload = args as EntregarResultadoPayload;
      return "Resultado recibido. Termina tu turno.";
    },
  });

  const initialContent = await buildInitialUserContent(jobId, heuristics, masterTxt, manifest);

  const usage: UsageAccumulator = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    system: PLAN_AGENT_SYSTEM_PROMPT,
    tools: [extraerFramesTool, entregarResultadoTool],
    messages: [{ role: "user", content: initialContent }],
    stream: true,
    max_iterations: 15,
  });

  for await (const stream of runner) {
    const message = await stream.finalMessage();
    if (message.usage) {
      usage.inputTokens += message.usage.input_tokens ?? 0;
      usage.outputTokens += message.usage.output_tokens ?? 0;
      usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
    }
  }

  const payload = captured.payload;
  if (!payload) {
    throw new Error(
      "El agente terminó su corrida sin llamar a entregar_resultado: no hay plan que escribir"
    );
  }

  const verdicts: Verdict[] = payload.verdicts;

  const structure: StructureJson = {
    courseTitle: payload.courseTitle,
    modules: payload.modules,
    apartados: verdicts.filter(
      (v) => v.verdict === "descartar" || v.verdict === "otro_curso"
    ),
  };

  // audit.json cruza cada veredicto con si ese clip tuvo llamadas a
  // extraer_frames durante la corrida (pidioFramesExtra) y con baja
  // confianza (< 0.6).
  const clipsCalledForFrames = new Set(framesCalls.map((c) => c.clip));
  const audit: AuditJson = {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    usage,
    framesCalls,
    clips: verdicts.map((v) => ({
      clip: v.clip,
      verdict: v.verdict,
      confianza: v.confianza,
      lowConfidence: v.confianza < 0.6,
      heuristicas: v.heuristicas,
      pidioFramesExtra: clipsCalledForFrames.has(v.clip),
    })),
  };

  await writeVerdictsJson(jobId, verdicts);
  await writeStructureJson(jobId, structure);
  await writeAuditJson(jobId, audit);
  await writeDecisionesMd(jobId, payload.decisionesMd);
}
