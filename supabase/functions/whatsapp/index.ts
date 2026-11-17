// DIDICOST · webhook do WhatsApp (Meta Cloud API)
// Recebe mensagens como "mercado 50" e guarda na caixa de entrada (tabela entradas).
// O app busca essas entradas na próxima sincronização e lança nos lançamentos.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? "";
const APP_SECRET = Deno.env.get("WHATSAPP_APP_SECRET") ?? "";
const WA_TOKEN = Deno.env.get("WHATSAPP_TOKEN") ?? "";
const PHONE_ID = Deno.env.get("WHATSAPP_PHONE_ID") ?? "";
const GRAPH = Deno.env.get("WHATSAPP_GRAPH_VERSION") ?? "v23.0";

const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

// ---------- utilidades ----------
function hojeSP(deslocDias = 0): string {
  const d = new Date(Date.now() + deslocDias * 864e5);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d); // AAAA-MM-DD
}
function norm(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}
function brl(c: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(c / 100);
}
// "50" · "23,90" · "23.90" · "1.234,56" · "R$ 1.234,56" -> centavos
function parseValor(str: string): number | null {
  let s = str.replace(/^r\$\s*/i, "").replace(/\s/g, "");
  if (!s) return null;
  const hasC = s.includes(","), hasD = s.includes(".");
  if (hasC && hasD) {
    const dec = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    const th = dec === "," ? "." : ",";
    s = s.split(th).join("").replace(dec, ".");
  } else if (hasC) {
    s = s.replace(",", ".");
  } else if (hasD) {
    const p = s.split(".");
    if (p.length > 2 || p[1].length === 3) s = p.join("");
  }
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const c = parseInt(m[1], 10) * 100 + parseInt((m[2] ?? "0").padEnd(2, "0"), 10);
  return Number.isSafeInteger(c) && c > 0 && c <= 99999999999 ? c : null;
}

type Entrada = { tipo: string; descricao: string; valor_centavos: number; data: string; pagamento: string | null };

// Uma linha -> um lançamento. Ex.: "mercado 50", "uber 23,90 pix", "recebi job 1500", "investi cdb 500", "ontem farmácia 32"
function lerLinha(linha: string): Entrada | null {
  const nums = [...linha.matchAll(/(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/gi)];
  if (!nums.length) return null;
  const ult = nums[nums.length - 1];
  const valor = parseValor(ult[0]);
  if (!valor) return null;
  let resto = (linha.slice(0, ult.index) + " " + linha.slice(ult.index! + ult[0].length)).replace(/\breais\b/gi, " ");
  const n = " " + norm(resto) + " ";
  let tipo = "gasto";
  let pagamento: string | null = "credito";
  let data = hojeSP();
  const tirar: RegExp[] = [];
  if (/ (recebi|renda|entrada) /.test(n) || /^\s*\+/.test(linha)) { tipo = "renda"; pagamento = null; tirar.push(/\b(recebi|renda|entrada)\b/gi, /^\s*\+/); }
  else if (/ (investi|investimento|aporte|aportei) /.test(n)) { tipo = "investimento"; pagamento = null; tirar.push(/\b(investi|investimento|aporte|aportei)\b/gi); }
  else if (/ (pix|debito|dinheiro) /.test(n)) { pagamento = "debito"; tirar.push(/\b(pix|d[eé]bito|dinheiro|no|na)\b/gi); }
  else if (/ (credito|cartao) /.test(n)) { tirar.push(/\b(cr[eé]dito|cart[aã]o|no|na)\b/gi); }
  if (/ ontem /.test(n)) { data = hojeSP(-1); tirar.push(/\bontem\b/gi); }
  for (const r of tirar) resto = resto.replace(r, " ");
  const descricao = resto.replace(/[-–:·,;]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!descricao) return null;
  return { tipo, descricao: descricao.charAt(0).toUpperCase() + descricao.slice(1), valor_centavos: valor, data, pagamento };
}

async function responder(para: string, texto: string): Promise<any> {
  if (!WA_TOKEN || !PHONE_ID) return { erro: "sem token ou phone id" };
  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH}/${PHONE_ID}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: para, type: "text", text: { body: texto } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) console.error("resposta falhou", r.status, JSON.stringify(j?.error ?? j));
    return { status: r.status, corpo: j };
  } catch (e) { console.error("resposta falhou", String(e)); return { erro: String(e) }; }
}

