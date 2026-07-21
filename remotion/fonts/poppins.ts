/**
 * poppins.ts — carga de la tipografía de la plataforma para los renders.
 *
 * Los .ttf están VERSIONADOS en el repo (remotion/fonts/) en vez de pedirse a
 * Google Fonts en tiempo de render, por dos razones que importan en un
 * pipeline headless:
 *
 *  - Determinismo: el mismo intro se ve igual hoy y dentro de un año, sin
 *    depender de qué versión sirva el CDN.
 *  - Robustez: un servidor de render sin salida a internet (o con Google
 *    caído) no puede quedarse esperando una fuente. @remotion/google-fonts
 *    bloquea el render con delayRender y lo hace fallar a los 60s; esto no.
 *
 * Poppins está bajo SIL Open Font License, así que distribuirla dentro del
 * proyecto es válido.
 *
 * POR QUÉ LA CARGA ES PEREZOSA (y no un side-effect del módulo):
 * la composición del ensamblaje (Lesson) NO dibuja texto — inserta el intro
 * ya renderizado como un video más. Si la fuente se cargara al importar el
 * módulo, cada pestaña de un render de clase pediría los .ttf al servidor del
 * bundle mientras ese mismo servidor está entregando proxies de video a
 * decenas de pestañas; ese pedido se encola detrás de las descargas de video
 * y el delayRender interno de @remotion/fonts revienta a los 28s, tumbando
 * ensamblajes enteros (verificado en la práctica). Cargándola solo cuando el
 * componente Intro se dibuja, el pedido ocurre en renders cortos y sin
 * contención.
 */
import { loadFont } from "@remotion/fonts";
import { continueRender, delayRender } from "remotion";
import regular from "./Poppins-Regular.ttf";
import semiBold from "./Poppins-SemiBold.ttf";
import bold from "./Poppins-Bold.ttf";

/** Familia a usar en los estilos, con fallbacks por si la carga fallara. */
export const FONT_FAMILY =
  "Poppins, Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif";

/**
 * Tiempo máximo que el render espera por las fuentes antes de seguir con el
 * stack de respaldo. Preferimos un intro con la tipografía de respaldo antes
 * que un render abortado.
 */
const FONT_LOAD_TIMEOUT_MS = 10_000;

/** Garantiza que la carga se dispare UNA sola vez por pestaña de render. */
let started = false;

/**
 * Registra Poppins en la pestaña actual, bloqueando el render hasta que esté
 * lista (o hasta FONT_LOAD_TIMEOUT_MS). Llamar desde el cuerpo del componente
 * que la usa: en un efecto sería tarde, el primer frame ya habría salido con
 * la fuente de respaldo.
 */
export function ensurePoppinsLoaded(): void {
  if (started) return;
  started = true;

  const handle = delayRender("Cargando Poppins", {
    timeoutInMilliseconds: 120_000,
  });

  const loaded = Promise.all([
    loadFont({ family: "Poppins", url: regular, weight: "400" }),
    loadFont({ family: "Poppins", url: semiBold, weight: "600" }),
    loadFont({ family: "Poppins", url: bold, weight: "700" }),
  ]);

  const deadline = new Promise<void>((resolve) => {
    setTimeout(resolve, FONT_LOAD_TIMEOUT_MS);
  });

  Promise.race([loaded, deadline])
    .then(() => continueRender(handle))
    // Una fuente que no carga NO debe tumbar el render.
    .catch(() => continueRender(handle));
}
