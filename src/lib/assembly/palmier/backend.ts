/**
 * assembly/palmier/backend.ts — STUB del backend de refinamiento manual.
 *
 * NO está implementado a propósito. Existe para que el modo de refinamiento
 * manual futuro encaje sin tocar nada del resto del sistema: cuando llegue,
 * lo único que hay que escribir son los dos métodos de abajo. Todo lo demás
 * (planner, verificación, progreso, job.json, API, UI) ya es común a los dos
 * backends y no distingue cuál corrió.
 *
 * Lo que ya está garantizado por el contrato cuando se implemente:
 *  - Recibe el MISMO LessonAssemblyPlan que Remotion (mismos proxies, mismos
 *    tramos "keep", misma duración esperada). No re-lee plan/ ni recalcula
 *    cortes.
 *  - Debe escribir en `plan.outputPath` pasando por verifyAndCommit() de
 *    assembly/verify.ts, para que "completo" signifique exactamente lo mismo
 *    que en Remotion.
 */
import type {
  AssemblyBackend,
  IntroRenderInput,
  LessonAssemblyPlan,
} from "../types";

/** Error único del stub, para que el fallo sea inconfundible y accionable. */
function notImplemented(what: string): never {
  throw new Error(
    `El backend de ensamblaje "palmier" todavía no está implementado (${what}). Usá ASSEMBLY_BACKEND=remotion.`
  );
}

export const palmierBackend: AssemblyBackend = {
  name: "palmier",

  async isAvailable() {
    return {
      ok: false,
      reason:
        'El backend "palmier" es un stub reservado para el modo de refinamiento manual. Usá ASSEMBLY_BACKEND=remotion.',
    };
  },

  async renderIntro(_input: IntroRenderInput) {
    notImplemented("renderIntro");
  },

  async assembleLesson(_plan: LessonAssemblyPlan) {
    notImplemented("assembleLesson");
  },
};
