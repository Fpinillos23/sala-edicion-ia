"use client";

import { useEffect, useRef, useState } from "react";

type Agente = { nombre?: string; alias?: string; rol?: string; estado?: string; linea?: string; t?: number };
type Mision = { codigo: string; etapa: number; etapaNombre?: string; inicio?: number; fin?: number | null };
type Estado = {
  ok?: boolean;
  demo?: boolean;
  medio?: string;
  agentes: Record<string, Agente>;
  mision: Mision | null;
  etapas?: string[];
  bitacora: { t: number; a: string; x: string }[];
  stats?: { reels?: number; minutos?: number[] };
  actualizado?: number;
  version?: string;
};

const ETAPAS = ["Recepción", "Inteligencia", "Instrucción", "Plan o guion", "Aprobación", "Edición", "Entregado"];
const ORDEN = ["mando", "jason", "lisa", "mandy", "sonny", "ray"] as const;
const BASE: Record<string, Agente> = {
  mando: { nombre: "Mando", alias: "Comandante", rol: "Aprueba cada misión" },
  jason: { nombre: "Jason Hayes", alias: "Bravo 1", rol: "Coordina y arma el plan de edición" },
  lisa: { nombre: "Lisa Davis", alias: "Inteligencia", rol: "Transcribe el material" },
  mandy: { nombre: "Mandy Ellis", alias: "Enlace", rol: "Guion de reels de entrevistas" },
  sonny: { nombre: "Sonny Quinn", alias: "Bravo 3", rol: "Edita y entrega el video" },
  ray: { nombre: "Ray Perry", alias: "Bravo 2", rol: "Control de calidad" },
};
const ROTULO: Record<string, string> = { espera: "En posición", trabajando: "En operación", listo: "Cumplido", alerta: "Alerta" };
const ZONA = { timeZone: "America/Bogota", hour12: false } as const;

