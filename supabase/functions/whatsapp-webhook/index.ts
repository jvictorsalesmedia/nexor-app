import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? "";
const WHATSAPP_ACCESS_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "";
const WHATSAPP_PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const ADMIN_EMAIL = "jvgsales72@gmail.com";

let cachedOwnerId = "";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === VERIFY_TOKEN && challenge) {
      return new Response(challenge, { status: 200 });
    }

    return new Response("Verification failed", { status: 403 });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // Sempre responde 200 pro Meta, mesmo em erro interno — senao ele reentrega
  // a mesma mensagem em loop. Erros ficam so no log e no status do inbox.
  try {
    const payload = await req.json().catch(() => ({}));
    const message = extractMessage(payload);

    if (!message) {
      return Response.json({ ok: true, skipped: true });
    }

    const ownerId = await resolveOwnerId();
    if (!ownerId) {
      console.error("whatsapp_webhook: nao foi possivel resolver o owner (admin).");
      return Response.json({ ok: true, skipped: true });
    }

    const inboxId = await insertInbox(ownerId, message.from, message.text);

    let parsed: ParsedMessage | null = null;
    try {
      parsed = await classifyMessage(message.text);
    } catch (error) {
      console.error("whatsapp_webhook: falha na classificacao IA:", (error as Error).message);
    }

    if (!parsed || parsed.type === "unclear") {
      await updateInbox(inboxId, { status: "erro", parsed_type: parsed?.type || "unclear", parsed_data: parsed?.data || {} });
      await sendWhatsappReply(message.from, "Não entendi essa mensagem 🤔 Pode reformular? Ex: \"reunião com cliente X sexta 15h\" ou \"recebi 400 do cliente Y\".");
      return Response.json({ ok: true });
    }

    try {
      const summary = await appendRecord(ownerId, parsed);
      await updateInbox(inboxId, { status: "processado", parsed_type: parsed.type, parsed_data: parsed.data });
      await sendWhatsappReply(message.from, summary);
    } catch (error) {
      console.error("whatsapp_webhook: falha ao gravar registro:", (error as Error).message);
      await updateInbox(inboxId, { status: "erro", parsed_type: parsed.type, parsed_data: parsed.data });
      await sendWhatsappReply(message.from, "Entendi a mensagem mas tive um problema pra salvar no Nexor. Tenta de novo em instantes.");
    }

    return Response.json({ ok: true });
  } catch (error) {
    console.error("whatsapp_webhook: erro inesperado:", (error as Error).message);
    return Response.json({ ok: true });
  }
});

// ---------- Parsing do payload do Meta ----------

function extractMessage(payload: any): { from: string; text: string } | null {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  const entry = value?.messages?.[0];
  if (!entry || entry.type !== "text") return null;
  const text = entry.text?.body?.trim();
  if (!text) return null;
  return { from: entry.from, text };
}

// ---------- Owner (admin) ----------

async function resolveOwnerId(): Promise<string> {
  if (cachedOwnerId) return cachedOwnerId;
  const data = await authAdmin(`/admin/users?email=${encodeURIComponent(ADMIN_EMAIL)}`);
  const user = data?.users?.[0];
  if (user?.id) cachedOwnerId = user.id;
  return cachedOwnerId;
}

// ---------- Inbox (nexor_whatsapp_inbox) ----------

async function insertInbox(ownerId: string, phone: string, message: string): Promise<string> {
  const rows = await restFetch("/nexor_whatsapp_inbox", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: { owner_id: ownerId, phone, message, status: "novo" }
  });
  return rows?.[0]?.id || "";
}

async function updateInbox(id: string, patch: Record<string, unknown>) {
  if (!id) return;
  await restFetch(`/nexor_whatsapp_inbox?id=eq.${id}`, { method: "PATCH", body: patch });
}

// ---------- Classificacao via Claude ----------

type ParsedMessage = {
  type: "task" | "lead" | "finance" | "unclear";
  data: Record<string, any>;
};

