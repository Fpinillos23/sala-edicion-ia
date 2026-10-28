import "./fuentes";
import { Composition } from "remotion";
import { Rotulo, Simple, Tarjeta, Titular } from "./Graficos";
import { esquema, metadatos } from "./props";

// Gráficos animados de Sonny Quinn. Titular, Rótulo y Simple se exportan con transparencia (ProRes 4444) para ponerlos sobre el video.
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Titular"
        component={Titular}
        schema={esquema}
        calculateMetadata={metadatos}
        durationInFrames={120}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{ texto: "Festival Vallenato", subtexto: "", color: "#E30613", medio: "Torre Informativa", posicion: "arriba", ancho: 1080, alto: 1920, segundos: 4 }}
      />
      <Composition
        id="Rotulo"
        component={Rotulo}
        schema={esquema}
        calculateMetadata={metadatos}
        durationInFrames={120}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{ texto: "Nombre Apellido", subtexto: "Cargo o fuente", color: "#E30613", medio: "Torre Informativa", posicion: "abajo", ancho: 1080, alto: 1920, segundos: 4 }}
      />
      <Composition
        id="Simple"
        component={Simple}
        schema={esquema}
        calculateMetadata={metadatos}
        durationInFrames={120}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{ texto: "Texto en pantalla", subtexto: "", color: "#E30613", medio: "Torre Informativa", posicion: "centro", ancho: 1080, alto: 1920, segundos: 4 }}
      />
      <Composition
        id="Tarjeta"
        component={Tarjeta}
        schema={esquema}
        calculateMetadata={metadatos}
        durationInFrames={90}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{ texto: "Festival Vallenato", subtexto: "", color: "#E30613", medio: "Torre Informativa", posicion: "centro", ancho: 1080, alto: 1920, segundos: 3 }}
      />
    </>
  );
};
