import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { FUENTE } from "./fuentes";
import { Props } from "./props";

const sale = (frame: number, total: number, fps: number) =>
  interpolate(frame, [total - 0.45 * fps, total], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

const vertical = (posicion: Props["posicion"]): React.CSSProperties =>
  posicion === "centro" ? { justifyContent: "center" } : posicion === "abajo" ? { justifyContent: "flex-end" } : { justifyContent: "flex-start" };

/** Titular: barra del color del medio que entra barriendo desde la izquierda. Fondo transparente. */
export const Titular: React.FC<Props> = ({ texto, color, posicion }) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const k = width / 1080;
  return (
    <AbsoluteFill style={{ ...vertical(posicion), alignItems: "center", paddingTop: height * 0.11, paddingBottom: height * 0.16, paddingLeft: 80 * k, paddingRight: 80 * k }}>
      <div
        style={{
          backgroundColor: color,
          padding: `${18 * k}px ${34 * k}px`,
          clipPath: `inset(0 ${interpolate(frame, [0, 0.5 * fps], [100, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) })}% 0 0)`,
          opacity: sale(frame, durationInFrames, fps),
          boxShadow: `0 ${10 * k}px ${30 * k}px rgba(0,0,0,0.35)`,
        }}
      >
        <div
          style={{
            fontFamily: FUENTE,
            fontWeight: 800,
            fontSize: 84 * k,
            lineHeight: 1.05,
            color: "white",
            textTransform: "uppercase",
            textAlign: "center",
            textWrap: "balance",
            translate: interpolate(frame, [0.15 * fps, 0.6 * fps], [`0px ${30 * k}px`, "0px 0px"], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) }),
            opacity: interpolate(frame, [0.15 * fps, 0.5 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}
        >
          {texto}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** Rótulo (generador de caracteres): nombre y cargo o fuente sobre una banda oscura con filete de color. */
export const Rotulo: React.FC<Props> = ({ texto, subtexto, color, posicion }) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const k = width / 1080;
  return (
    <AbsoluteFill style={{ ...vertical(posicion === "arriba" ? "arriba" : posicion === "centro" ? "centro" : "abajo"), alignItems: "flex-start", paddingLeft: 80 * k, paddingRight: 80 * k, paddingTop: height * 0.12, paddingBottom: height * (height > width ? 0.24 : 0.12) }}>
      <div
        style={{
          display: "flex",
          opacity: sale(frame, durationInFrames, fps),
          translate: interpolate(frame, [0, 0.5 * fps], [`${-60 * k}px 0px`, "0px 0px"], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) }),
        }}
      >
        <div style={{ width: 12 * k, backgroundColor: color, scale: `1 ${interpolate(frame, [0, 0.35 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })}` }} />
        <div
          style={{
            backgroundColor: "rgba(12,14,16,0.82)",
            padding: `${16 * k}px ${28 * k}px`,
            clipPath: `inset(0 ${interpolate(frame, [0.1 * fps, 0.6 * fps], [100, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) })}% 0 0)`,
          }}
        >
          <div style={{ fontFamily: FUENTE, fontWeight: 800, fontSize: 58 * k, lineHeight: 1.1, color: "white" }}>{texto}</div>
          {subtexto ? <div style={{ fontFamily: FUENTE, fontWeight: 600, fontSize: 44 * k, lineHeight: 1.2, color: "rgba(255,255,255,0.82)" }}>{subtexto}</div> : null}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** Texto simple: letra blanca con sombra que sube suavemente. */
export const Simple: React.FC<Props> = ({ texto, posicion }) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();
  const k = width / 1080;
  return (
    <AbsoluteFill style={{ ...vertical(posicion), alignItems: "center", padding: `${height * 0.12}px ${80 * k}px` }}>
      <div
        style={{
          fontFamily: FUENTE, fontWeight: 800, fontSize: 72 * k, lineHeight: 1.1, color: "white", textAlign: "center", textWrap: "balance",
          textShadow: `0 ${4 * k}px ${18 * k}px rgba(0,0,0,0.75)`,
          opacity: interpolate(frame, [0, 0.4 * fps, durationInFrames - 0.4 * fps, durationInFrames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          translate: interpolate(frame, [0, 0.5 * fps], [`0px ${24 * k}px`, "0px 0px"], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) }),
        }}
      >
        {texto}
      </div>
    </AbsoluteFill>
  );
};

/** Intro o cierre: tarjeta completa con el titular (o el nombre del medio) y la firma del medio. */
export const Tarjeta: React.FC<Props> = ({ texto, subtexto, color, medio }) => {
  const frame = useCurrentFrame();
  const { fps, width, durationInFrames } = useVideoConfig();
  const k = width / 1080;
  return (
    <AbsoluteFill style={{ backgroundColor: "#0E1114", justifyContent: "center", alignItems: "center", padding: 80 * k }}>
      <AbsoluteFill style={{ backgroundColor: color, scale: `${interpolate(frame, [0, 0.6 * fps], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.65, 0, 0.35, 1) })} 1`, transformOrigin: "left center", opacity: 0.16 }} />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 28 * k, opacity: interpolate(frame, [0, 0.3 * fps, durationInFrames - 0.35 * fps, durationInFrames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }}>
        <div style={{ width: interpolate(frame, [0.1 * fps, 0.7 * fps], [0, 160 * k], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) }), height: 10 * k, backgroundColor: color }} />
        <div
          style={{
            fontFamily: FUENTE, fontWeight: 800, fontSize: 96 * k, lineHeight: 1.02, color: "white", textAlign: "center", textTransform: "uppercase", textWrap: "balance",
            translate: interpolate(frame, [0.2 * fps, 0.8 * fps], [`0px ${40 * k}px`, "0px 0px"], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.bezier(0.16, 1, 0.3, 1) }),
          }}
        >
          {texto || medio}
        </div>
        {subtexto ? <div style={{ fontFamily: FUENTE, fontWeight: 600, fontSize: 46 * k, color: "rgba(255,255,255,0.8)", textAlign: "center" }}>{subtexto}</div> : null}
        {texto ? <div style={{ fontFamily: FUENTE, fontWeight: 600, fontSize: 44 * k, letterSpacing: `${0.12 * k}em`, color, textTransform: "uppercase", marginTop: 20 * k }}>{medio}</div> : null}
      </div>
    </AbsoluteFill>
  );
};
