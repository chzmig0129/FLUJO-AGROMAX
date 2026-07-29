/**
 * assembly/ffmpeg/backend.ts — tercer AssemblyBackend (`ASSEMBLY_BACKEND=ffmpeg`):
 * ensambla cada clase con UN solo comando ffmpeg (ver filtergraph.ts) usando
 * el encoder de hardware disponible (ver encoder.ts), en vez de un navegador
 * headless (Remotion) o la app de escritorio de Palmier.
 *
 * QUÉ SIGUE SIENDO REMOTION ACÁ: el intro (etapa 9). Es una composición corta
 * y puramente visual (texto/animación, sin video de fuente) — no hay ninguna
 * ventaja en reescribirla en ffmpeg, así que `renderIntro` delega 1:1 al
 * `remotionBackend` ya existente. El RenderArtifact que devuelve conserva
 * `backend: "remotion"` (transparencia: ese archivo lo produjo de verdad el
 * motor de Remotion, aunque el job entero use ASSEMBLY_BACKEND=ffmpeg para
 * el resto).
 *
 * QUÉ HACE ESTE BACKEND DE VERDAD: `assembleLesson` arma un único filtergraph
 * (intro + tramos "keep" concatenados + overlays con fade + captions ASS
 * quemados) y lo corre con `execFile`/`spawn` — nunca con una shell, y con
 * cada ruta pasada como su propio argumento (`args: string[]`), nunca
 * interpolada en un string: así una ruta con espacios (este repo vive en una
 * carpeta con espacio) o con backslashes de Windows nunca rompe el parseo de
 * argumentos. Mismo patrón .tmp→rename que remotion/backend.ts: este módulo
 * nunca escribe ni renombra la ruta final por su cuenta, eso lo hace
 * `verifyAndCommit` (assembly/verify.ts) tras ffprobear el .tmp.
 */
import path from "node:path";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import type {
  AssemblyBackend,
  IntroRenderInput,
  LessonAssemblyPlan,
  RenderArtifact,
  RenderProgress,
} from "../types";
import { tempPathFor, verifyAndCommit } from "../verify";
import { remotionBackend } from "../remotion/backend";
import { resolveFfmpegBin } from "../../ffmpeg";
import { detectEncoder, ffmpegBinaryAvailable } from "./encoder";
import { buildAssembleArgs } from "./filtergraph";
import { POPPINS_BOLD_TTF, writeAssFile } from "./ass";

/** Directorio que contiene el .ttf de Poppins, usado como `fontsdir` de libass. */
const FONTS_DIR = path.dirname(POPPINS_BOLD_TTF);

/**
 * Corre ffmpeg con el ARGV dado, parseando `-progress pipe:1` (pares
 * `clave=valor` por línea, uno de ellos `frame=<n>`) para reportar avance.
 * Rechaza con el `stderr` acumulado si el proceso termina con exit code
 * distinto de 0 — `-loglevel error` en los args mantiene ese stderr corto y
 * accionable en vez de un dump completo de banner/config.
 */
function runFfmpeg(
  ffmpegBin: string,
  args: string[],
  totalFrames: number,
  onProgress?: (p: RenderProgress) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderrBuf = "";
    let stdoutTail = "";

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
      // No hay razón para acumular megabytes de un proceso que puede correr
      // horas: solo se necesita la cola para el mensaje de error final.
      if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-8000);
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutTail += chunk.toString("utf8");
      let newlineIdx: number;
      while ((newlineIdx = stdoutTail.indexOf("\n")) !== -1) {
        const line = stdoutTail.slice(0, newlineIdx).trim();
        stdoutTail = stdoutTail.slice(newlineIdx + 1);
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1);
        if (key === "frame") {
          const frame = Number(value);
          if (Number.isFinite(frame)) {
            onProgress?.({ frame, totalFrames });
          }
        }
      }
    });

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `ffmpeg terminó con código ${code}: ${stderrBuf.trim() || "(sin salida de error)"}`
          )
        );
      }
    });
  });
}

export const ffmpegBackend: AssemblyBackend = {
  name: "ffmpeg",

  async isAvailable() {
    const binCheck = await ffmpegBinaryAvailable();
    if (!binCheck.ok) return binCheck;

    // El intro lo sigue rindiendo Remotion: sin su entrypoint disponible,
    // este backend tampoco puede producir la etapa 9.
    const remotionCheck = await remotionBackend.isAvailable();
    if (!remotionCheck.ok) {
      return {
        ok: false,
        reason: `ffmpeg está disponible, pero el backend delega renderIntro() a Remotion y este no lo está: ${remotionCheck.reason}`,
      };
    }

    return { ok: true };
  },

  /** Etapa 9: delega 1:1 al backend de Remotion (ver nota de módulo). */
  async renderIntro(input: IntroRenderInput, onProgress?: (p: RenderProgress) => void) {
    return remotionBackend.renderIntro(input, onProgress);
  },

  /** Etapa 11: UN comando ffmpeg (filtergraph.ts) → verificar → promover. */
  async assembleLesson(
    plan: LessonAssemblyPlan,
    onProgress?: (p: RenderProgress) => void
  ): Promise<RenderArtifact> {
    const ffmpegBin = resolveFfmpegBin();
    const encoder = await detectEncoder();

    // El intro se inserta solo si de verdad existe en disco: mismo criterio
    // que remotion/backend.ts (una clase sin intro renderizado se ensambla
    // igual, sin él, en vez de fallar).
    let introSourcePath: string | null = null;
    if (plan.intro) {
      try {
        await fs.access(plan.intro.sourcePath);
        introSourcePath = plan.intro.sourcePath;
      } catch {
        introSourcePath = null;
      }
    }
    const introOffsetFrames = introSourcePath ? plan.intro!.durationInFrames : 0;

    const tmpPath = tempPathFor(plan.outputPath);
    await fs.mkdir(path.dirname(plan.outputPath), { recursive: true });
    await fs.rm(tmpPath, { force: true });

    const assPath = await writeAssFile(plan, introOffsetFrames);

    const expectedFrames = introSourcePath
      ? plan.expectedFrames
      : plan.expectedFrames - (plan.intro?.durationInFrames ?? 0);

    try {
      const { args } = buildAssembleArgs({
        plan,
        introSourcePath,
        assPath,
        fontsDir: FONTS_DIR,
        encoder,
        outputPath: tmpPath,
      });

      await runFfmpeg(ffmpegBin, args, expectedFrames, onProgress);
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    } finally {
      await fs.rm(assPath, { force: true }).catch(() => {});
    }

    const probed = await verifyAndCommit(plan.outputPath, {
      expectedFrames,
      width: plan.width,
      height: plan.height,
      fps: plan.fps,
      requireAudio: true,
    });

    return {
      path: plan.outputPath,
      backend: "ffmpeg",
      frames: probed.packetCount,
      durationSeconds: probed.durationSeconds,
      sizeBytes: probed.sizeBytes,
      renderedAt: new Date().toISOString(),
    } satisfies RenderArtifact;
  },

  // Sin bundle/proceso que cachear (a diferencia de Remotion): no-op.
  invalidateBundleCache() {},
};
