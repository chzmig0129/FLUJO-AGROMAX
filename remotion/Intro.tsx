/**
 * Intro.tsx — composición del intro de una clase (etapa 9).
 *
 * Es 100% determinista: mismas props ⇒ mismos píxeles. No hay modelo, no hay
 * aleatoriedad, no hay fecha actual. Las animaciones dependen solo de
 * useCurrentFrame(), así que un re-render produce el mismo archivo.
 *
 * Marca de la plataforma: verde #22C55E / #16A34A sobre fondo oscuro, con
 * tipografía Poppins cargada desde los .ttf versionados en remotion/fonts/
 * (ver fonts/poppins.ts: sin red de por medio, con stack de respaldo).
 */
import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { IntroProps } from "../src/lib/assembly/types";
// Los colores de marca viven en src/lib/constants.ts junto al resto de las
// constantes del pipeline, para no tener dos paletas que se puedan separar.
import {
  BRAND_GREEN,
  BRAND_GREEN_DARK,
  BRAND_INK,
} from "../src/lib/constants";
import { ensurePoppinsLoaded, FONT_FAMILY } from "./fonts/poppins";

export const Intro: React.FC<IntroProps> = ({
  title,
  moduleLabel,
  kicker,
  subtitle,
}) => {
  // Debe llamarse en el cuerpo del componente (no en un efecto) para que el
  // render espere a la fuente antes de capturar el frame 0.
  ensurePoppinsLoaded();

  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // Entrada: cada bloque de texto sube y aparece con un spring escalonado.
  const enter = (delay: number) =>
    spring({ frame: frame - delay, fps, config: { damping: 200 } });

  // Salida: fundido a negro en el último medio segundo, para que el corte al
  // primer frame de la clase no sea un salto brusco.
  const fadeOut = interpolate(
    frame,
    [durationInFrames - fps * 0.5, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const kickerIn = enter(0);
  const labelIn = enter(6);
  const titleIn = enter(12);
  const subtitleIn = enter(20);
  const ruleIn = enter(16);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: BRAND_INK,
        fontFamily: FONT_FAMILY,
        opacity: fadeOut,
      }}
    >
      {/* Halo verde de marca, desplazado hacia la esquina superior derecha. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 78% 18%, ${BRAND_GREEN_DARK}55 0%, transparent 55%)`,
        }}
      />

      {/* Barra vertical de acento a la izquierda del bloque de texto. */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          paddingLeft: 160,
          paddingRight: 160,
        }}
      >
        <div style={{ display: "flex", gap: 48, alignItems: "stretch" }}>
          <div
            style={{
              width: 10,
              borderRadius: 5,
              background: `linear-gradient(180deg, ${BRAND_GREEN} 0%, ${BRAND_GREEN_DARK} 100%)`,
              transform: `scaleY(${ruleIn})`,
              transformOrigin: "top",
            }}
          />

          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div
              style={{
                color: BRAND_GREEN,
                fontSize: 30,
                fontWeight: 600,
                letterSpacing: 6,
                textTransform: "uppercase",
                opacity: kickerIn,
                transform: `translateY(${(1 - kickerIn) * 24}px)`,
              }}
            >
              {kicker}
            </div>

            <div
              style={{
                color: "#FFFFFF99",
                fontSize: 26,
                fontWeight: 500,
                letterSpacing: 4,
                opacity: labelIn,
                transform: `translateY(${(1 - labelIn) * 24}px)`,
              }}
            >
              {moduleLabel}
            </div>

            <div
              style={{
                color: "#FFFFFF",
                fontSize: 92,
                fontWeight: 700,
                lineHeight: 1.05,
                maxWidth: 1240,
                opacity: titleIn,
                transform: `translateY(${(1 - titleIn) * 32}px)`,
              }}
            >
              {title}
            </div>

            {subtitle ? (
              <div
                style={{
                  color: "#FFFFFFB0",
                  fontSize: 34,
                  fontWeight: 400,
                  maxWidth: 1100,
                  opacity: subtitleIn,
                  transform: `translateY(${(1 - subtitleIn) * 24}px)`,
                }}
              >
                {subtitle}
              </div>
            ) : null}
          </div>
        </div>
      </AbsoluteFill>

      {/* Línea de marca al pie. */}
      <AbsoluteFill style={{ justifyContent: "flex-end" }}>
        <div
          style={{
            height: 12,
            background: `linear-gradient(90deg, ${BRAND_GREEN} 0%, ${BRAND_GREEN_DARK} 100%)`,
            transform: `scaleX(${enter(4)})`,
            transformOrigin: "left",
          }}
        />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
