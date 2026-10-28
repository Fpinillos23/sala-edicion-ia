import { z } from "zod";
import { CalculateMetadataFunction } from "remotion";

export const esquema = z.object({
  texto: z.string(),
  subtexto: z.string(),
  color: z.string(),
  medio: z.string(),
  posicion: z.enum(["arriba", "centro", "abajo"]),
  ancho: z.number(),
  alto: z.number(),
  segundos: z.number(),
});

export type Props = z.infer<typeof esquema>;

// Sonny envía el tamaño del video y la duración del gráfico como props.
export const metadatos: CalculateMetadataFunction<Props> = ({ props }) => ({
  width: Math.round(props.ancho / 2) * 2,
  height: Math.round(props.alto / 2) * 2,
  durationInFrames: Math.max(15, Math.round(props.segundos * 30)),
});