const dia = (t: number) => new Date(t).toLocaleDateString("es-CO", { timeZone: ZONA.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
const fecha = (t: number) => new Date(t).toLocaleDateString("es-CO", { timeZone: ZONA.timeZone, day: "2-digit", month: "2-digit" });
// Hora sola si es de hoy; si no, con la fecha ("29/10 17:13"), para no confundir lo de ayer con lo de hoy
const hhmm = (t: number, ahora = Date.now()) => {
  const h = new Date(t).toLocaleTimeString("es-CO", { ...ZONA, hour: "2-digit", minute: "2-digit" });
  return dia(t) === dia(ahora) ? h : `${fecha(t)} ${h}`;
};
const hace = (t: number, ahora: number) => {
  const s = Math.max(0, Math.round((ahora - t) / 1000));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return dia(t) === dia(ahora) ? `a las ${hhmm(t, ahora)}` : `el ${hhmm(t, ahora)}`;
};
const reloj = (seg: number) => {
  const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60), s = seg % 60;
  const dos = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${dos(m)}:${dos(s)}` : `${dos(m)}:${dos(s)}`;
};

const VACIO: Estado = { agentes: {}, bitacora: [], mision: null };

// Misión de ejemplo para cuando la sala no tiene conexión configurada.
const GUION_DEMO: [string, string, string, number][] = [
  ["jason", "trabajando", "Material recibido. Esperando la orden del mando.", 1],
  ["jason", "trabajando", "Traduciendo la orden del mando a un plan.", 4],
  ["mando", "trabajando", "Revisando el plan de edición.", 5],
  ["mando", "listo", "Plan aprobado. Luz verde para Bravo 3.", 6],
  ["sonny", "trabajando", "Retocando las imágenes (luz y color naturales)", 6],
  ["sonny", "trabajando", "Animando titulares y rótulos (Remotion)", 6],
  ["sonny", "trabajando", "Montando la versión final", 6],
  ["ray", "trabajando", "Revisando el video antes de entregarlo", 6],
  ["ray", "listo", "Revisión sin problemas.", 7],
  ["sonny", "listo", "Reel entregado. Misión cumplida.", 7],
];

export default function Sala() {
  const [d, setD] = useState<Estado>(VACIO);
  const [enlace, setEnlace] = useState<{ modo: "vivo" | "demo" | "caido"; txt: string }>({ modo: "demo", txt: "Conectando" });
  const [ahora, setAhora] = useState(() => Date.now());
  const demo = useRef<number | null>(null);

  useEffect(() => {
    const reloj = setInterval(() => setAhora(Date.now()), 1000);
    let vivo = true;

    function iniciarDemo() {
      if (demo.current) return;
      setEnlace({ modo: "demo", txt: "Demostración" });
      let i = 0;
      let inicio = Date.now();
      const e: Estado = { ok: true, medio: "Torre Informativa", agentes: {}, bitacora: [], stats: { reels: 12, minutos: [14, 9, 22] }, mision: null };
      const paso = () => {
        if (i >= GUION_DEMO.length) { i = 0; inicio = Date.now(); e.agentes = {}; e.bitacora = []; e.stats = { reels: (e.stats?.reels || 0) + 1 }; }
        const [a, est, x, et] = GUION_DEMO[i++];
        const t = Date.now();
        e.agentes = { ...e.agentes, [a]: { estado: est, linea: x, t } };
        e.bitacora = [{ t, a, x }, ...e.bitacora];
        e.mision = { codigo: "Operación Guatapurí-07", etapa: et, etapaNombre: ETAPAS[et - 1], inicio };
        e.actualizado = t;
        setD({ ...e });
      };
      paso(); paso(); paso();
      demo.current = window.setInterval(paso, 3200);
    }

    async function consultar() {
      try {
        const r = await fetch("/api/sala", { cache: "no-store" });
        const x = (await r.json()) as Estado;
        if (!vivo) return;
        if (x.demo) return iniciarDemo();
        if (!x.ok) throw new Error("sin datos");
        setD(x);
        setEnlace({ modo: "vivo", txt: "En vivo" });
      } catch {
        if (vivo && !demo.current) setEnlace({ modo: "caido", txt: "Sin señal, reintentando" });
      }
    }

    consultar();
    const sondeo = setInterval(consultar, 5000);
    return () => {
      vivo = false;
      clearInterval(reloj);
      clearInterval(sondeo);
      if (demo.current) clearInterval(demo.current);
    };
  }, []);

  const m = d.mision;
  const etapa = m ? m.etapa || 0 : 0;
  const etapas = d.etapas && d.etapas.length > 1 ? d.etapas.slice(1) : ETAPAS;
  const entregada = !!m && etapa >= etapas.length;
  // Al entregar, el reloj se detiene: muestra cuánto duró la misión
  const finMision = entregada ? (m && m.fin) || (d.bitacora[0] && d.bitacora[0].t) || d.actualizado || ahora : ahora;
  const transcurrido = m && m.inicio ? Math.max(0, Math.floor((finMision - m.inicio) / 1000)) : null;
  const minutos = (d.stats?.minutos || []).filter((x) => x > 0);
  const promedio = minutos.length ? Math.round(minutos.reduce((a, b) => a + b, 0) / minutos.length) : null;
  // Un agente que no ha trabajado en esta misión, o que quedó "en operación" cuando ya se entregó, está en posición
  const vigente = (a: Agente): Agente => {
    if (m && m.inicio && a.t && a.t < m.inicio - 60000) return { ...a, estado: "espera", linea: "En posición.", t: undefined };
    if (entregada && a.estado === "trabajando") return { ...a, estado: "espera", linea: "En posición.", t: undefined };
    return a;
  };

  return (
    <div className="marco">
      <header className="barra">
        <div className="marca">
          <h1>Centro de Operaciones Bravo</h1>
          <span>Sala de Edición IA{d.medio ? ` · ${d.medio}` : ""}</span>
        </div>
        <div className="instrumentos">
          <span className="enlace" data-modo={enlace.modo}><i />{enlace.txt}</span>
          <span title="Hora de Colombia" suppressHydrationWarning>
            {new Date(ahora).toLocaleTimeString("es-CO", { ...ZONA, hour: "2-digit", minute: "2-digit", second: "2-digit" })} COT
          </span>
        </div>
      </header>

      <section className="mision" aria-label="Misión en curso">
        <div>
          <small>{m ? (entregada ? `Última misión · entregada ${hace(finMision, ahora)}` : `Misión en curso · ${m.etapaNombre || etapas[etapa - 1] || ""}`) : "Esperando material"}</small>
          <p className="codigo">{m ? m.codigo : "Sin misión activa"}</p>
        </div>
        <div className="reloj-mision">
          {entregada ? "Duración de la misión" : "Tiempo en operación"}
          <b>{transcurrido === null ? "--:--" : reloj(transcurrido)}</b>
        </div>
        <ol className="etapas" aria-label="Etapas de la misión">
          {etapas.map((n, i) => {
            const c = i + 1 < etapa ? "hecha" : i + 1 === etapa ? "actual" : "";
            return <li key={n} className={c} aria-current={c === "actual" ? "step" : undefined}>{n}</li>;
          })}
        </ol>
      </section>

      <div className="cuerpo">
        <section className="puestos" aria-label="Operadores">
          {ORDEN.map((k) => {
            const a = vigente({ ...BASE[k], ...(d.agentes[k] || {}) });
            const e = a.estado && ROTULO[a.estado] ? a.estado : "espera";
            return (
              <article key={k} className="puesto" data-estado={e}>
                <div className="cab"><span className="indicativo">{a.alias}</span><span className="pill" data-e={e}>{ROTULO[e]}</span></div>
                <div><h3>{a.nombre}</h3><p className="rol">{a.rol}</p></div>
                <p className="linea">
                  {a.linea || "En posición."}
                  {a.t ? <time>{hace(a.t, ahora)}</time> : null}
                </p>
              </article>
            );
          })}
        </section>

        <aside className="radio" aria-label="Bitácora de radio">
          <header><h2>Radio · Bitácora</h2><span>{d.actualizado ? `act. ${hhmm(d.actualizado, ahora)}` : "—"}</span></header>
          <ol className="log">
            {d.bitacora.length ? d.bitacora.map((x, i) => (
              <li key={`${x.t}-${i}`}>
                <time>{hhmm(x.t, ahora)}</time>
                <div><b>{BASE[x.a]?.nombre || x.a}</b><p>{x.x}</p></div>
              </li>
            )) : <li className="vacio">Sin transmisiones todavía. La bitácora se llena cuando llega material.</li>}
          </ol>
          <div className="cifras">
            <div><b>{d.stats?.reels || 0}</b>Videos entregados</div>
            {promedio !== null
              ? <div><b>{promedio}<small> min</small></b>Promedio por misión</div>
              : <div><b>{String(etapa).padStart(2, "0")}</b>Etapa actual</div>}
          </div>
        </aside>
      </div>

      <footer className="pie">
        <span>Torre Informativa · Valledupar</span>
        <span>Solo se muestran códigos y estados. Ningún contenido de las misiones es público.</span>
        {d.version ? <span className="version">Código {d.version}</span> : null}
      </footer>
    </div>
  );
}
