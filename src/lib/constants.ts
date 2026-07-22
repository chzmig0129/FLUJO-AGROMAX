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

/* ------------------------------------------------------------------ *
 * Etapas 9 (intros) y 11 (ensamblaje headless)
 * ------------------------------------------------------------------ */

/** Duración fija del intro de cada clase, en frames (5 s a 30 fps). */
export const INTRO_DURATION_FRAMES = 150;

/** Verde primario de la plataforma (marca AgroMax). */
export const BRAND_GREEN = "#22C55E";

/** Verde secundario/oscuro de la plataforma, usado en degradados y acentos. */
export const BRAND_GREEN_DARK = "#16A34A";

/** Fondo oscuro base del intro. */
export const BRAND_INK = "#08140C";

/**
 * Nota tipográfica: la familia del intro (Poppins + fallbacks) se define en
 * remotion/fonts/poppins.ts, junto a la carga de los .ttf versionados.
 */

/**
 * Tolerancia (en frames) al comparar los frames realmente presentes en un
 * render contra los esperados. No es holgura gratuita: los muxers pueden
 * cerrar el archivo con un paquete de diferencia según cómo cierren el GOP.
 * Más allá de esto, el archivo se considera truncado y el render FALLA.
 */
export const RENDER_FRAME_TOLERANCE = 2;

/* ------------------------------------------------------------------ *
 * Capa de subtítulos karaoke (remotion/Captions.tsx)
 * ------------------------------------------------------------------ */

/** Tamaño de fuente de los captions, en píxeles (a PROXY_HEIGHT). */
export const CAPTION_FONT_SIZE = 54;

/** Grosor del contorno negro del texto de los captions, en píxeles. */
export const CAPTION_OUTLINE_PX = 4;

/** Centro vertical del bloque de captions, como fracción de la altura del frame. */
export const CAPTION_CENTER_Y = 0.84;

/** Color del bloque de resalte karaoke de la palabra activa (reusa la marca). */
export const CAPTION_HIGHLIGHT = BRAND_GREEN;

/** Sombra suave detrás del texto de los captions. */
export const CAPTION_SHADOW = { blur: 10, opacity: 0.55, offsetY: 4 };

/* ------------------------------------------------------------------ *
 * Capa de overlays didácticos (remotion/Overlays.tsx)
 * ------------------------------------------------------------------ */

/**
 * Posición horizontal del centro del overlay, como fracción del ancho del
 * frame. Anclado a la izquierda (0.25, no al centro) para no taparle la cara
 * al presentador, que suele estar centrado/a la derecha en los proxies.
 */
export const OVERLAY_ANCHOR_X = 0.25;

/** Posición vertical del centro del overlay, como fracción del alto del frame. */
export const OVERLAY_ANCHOR_Y = 0.42;

/** Ancho del overlay "cuadrado" (aspect >= 0.6), como fracción del ancho del frame. */
export const OVERLAY_WIDTH = 0.34;

/** Ancho del overlay "ancho" (aspect < 0.6, ej. 16:9), como fracción del ancho del frame. */
export const OVERLAY_WIDTH_WIDE = 0.44;

/** Duración del fade in/out de un overlay, en frames. */
export const OVERLAY_FADE_FRAMES = 8;

/** Duración fija en pantalla de un overlay, en segundos (etapa 11, overlays-timeline-stage.ts). */
export const OVERLAY_DISPLAY_SECONDS = 8;
