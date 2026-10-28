import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

// Fuente local (SIL Open Font License): no depende de descargar nada al renderizar.
export const FUENTE = "Barlow Semi Condensed";

loadFont({ family: FUENTE, url: staticFile("barlow-semi-condensed-latin-600-normal.woff2"), weight: "600" });
loadFont({ family: FUENTE, url: staticFile("barlow-semi-condensed-latin-800-normal.woff2"), weight: "800" });
