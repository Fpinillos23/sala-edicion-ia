"use client";

import { useEffect, useRef, useState } from "react";

type Agente = { nombre?: string; alias?: string; rol?: string; estado?: string; linea?: string; t?: number };
type Mision = { codigo: string; etapa: number; etapaNombre?: string; inicio?: number; fin?: number | null };
type Bitacora = { t: number; a: string; x: string }[];
type Fotografia = {
  instalado?: boolean;
  agentes: Record<string, Agente>;
  mision: Mision | null;
  etapas?: string[];
  bitacora: Bitacora;
  stats?: { fotos?: number; misiones?: number; minutos?: number[] };
  actualizado?: number | null;
};
type Estado = {
  ok?: boolean;
  demo?: boolean;
  medio?: string;
  agentes: Record<string, Agente>;
  mision: Mision | null;
  etapas?: string[];
  bitacora: Bitacora;
  stats?: { reels?: number; minutos?: number[] };
  actualizado?: number;
  version?: string;
  fotografia?: Fotografia | null;
};
type Depto = "video" | "foto";

const ETAPAS_VIDEO = ["Recepción", "Inteligencia", "Instrucción", "Plan o guion", "Aprobación", "Edición", "Entregado"];
const ETAPAS_FOTO = ["Planificación", "Recepción", "Plan", "Selección", "Edición", "Control", "Aprobación", "Entregado"];
const ORDEN_VIDEO = ["jason", "lisa", "mandy", "sonny", "ray"] as const;
const ORDEN_FOTO = ["trent", "clay", "brock", "eric"] as const;
const BASE: Record<string, Agente> = {
  mando: { nombre: "Mando", alias: "Comandante", rol: "Aprueba en los dos departamentos" },
  jason: { nombre: "Jason Hayes", alias: "Bravo 1", rol: "Coordina y arma el plan de edición" },
  lisa: { nombre: "Lisa Davis", alias: "Inteligencia", rol: "Transcribe el material" },
  mandy: { nombre: "Mandy Ellis", alias: "Enlace", rol: "Guion de reels de entrevistas" },
  sonny: { nombre: "Sonny Quinn", alias: "Bravo 3", rol: "Edita y entrega el video" },
  ray: { nombre: "Ray Perry", alias: "Bravo 2", rol: "Control de calidad del video" },
  trent: { nombre: "Trent Sawyer", alias: "Bravo 4", rol: "Planifica la sesión y arma el plan" },
  clay: { nombre: "Clay Spenser", alias: "Bravo 6", rol: "Selecciona las mejores fotos" },
  brock: { nombre: "Brock Reynolds", alias: "Bravo 5", rol: "Edita y retoca las fotos" },
  eric: { nombre: "Eric Blackburn", alias: "Bravo Actual", rol: "Control de calidad de las fotos" },
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
const promedio = (xs?: number[]) => {
  const v = (xs || []).filter((x) => x > 0);
  return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
};

const VACIO: Estado = { agentes: {}, bitacora: [], mision: null };

// Demostración: los dos departamentos trabajan a la vez cuando la sala no tiene conexión configurada.
const GUION_DEMO: [Depto, string, string, string, number][] = [
  ["video", "jason", "trabajando", "Material recibido. Esperando la orden del mando.", 1],
  ["foto", "trent", "trabajando", "Recibiendo material: 48 fotos.", 2],
  ["video", "jason", "trabajando", "Traduciendo la orden del mando a un plan.", 4],
  ["foto", "trent", "listo", "Plan listo. Esperando luz verde.", 3],
  ["video", "mando", "listo", "Plan aprobado. Luz verde para Bravo 3.", 6],
  ["foto", "clay", "trabajando", "Mirando composición y momento: lote 2 de 5", 4],
  ["video", "sonny", "trabajando", "Animando titulares y rótulos (Remotion)", 6],
  ["foto", "clay", "listo", "Selección entregada: 8 de 48.", 4],
  ["foto", "mando", "listo", "Selección aprobada.", 5],
  ["foto", "brock", "trabajando", "Revelando la foto 3 de 8", 5],
  ["video", "ray", "trabajando", "Revisando el video antes de entregarlo", 6],
  ["foto", "eric", "trabajando", "Revisando la foto 3 de 8 (4:5)", 6],
  ["video", "sonny", "listo", "Reel entregado. Misión cumplida.", 7],
  ["foto", "eric", "listo", "Control de calidad sin problemas.", 7],
  ["foto", "trent", "listo", "Fotos entregadas. Misión cumplida.", 8],
];

export default function Sala() {
  const [d, setD] = useState<Estado>(VACIO);
  const [enlace, setEnlace] = useState<{ modo: "vivo" | "demo" | "caido"; txt: string }>({ modo: "demo", txt: "Conectando" });
  const [ahora, setAhora] = useState(() => Date.now());
  const demo = useRef<number | null>(null);

  useEffect(() => {
    const tic = setInterval(() => setAhora(Date.now()), 1000);
    let vivo = true;

    function iniciarDemo() {
      if (demo.current) return;
      setEnlace({ modo: "demo", txt: "Demostración" });
      let i = 0;
      let inicio = Date.now();
      const nuevaFoto = (): Fotografia => ({ instalado: true, agentes: {}, mision: null, bitacora: [], stats: { fotos: 64, misiones: 9, minutos: [18, 25, 12] } });
      const e: Estado = { ok: true, medio: "Torre Informativa", agentes: {}, bitacora: [], stats: { reels: 12, minutos: [14, 9, 22] }, mision: null, fotografia: nuevaFoto() };
      const paso = () => {
        if (i >= GUION_DEMO.length) { i = 0; inicio = Date.now(); e.agentes = {}; e.bitacora = []; e.fotografia = nuevaFoto(); }
        const [dep, a, est, x, et] = GUION_DEMO[i++];
        const t = Date.now();
        if (dep === "video" || a === "mando") e.agentes = { ...e.agentes, [a]: { estado: est, linea: x, t } };
        if (dep === "video") {
          e.bitacora = [{ t, a, x }, ...e.bitacora];
          if (a !== "mando") e.mision = { codigo: "Operación Guatapurí-07", etapa: et, etapaNombre: ETAPAS_VIDEO[et - 1], inicio };
        } else {
          const f = e.fotografia as Fotografia;
          f.agentes = { ...f.agentes, [a]: { estado: est, linea: x, t } };
          f.bitacora = [{ t, a, x }, ...f.bitacora];
          if (a !== "mando") f.mision = { codigo: "Operación Diafragma-03", etapa: et, etapaNombre: ETAPAS_FOTO[et - 1], inicio: inicio + 4000 };
        }
        e.actualizado = t;
        setD({ ...e, fotografia: { ...(e.fotografia as Fotografia) } });
      };
      paso(); paso(); paso();
      demo.current = window.setInterval(paso, 3000);
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
      clearInterval(tic);
      clearInterval(sondeo);
      if (demo.current) clearInterval(demo.current);
    };
  }, []);

  const f = d.fotografia;
  const mando = { ...BASE.mando, ...(d.agentes.mando || {}) };
  const eMando = mando.estado && ROTULO[mando.estado] ? mando.estado : "espera";
  // Una sola radio: las transmisiones de los dos departamentos, en orden de llegada
  const radio = [
    ...d.bitacora.map((x) => ({ ...x, dep: "video" as Depto })),
    ...(f?.bitacora || []).map((x) => ({ ...x, dep: "foto" as Depto })),
  ].sort((a, b) => b.t - a.t).slice(0, 40);
  const actualizado = Math.max(d.actualizado || 0, f?.actualizado || 0);

  return (
    <div className="marco">
      <header className="barra">
        <div className="marca">
          <h1>Centro de Operaciones Bravo</h1>
          <span>Edición y Fotografía IA{d.medio ? ` · ${d.medio}` : ""}</span>
        </div>
        <div className="instrumentos">
          <span className="enlace" data-modo={enlace.modo}><i />{enlace.txt}</span>
          <span title="Hora de Colombia" suppressHydrationWarning>
            {new Date(ahora).toLocaleTimeString("es-CO", { ...ZONA, hour: "2-digit", minute: "2-digit", second: "2-digit" })} COT
          </span>
        </div>
      </header>

      <section className="mando" data-estado={eMando} aria-label="Mando">
        <div className="mando-quien">
          <span className="indicativo">{mando.alias}</span>
          <h2>{mando.nombre}</h2>
          <p className="rol">{mando.rol}</p>
        </div>
        <p className="linea">
          <span className="pill" data-e={eMando}>{ROTULO[eMando]}</span>
          {mando.linea || "Al mando."}
          {mando.t ? <time>{hace(mando.t, ahora)}</time> : null}
        </p>
        <nav className="plano" aria-label="Departamentos">
          <a href="#edicion" data-depto="video">
            <b>Edición</b>
            <span>{d.mision ? d.mision.codigo : "Sin misión"}</span>
          </a>
          <a href="#fotografia" data-depto="foto">
            <b>Fotografía</b>
            <span>{f?.instalado === false ? "Por instalar" : f?.mision ? f.mision.codigo : "Sin misión"}</span>
          </a>
        </nav>
      </section>

      <div className="cuerpo">
        <div className="departamentos">
          <Departamento
            id="edicion" depto="video" titulo="Departamento de Edición" sub="Video, reels y notas"
            mision={d.mision} etapas={d.etapas && d.etapas.length > 1 ? d.etapas.slice(1) : ETAPAS_VIDEO}
            orden={ORDEN_VIDEO} agentes={d.agentes} bitacora={d.bitacora} ahora={ahora} actualizado={d.actualizado}
          />
          {f && f.instalado !== false ? (
            <Departamento
              id="fotografia" depto="foto" titulo="Departamento de Fotografía" sub="Sesiones, selección y revelado"
              mision={f.mision} etapas={f.etapas && f.etapas.length > 1 ? f.etapas.slice(1) : ETAPAS_FOTO}
              orden={ORDEN_FOTO} agentes={f.agentes} bitacora={f.bitacora} ahora={ahora} actualizado={f.actualizado || undefined}
            />
          ) : (
            <section id="fotografia" className="depto" data-depto="foto" aria-label="Departamento de Fotografía">
              <header className="depto-cab"><h2>Departamento de Fotografía</h2><span>Sesiones, selección y revelado</span></header>
              <p className="vacio">
                {f ? "El equipo de fotografía está listo, pero falta conectar su bot: agrega TELEGRAM_TOKEN_FOTOS y ejecuta configurarFotos en Apps Script."
                  : "Este Apps Script todavía no tiene el departamento de fotografía. Pega Fotografia.gs y publica una nueva versión."}
              </p>
            </section>
          )}
        </div>

        <aside className="radio" aria-label="Bitácora de radio">
          <header><h2>Radio · Bitácora</h2><span>{actualizado ? `act. ${hhmm(actualizado, ahora)}` : "—"}</span></header>
          <ol className="log">
            {radio.length ? radio.map((x, i) => (
              <li key={`${x.dep}-${x.t}-${i}`} data-depto={x.dep}>
                <time>{hhmm(x.t, ahora)}</time>
                <div><b>{BASE[x.a]?.nombre || x.a}</b><p>{x.x}</p></div>
              </li>
            )) : <li className="vacio">Sin transmisiones todavía. La bitácora se llena cuando llega material.</li>}
          </ol>
          <div className="cifras">
            <div data-depto="video"><b>{d.stats?.reels || 0}</b>Videos entregados</div>
            <div data-depto="foto"><b>{f?.stats?.fotos || 0}</b>Fotos entregadas</div>
          </div>
          <div className="cifras secundarias">
            <div>{promedio(d.stats?.minutos) ?? "—"}<small> min</small> por video</div>
            <div>{promedio(f?.stats?.minutos) ?? "—"}<small> min</small> por sesión</div>
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

function Departamento(p: {
  id: string; depto: Depto; titulo: string; sub: string; mision: Mision | null; etapas: string[];
  orden: readonly string[]; agentes: Record<string, Agente>; bitacora: Bitacora; ahora: number; actualizado?: number;
}) {
  const { mision: m, etapas, ahora } = p;
  const etapa = m ? m.etapa || 0 : 0;
  const entregada = !!m && etapa >= etapas.length;
  // Al entregar, el reloj se detiene: muestra cuánto duró la misión
  const finMision = entregada ? (m && m.fin) || (p.bitacora[0] && p.bitacora[0].t) || p.actualizado || ahora : ahora;
  const transcurrido = m && m.inicio ? Math.max(0, Math.floor((finMision - m.inicio) / 1000)) : null;
  // Un agente que no ha trabajado en esta misión, o que quedó "en operación" cuando ya se entregó, está en posición
  const vigente = (a: Agente): Agente => {
    if (m && m.inicio && a.t && a.t < m.inicio - 60000) return { ...a, estado: "espera", linea: "En posición.", t: undefined };
    if (entregada && a.estado === "trabajando") return { ...a, estado: "espera", linea: "En posición.", t: undefined };
    return a;
  };

  return (
    <section id={p.id} className="depto" data-depto={p.depto} aria-label={p.titulo}>
      <header className="depto-cab"><h2>{p.titulo}</h2><span>{p.sub}</span></header>
      <div className="mision">
        <div>
          <small>{m ? (entregada ? `Última misión · entregada ${hace(finMision, ahora)}` : `Misión en curso · ${m.etapaNombre || etapas[etapa - 1] || ""}`) : "Esperando material"}</small>
          <p className="codigo">{m ? m.codigo : "Sin misión activa"}</p>
        </div>
        <div className="reloj-mision">
          {entregada ? "Duración de la misión" : "Tiempo en operación"}
          <b>{transcurrido === null ? "--:--" : reloj(transcurrido)}</b>
        </div>
        <ol className="etapas" style={{ "--n": etapas.length } as React.CSSProperties} aria-label="Etapas de la misión">
          {etapas.map((n, i) => {
            const c = i + 1 < etapa ? "hecha" : i + 1 === etapa ? "actual" : "";
            return <li key={n} className={c} aria-current={c === "actual" ? "step" : undefined}>{n}</li>;
          })}
        </ol>
      </div>
      <div className="puestos">
        {p.orden.map((k) => {
          const a = vigente({ ...BASE[k], ...(p.agentes[k] || {}) });
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
      </div>
    </section>
  );
}
