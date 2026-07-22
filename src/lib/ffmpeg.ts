/**
 * ffmpeg.ts — resuelve qué binario de ffmpeg usan las etapas deterministas
 * del pipeline (proxy-stage.ts, silence-stage.ts, frames-stage.ts).
 *
 * Por defecto usamos ffmpeg-static (binario empaquetado, portable, mismo en
 * cualquier máquina) para que el pipeline corra sin depender de nada
 * instalado en el sistema. Pero en la PC Windows con RTX 2060 queremos el
 * ffmpeg del sistema (gyan full build), porque ese trae h264_nvenc
 * (encoder acelerado por GPU) y ffmpeg-static no lo incluye. FFMPEG_BIN
 * permite apuntar a ese binario sin tocar código: si está definida y no
 * vacía, se usa esa ruta; si no, se cae al ffmpeg-static empaquetado.
 *
 * SOLO este archivo importa ffmpeg-static: las etapas llaman a
 * resolveFfmpegBin() y no conocen el paquete directamente.
 */
import ffmpegStaticPath from "ffmpeg-static";

/**
 * Devuelve la ruta al binario de ffmpeg a usar: process.env.FFMPEG_BIN si
 * está definida y no-vacía, o el binario de ffmpeg-static como default.
 * Lanza un Error claro si ninguno de los dos está disponible.
 */
export function resolveFfmpegBin(): string {
  const fromEnv = process.env.FFMPEG_BIN;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv;
  }
  if (ffmpegStaticPath) {
    return ffmpegStaticPath;
  }
  throw new Error(
    "No hay binario de ffmpeg disponible: definí FFMPEG_BIN o instalá ffmpeg-static"
  );
}