async function assinaturaValida(req: Request, corpo: string): Promise<boolean> {
  if (!APP_SECRET) return false;
  const sig = req.headers.get("x-hub-signature-256") ?? "";
  if (!sig.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(corpo)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  const esperado = sig.slice(7);
  if (hex.length !== esperado.length) return false;
  let dif = 0;
  for (let i = 0; i < hex.length; i++) dif |= hex.charCodeAt(i) ^ esperado.charCodeAt(i);
  return dif === 0;
}

const AJUDA =
  "DIDICOST 💸\n\nMande uma compra por linha:\n• mercado 50\n• uber 23,90 pix\n• ontem farmácia 32\n• recebi job 1500\n• investi cdb 500\n\nGastos entram no crédito, a não ser que você escreva pix ou débito.";

async function tratarMensagem(msg: any) {
  const de: string = msg.from;
  const id: string = msg.id;
  if (msg.type !== "text") { await responder(de, "Por enquanto eu só entendo mensagens de texto, como: mercado 50"); return; }
  const texto: string = (msg.text?.body ?? "").trim();
  const t = norm(texto);

  const vinc = /^vincular\s+(\d{6})$/.exec(t);
  if (vinc) {
    const { data: cod } = await db.from("whatsapp_codigos").select("user_id, expira_em").eq("codigo", vinc[1]).maybeSingle();
    if (!cod || new Date(cod.expira_em) < new Date()) { await responder(de, "Código inválido ou vencido. Gere um novo no DIDICOST, em Ajustes › WhatsApp."); return; }
    await db.from("whatsapp_vinculos").delete().or(`telefone.eq.${de},user_id.eq.${cod.user_id}`);
    const { error } = await db.from("whatsapp_vinculos").insert({ telefone: de, user_id: cod.user_id });
    await db.from("whatsapp_codigos").delete().eq("codigo", vinc[1]);
    await responder(de, error ? "Não consegui ligar este número agora. Tente de novo." : "✅ WhatsApp ligado ao seu DIDICOST!\n\n" + AJUDA);
    return;
  }

  const { data: v } = await db.from("whatsapp_vinculos").select("user_id").eq("telefone", de).maybeSingle();
  if (!v) { await responder(de, "Este número ainda não está ligado a uma conta. No DIDICOST, entre com Google, vá em Ajustes › WhatsApp, gere um código e mande aqui: vincular 123456"); return; }
  if (/^(ajuda|oi|ola|menu|help)\b/.test(t)) { await responder(de, AJUDA); return; }

  const linhas = texto.split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 20);
  const ok: Entrada[] = [], ruins: string[] = [];
  for (const l of linhas) { const e = lerLinha(l); if (e) ok.push(e); else ruins.push(l); }
  if (ok.length) {
    const linhasDb = ok.map((e) => ({ ...e, user_id: v.user_id, origem: "whatsapp", msg_id: id }));
    const { error } = await db.from("entradas").upsert(linhasDb, { onConflict: "msg_id,descricao,valor_centavos", ignoreDuplicates: true });
    if (error) { await responder(de, "Não consegui salvar agora. Tente de novo em instantes."); return; }
  }
  const rotulo = (e: Entrada) => e.tipo === "renda" ? "renda" : e.tipo === "investimento" ? "investimento" : e.pagamento === "debito" ? "débito/pix" : "crédito";
  let r = ok.length
    ? "✅ Anotado:\n" + ok.map((e) => `• ${e.descricao} · ${brl(e.valor_centavos)} · ${rotulo(e)}${e.data !== hojeSP() ? " (ontem)" : ""}`).join("\n") + "\n\nAparece no app na próxima vez que ele abrir."
    : "";
  if (ruins.length) r += (r ? "\n\n" : "") + "Não entendi: " + ruins.map((x) => `"${x}"`).join(", ") + "\nEscreva o nome e o valor, ex.: mercado 50";
  await responder(de, r);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // Diagnóstico: ?diag=<verify token>. Mostra o número e a conta do WhatsApp e inscreve o app nas contas.
  if (req.method === "GET" && VERIFY_TOKEN && url.searchParams.get("diag") === VERIFY_TOKEN) {
    const g = async (path: string, metodo = "GET") => {
      try {
        const r = await fetch(`https://graph.facebook.com/${GRAPH}/${path}`, { method: metodo, headers: { Authorization: `Bearer ${WA_TOKEN}` } });
        return await r.json();
      } catch (e) { return { erro: String(e) }; }
    };
    const out: any = { tem_token: !!WA_TOKEN, tem_phone_id: !!PHONE_ID, tem_app_secret: !!APP_SECRET };
    out.numero = await g(`${PHONE_ID}?fields=display_phone_number,verified_name,status,platform_type,code_verification_status,name_status`);
    // Descobre as contas do WhatsApp a que o token tem acesso pelo próprio token (não precisa de business_management)
    const dbg = await g(`debug_token?input_token=${encodeURIComponent(WA_TOKEN)}`);
    const escopos = dbg?.data?.granular_scopes ?? [];
    const ids = new Set<string>();
    for (const e of escopos) if (String(e.scope).startsWith("whatsapp_business")) for (const t of e.target_ids ?? []) ids.add(String(t));
    const wabaParam = url.searchParams.get("waba");
    if (wabaParam && /^\d+$/.test(wabaParam)) ids.add(wabaParam);
    out.escopos = escopos.map((e: any) => e.scope);
    out.contas = { data: [...ids].map((id) => ({ id })) };
    for (const w of out.contas.data as any[]) {
      w.info = await g(`${w.id}?fields=name,phone_numbers{id,display_phone_number,status}`);
      w.apps_antes = await g(`${w.id}/subscribed_apps`);
      w.inscrever = await g(`${w.id}/subscribed_apps`, "POST");
      w.apps_depois = await g(`${w.id}/subscribed_apps`);
    }
    if (url.searchParams.get("enviar") === "1") {
      const { data: vs } = await db.from("whatsapp_vinculos").select("telefone");
      out.envios = [];
      for (const v of vs ?? []) out.envios.push({ final: String(v.telefone).slice(-4), resultado: await responder(v.telefone, "Teste do DIDICOST ✅") });
    }
    console.log("diag", JSON.stringify(out));
    return new Response(JSON.stringify(out, null, 2), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }
  // Verificação do webhook pela Meta
  if (req.method === "GET") {
    if (VERIFY_TOKEN && url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === VERIFY_TOKEN) {
      return new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 });
    }
    return new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("ok", { status: 200 });
  const corpo = await req.text();
  if (!(await assinaturaValida(req, corpo))) return new Response("assinatura invalida", { status: 401 });
  let payload: any;
  try { payload = JSON.parse(corpo); } catch { return new Response("ok", { status: 200 }); }
  const tarefas: Promise<void>[] = [];
  for (const entry of payload.entry ?? []) {
    for (const ch of entry.changes ?? []) {
      for (const msg of ch.value?.messages ?? []) tarefas.push(tratarMensagem(msg).catch((e) => console.error("mensagem", e)));
      for (const st of ch.value?.statuses ?? []) {
        const info = { status: st.status, final: String(st.recipient_id ?? "").slice(-4), erros: st.errors ?? null };
        if (st.status === "failed") console.error("entrega falhou", JSON.stringify(info)); else console.log("entrega", JSON.stringify(info));
      }
    }
  }
  await Promise.all(tarefas);
  return new Response("ok", { status: 200 });
});
