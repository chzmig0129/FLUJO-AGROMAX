/**
 * constants.ts — constantes deterministas usadas por las etapas 5A/5B/5C
 * (silencio, proxies y cortes). Centralizadas acá para que queden
 * inspeccionables y ajustables desde un único lugar, sin buscar números
 * mágicos dentro de cada stage.
 */

/** FPS objetivo de los proxies de edición (etapa 5B) y del sistema de frames de cortes (5C). */
export const PROXY_FPS = 30;

/** Ancho objetivo de los proxies de edición (etapa 5B), en píxeles. */
export const PROXY_WIDTH = 1920;

/** Alto objetivo de los proxies de edición (etapa 5B), en píxeles. */
export const PROXY_HEIGHT = 1080;

/** Umbral de nivel de audio (dB) por debajo del cual ffmpeg silencedetect considera silencio (etapa 5A). */
export const SILENCE_NOISE_DB = -30;

/** Duración mínima (segundos) para que un tramo por debajo de SILENCE_NOISE_DB cuente como silencio (etapa 5A). */
export const SILENCE_MIN_D = 0.5;

/**
 * Duración mínima (segundos) de un hueco entre segmentos de Whisper para
 * considerarlo candidato a corte (etapa 5C). Huecos más cortos que esto se
 * dejan intactos (no vale la pena recortar aire tan breve).
 */
export const GAP_MIN_SECONDS = 0.6;

/**
 * Aire de seguridad (segundos) que se deja a cada lado del corte dentro de
 * un hueco, para nunca comerse el final/inicio de una palabra hablada
 * (etapa 5C).
 */
export const CUT_PADDING_SECONDS = 0.18;

/**
 * Cantidad mínima de frames que debe tener un corte (tras aplicar el
 * padding) para que valga la pena conservarlo; cortes más cortos que esto
 * se descartan (etapa 5C).
 */
export const MIN_CUT_FRAMES = 3;
