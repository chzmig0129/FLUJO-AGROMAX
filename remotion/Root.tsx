/**
 * Root.tsx — registro de las composiciones de Remotion.
 *
 * Solo hay dos, y son deliberadamente "tontas": reciben todo por inputProps
 * desde el backend (src/lib/assembly/remotion). Ninguna lee del filesystem
 * del job ni sabe qué es un job: eso es responsabilidad del planner.
 *
 *  - "Intro"  → etapa 9, un render por clase, duración fija.
 *  - "Lesson" → etapa 11, un render por clase. Su duración NO es fija: se
 *    calcula con calculateMetadata a partir de las props (intro + suma de
 *    los tramos keep), que es exactamente el expectedFrames del plan.
 */
import React from "react";
import { Composition } from "remotion";
import { Intro } from "./Intro";
import { Lesson } from "./Lesson";
import type {
  IntroProps,
  LessonCompositionProps,
} from "../src/lib/assembly/types";

const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const INTRO_DURATION_FRAMES = 150;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Intro"
        component={Intro}
        durationInFrames={INTRO_DURATION_FRAMES}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={
          {
            title: "Título de la clase",
            moduleLabel: "MÓDULO 1 · CLASE 1",
            kicker: "Curso AgroMax",
            subtitle: "",
          } satisfies IntroProps
        }
      />

      <Composition
        id="Lesson"
        component={Lesson}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        // Duración derivada de las props: intro + Σ(endFrame - startFrame).
        // Debe coincidir con plan.expectedFrames; si no coincidiera, la
        // verificación por conteo de paquetes lo detectaría.
        calculateMetadata={({ props }) => {
          const keepFrames = props.entries.reduce(
            (sum, entry) => sum + (entry.endFrame - entry.startFrame),
            0
          );
          const introFrames = props.introSrc ? props.introDurationInFrames : 0;
          return {
            durationInFrames: Math.max(1, introFrames + keepFrames),
          };
        }}
        defaultProps={
          {
            introSrc: null,
            introDurationInFrames: INTRO_DURATION_FRAMES,
            entries: [],
            captions: [],
          } satisfies LessonCompositionProps
        }
      />
    </>
  );
};