async function classifyMessage(text: string): Promise<ParsedMessage> {
  const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

  const systemPrompt = `Você interpreta mensagens curtas de WhatsApp para o Nexor, um app de organização/produtividade.
Data e hora atual (America/Sao_Paulo): ${now}.

Classifique a mensagem em um destes tipos: "task" (inclui compromissos/eventos de agenda), "lead" (oportunidade comercial nova), "finance" (lançamento financeiro, entrada ou saída de dinheiro), ou "unclear" (não deu pra entender uma ação clara).

Responda SOMENTE com um JSON válido, sem texto adicional, no formato:
{"type": "task", "data": {"title": "...", "dueDate": "YYYY-MM-DD", "time": "HH:MM", "priority": "Baixa|Média|Alta"}}
ou
{"type": "lead", "data": {"name": "...", "business": "...", "contact": "...", "value": 0, "notes": "..."}}
ou
{"type": "finance", "data": {"title": "...", "type": "Receita|Despesa", "value": 0, "date": "YYYY-MM-DD", "status": "Pago|Pendente"}}
ou
{"type": "unclear", "data": {}}

Datas relativas (ex: "sexta", "amanhã") devem virar data absoluta YYYY-MM-DD com base na data atual informada. Se um campo não puder ser inferido, use uma string vazia ou 0 — nunca invente valor plausível para nome/telefone/pessoa.`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { responseMimeType: "application/json" }
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini API respondeu ${response.status}: ${await response.text()}`);
  }

  const result = await response.json();
  const raw = result?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);

  if (!["task", "lead", "finance", "unclear"].includes(parsed.type)) {
    return { type: "unclear", data: {} };
  }
  return { type: parsed.type, data: parsed.data || {} };
}

// ---------- Gravar no workspace (nexor_records / record_type=setting) ----------

async function appendRecord(ownerId: string, parsed: ParsedMessage): Promise<string> {
  const rows = await restFetch(
    `/nexor_records?record_type=eq.setting&owner_id=eq.${ownerId}&data->>key=eq.workspace&select=id,data&limit=1`
  );
  const record = rows?.[0];
  if (!record) throw new Error("Workspace (nexor_records/setting) nao encontrado para o owner.");

  const db = record.data?.db || {};
  const today = new Date().toISOString().slice(0, 10);
  const id = `${parsed.type}_${crypto.randomUUID()}`;

  let summary = "";

  if (parsed.type === "task") {
    db.tasks ||= [];
    const item = {
      id,
      title: parsed.data.title || "Tarefa via WhatsApp",
      description: "",
      category: "",
      subcategory: "",
      projectId: "",
      clientId: "",
      assignee: "",
      dueDate: parsed.data.dueDate || today,
      time: parsed.data.time || "09:00",
      priority: parsed.data.priority || "Média",
      status: "A fazer",
      kanban: "A fazer",
      quadrant: "",
      weekday: "",
      tags: ["whatsapp"],
      checklist: [],
      comments: [],
      createdAt: today,
      completedAt: "",
      attachmentName: ""
    };
    db.tasks.unshift(item);
    summary = `✅ Tarefa criada: ${item.title} — ${formatDate(item.dueDate)} ${item.time}`;
  } else if (parsed.type === "lead") {
    db.leads ||= [];
    const item = {
      id,
      name: parsed.data.name || parsed.data.business || "Lead via WhatsApp",
      business: parsed.data.business || "",
      contact: parsed.data.contact || "",
      email: "",
      whatsapp: "",
      source: "WhatsApp",
      value: Number(parsed.data.value || 0),
      stage: "Novo",
      owner: "",
      nextAction: "",
      nextDate: "",
      notes: parsed.data.notes || "",
      createdAt: today
    };
    db.leads.unshift(item);
    summary = `✅ Lead criado: ${item.name}`;
  } else if (parsed.type === "finance") {
    db.finance ||= [];
    const item = {
      id,
      title: parsed.data.title || "Lançamento via WhatsApp",
      type: parsed.data.type === "Despesa" ? "Despesa" : "Receita",
      category: "",
      value: Number(parsed.data.value || 0),
      date: parsed.data.date || today,
      clientId: "",
      projectId: "",
      status: parsed.data.status === "Pendente" ? "Pendente" : "Pago",
      notes: "",
      attachmentName: ""
    };
    db.finance.unshift(item);
    summary = `✅ Financeiro registrado: ${item.title} — R$ ${item.value.toFixed(2)} (${item.type})`;
  }

  await restFetch(`/nexor_records?id=eq.${record.id}`, {
    method: "PATCH",
    body: { data: { key: "workspace", db } }
  });

  return summary;
}

function formatDate(iso: string): string {
  const [y, m, d] = String(iso || "").split("-");
  return y && m && d ? `${d}/${m}` : iso;
}

// ---------- Envio de resposta no WhatsApp ----------

async function sendWhatsappReply(to: string, text: string) {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) return;
  try {
    await fetch(`https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text }
      })
    });
  } catch (error) {
    console.error("whatsapp_webhook: falha ao responder no WhatsApp:", (error as Error).message);
  }
}

// ---------- Helpers Supabase ----------

async function authAdmin(path: string, options: { method?: string; body?: unknown } = {}) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.msg || data.error_description || data.error || text || "Erro Auth Admin.");
  return data;
}

async function restFetch(path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      apikey: SERVICE_ROLE_KEY,
      authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.message || data?.hint || text || "Erro PostgREST.");
  return Array.isArray(data) ? data : data ? [data] : [];
}
