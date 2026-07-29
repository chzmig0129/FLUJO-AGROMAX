/**
 * assembly/index.ts — selección del backend de ensamblaje.
 *
 * El backend se elige por variable de entorno:
 *
 *   ASSEMBLY_BACKEND=remotion   (default) headless/PC: corre sin UI, sirve
 *                               para máquinas sin la app de Palmier abierta.
 *   ASSEMBLY_BACKEND=palmier    Mac con la app de Palmier abierta y logueada;
 *                               ensamblaje determinista vía MCP, UN job a la
 *                               vez (no hay cola: un segundo job concurrente
 *                               pisaría la timeline activa del primero).
 *                               Falla temprano y con mensaje claro (ver
 *                               palmierBackend.isAvailable()/health() en
 *                               ./palmier/backend.ts) si la app no está
 *                               corriendo en ese momento.
 *   ASSEMBLY_BACKEND=ffmpeg     Headless, sin navegador: UN comando ffmpeg
 *                               por clase (intro + tramos "keep" + overlays
 *                               + captions ASS), con el encoder de hardware
 *                               que la máquina soporte de verdad
 *                               (h264_nvenc → h264_videotoolbox → libx264,
 *                               ver ./ffmpeg/encoder.ts). El intro sigue
 *                               siendo Remotion (ver ./ffmpeg/backend.ts).
 *
 * Este es el ÚNICO lugar del código donde se nombra una implementación
 * concreta. El resto del sistema (assembly-stage.ts, las rutas de API, la
 * UI) solo habla con la interfaz AssemblyBackend y no sabe —ni le importa—
 * cuál se usó; lo único que queda registrado es `backend.name` en el sidecar
 * y en el progreso, para trazabilidad.
 */
import { palmierBackend } from "./palmier/backend";
import { remotionBackend } from "./remotion/backend";
import { ffmpegBackend } from "./ffmpeg/backend";
import type { AssemblyBackend } from "./types";

/** Registro de implementaciones disponibles, indexado por nombre. */
const BACKENDS: Record<string, AssemblyBackend> = {
  remotion: remotionBackend,
  palmier: palmierBackend,
  ffmpeg: ffmpegBackend,
};

/** Backend usado cuando ASSEMBLY_BACKEND no está definido. */
export const DEFAULT_ASSEMBLY_BACKEND = "remotion";

/**
 * Devuelve el backend activo. Falla ruidosamente ante un nombre desconocido
 * en vez de caer silenciosamente al default: si alguien escribió mal la
 * variable, es mejor enterarse antes de renderizar dos horas de video con el
 * backend equivocado.
 */
export function getAssemblyBackend(): AssemblyBackend {
  const name = (
    process.env.ASSEMBLY_BACKEND ?? DEFAULT_ASSEMBLY_BACKEND
  ).trim();

  const backend = BACKENDS[name];
  if (!backend) {
    throw new Error(
      `ASSEMBLY_BACKEND="${name}" no es un backend de ensamblaje conocido. Opciones: ${Object.keys(BACKENDS).join(", ")}`
    );
  }
  return backend;
}

export type { AssemblyBackend } from "./types";
