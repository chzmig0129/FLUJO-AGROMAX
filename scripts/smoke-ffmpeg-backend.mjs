#!/usr/bin/env node
/**
 * scripts/smoke-ffmpeg-backend.mjs — smoke test del backend de ensamblaje
 * "ffmpeg" (src/lib/assembly/ffmpeg/*).
 *
 * NO SE ESCRIBE COMO "import tsx" DE LOS MÓDULOS .ts A PROPÓSITO: este
 * repo no tiene `tsx` ni `ts-node` como dependencia (ver package.json), y el
 * soporte nativo de Node para TypeScript (`--experimental-strip-types`, Node
 * 22+) solo pela anotaciones de tipos — no resuelve imports relativos sin
 * extensión (`from "../types"`) a `.ts`, así que import()-ear
 * `assembly/ffmpeg/backend.ts` directo revienta con ERR_MODULE_NOT_FOUND en
 * un runtime plano. En vez de agregar una dependencia nueva solo para este
 * smoke test (fuera del alcance de este issue), este script reproduce el
 * MISMO filtergraph que arma `assembly/ffmpeg/filtergraph.ts`
 * (trim por frames exactos de cada tramo + concat + fps=30 + salida CFR
 * h264/aac) contra 2 clips sintéticos generados con `ffmpeg -f lavfi`, y
 * verifica con ffprobe que el conteo de frames del MP4 resultante coincide
 * EXACTO con lo esperado — que es precisamente la garantía que
 * assembly/verify.ts exige de cualquier backend real.
 *
 * Si en el futuro se agrega `tsx` como devDependency, este script puede
 * reescribirse para invocar `assembleLesson()` importado de verdad; hasta
 * entonces, esto ejerce la misma lógica de trims/concat/CFR sin depender de
 * un loader que hoy no existe en el repo.
 *
 * USO: node scripts/smoke-ffmpeg-backend.mjs
 * SALIDA: exit 0 si el conteo de frames del MP4 coincide (± tolerancia),
 * exit 1 con el detalle si no.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegStaticPath from "ffmpeg-static";

const execFileAsync = promisify(execFile);

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);
const ffprobeStatic = require("ffprobe-static");
const ffprobeBin =
  typeof ffprobeStatic === "string" ? ffprobeStatic : ffprobeStatic.path;

const ffmpegBin = ffmpegStaticPath;

const FPS = 30;
const WIDTH = 320;
const HEIGHT = 180;

/** Mismo margen que RENDER_FRAME_TOLERANCE en src/lib/constants.ts. */
const FRAME_TOLERANCE = 2;

async function run(bin, args) {
  const { stdout, stderr } = await execFileAsync(bin, args, {
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout, stderr };
}

/** Genera un clip sintético lavfi de color sólido + tono de audio, con N frames exactos a FPS. */
async function generateSyntheticClip(outPath, color, seconds) {
  await run(ffmpegBin, [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${seconds}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${seconds}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    outPath,
  ]);
}

/** Cuenta los paquetes de video reales de un archivo (mismo criterio que assembly/verify.ts). */
async function countVideoPackets(file) {
  const { stdout } = await run(ffprobeBin, [
    "-v",
    "error",
    "-count_packets",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=nb_read_packets",
    "-of",
    "csv=p=0",
    file,
  ]);
  return Number(stdout.trim());
}

async function main() {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "agromax-ffmpeg-smoke-"));
  const clipA = path.join(workDir, "clipA.mp4");
  const clipB = path.join(workDir, "clipB.mp4");
  const outPath = path.join(workDir, "assembled.mp4");

  try {
    // Plan mínimo: 2 clips sintéticos de 2s (=60 frames a 30fps) cada uno,
    // de los que se conserva un tramo "keep" (en FRAMES, como expone
    // assembly/plan.ts): [0,45) de clipA y [10,60) de clipB.
    await generateSyntheticClip(clipA, "red", 2);
    await generateSyntheticClip(clipB, "blue", 2);

    const keepA = { startFrame: 0, endFrame: 45 };
    const keepB = { startFrame: 10, endFrame: 60 };
    const expectedFrames =
      (keepA.endFrame - keepA.startFrame) + (keepB.endFrame - keepB.startFrame);

    // Mismo filtergraph que assembly/ffmpeg/filtergraph.ts: trim por frames
    // exactos + setpts + fps=30 + scale por segmento, concat, salida CFR.
    const filterComplex = [
      `[0:v]trim=start_frame=${keepA.startFrame}:end_frame=${keepA.endFrame},setpts=PTS-STARTPTS,fps=${FPS},scale=${WIDTH}:${HEIGHT},setsar=1[vseg0]`,
      `[0:a]atrim=start=${(keepA.startFrame / FPS).toFixed(6)}:end=${(keepA.endFrame / FPS).toFixed(6)},asetpts=PTS-STARTPTS[aseg0]`,
      `[1:v]trim=start_frame=${keepB.startFrame}:end_frame=${keepB.endFrame},setpts=PTS-STARTPTS,fps=${FPS},scale=${WIDTH}:${HEIGHT},setsar=1[vseg1]`,
      `[1:a]atrim=start=${(keepB.startFrame / FPS).toFixed(6)}:end=${(keepB.endFrame / FPS).toFixed(6)},asetpts=PTS-STARTPTS[aseg1]`,
      `[vseg0][aseg0][vseg1][aseg1]concat=n=2:v=1:a=1[vout][aout]`,
    ].join(";");

    await run(ffmpegBin, [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      clipA,
      "-i",
      clipB,
      "-filter_complex",
      filterComplex,
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-r",
      String(FPS),
      "-c:a",
      "aac",
      outPath,
    ]);

    const actualFrames = await countVideoPackets(outPath);
    const delta = Math.abs(actualFrames - expectedFrames);

    if (delta > FRAME_TOLERANCE) {
      console.error(
        `[smoke-ffmpeg-backend] FALLO: se esperaban ${expectedFrames} frames y el MP4 ensamblado tiene ${actualFrames} (delta ${delta} > tolerancia ${FRAME_TOLERANCE}).`
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `[smoke-ffmpeg-backend] OK: ${actualFrames} frames (esperados ${expectedFrames}, delta ${delta}).`
    );
    process.exitCode = 0;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("[smoke-ffmpeg-backend] error inesperado:", err);
  process.exitCode = 1;
});
