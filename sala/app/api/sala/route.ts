// Puente entre la sala virtual y el Apps Script. Solo lee el estado público (códigos y estados, sin contenido).
export const dynamic = "force-dynamic";

// La URL /exec del Apps Script. En Vercel se puede cambiar con la variable de entorno SALA_API.
const POR_DEFECTO =
  "https://script.google.com/macros/s/AKfycbzouChn4NtfCRLURgj7rZi9scW6RuhEz5F3qrA68iZasyqCNAI3iVYrFeq3TRwJGKfieg/exec";

export async function GET() {
  const api = (process.env.SALA_API || POR_DEFECTO).trim();
  if (!api) return Response.json({ ok: false, demo: true });
  try {
    const r = await fetch(api + (api.includes("?") ? "&" : "?") + "accion=sala", {
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(12000),
    });
    const d = await r.json();
    return Response.json(d, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
