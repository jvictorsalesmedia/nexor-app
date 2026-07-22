const jsonHeaders = { "Content-Type": "application/json" };

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
    const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || "";
    const geminiKey = process.env.GEMINI_API_KEY || "";
    if (!supabaseUrl || !anonKey) throw new Error("Supabase env is missing.");
    if (!geminiKey) throw new Error("GEMINI_API_KEY nao configurada.");

    const accessToken = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (!accessToken) throw new Error("Sessão inválida. Faça login novamente.");

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const message = String(body.message || "").trim();
    if (!message) throw new Error("Digite uma mensagem.");

    // Confirma que o token pertence a um usuario real antes de gastar chamada de IA.
    await getCurrentUser(supabaseUrl, anonKey, accessToken);

    const parsed = await classifyMessage(geminiKey, message);

    if (parsed.type === "unclear") {
      res.status(200).json({ ok: true, type: "unclear", summary: "Não entendi essa mensagem. Pode reformular?" });
      return;
    }

    const summary = await appendRecord(supabaseUrl, anonKey, accessToken, parsed);
    res.status(200).json({ ok: true, type: parsed.type, summary });
  } catch (error) {
    res.status(400).json({ error: error.message || "Não foi possível processar a mensagem." });
  }
};

async function getCurrentUser(supabaseUrl, anonKey, accessToken) {
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw new Error("Sessão expirada. Faça login novamente.");
  return response.json();
}

async function classifyMessage(geminiKey, text) {
  const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

  const systemPrompt = `Você interpreta mensagens curtas de texto para o Nexor, um app de organização/produtividade.
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
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { responseMimeType: "application/json" }
      })
    }
  );

  if (!response.ok) throw new Error(`Gemini API respondeu ${response.status}: ${await response.text()}`);

  const result = await response.json();
  const raw = result?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);

  if (!["task", "lead", "finance", "unclear"].includes(parsed.type)) return { type: "unclear", data: {} };
  return { type: parsed.type, data: parsed.data || {} };
}

async function appendRecord(supabaseUrl, anonKey, accessToken, parsed) {
  const rows = await restFetch(
    supabaseUrl,
    anonKey,
    accessToken,
    "/nexor_records?record_type=eq.setting&data->>key=eq.workspace&select=id,data&limit=1"
  );
  const record = rows?.[0];
  if (!record) throw new Error("Workspace não encontrado para este usuário.");

  const db = record.data?.db || {};
  const today = new Date().toISOString().slice(0, 10);
  const id = `${parsed.type}_${cryptoRandomId()}`;

  let summary = "";

  if (parsed.type === "task") {
    db.tasks ||= [];
    const item = {
      id,
      title: parsed.data.title || "Tarefa via Nex AI",
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
      tags: ["nex-ai"],
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
      name: parsed.data.name || parsed.data.business || "Lead via Nex AI",
      business: parsed.data.business || "",
      contact: parsed.data.contact || "",
      email: "",
      whatsapp: "",
      source: "Nex AI",
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
      title: parsed.data.title || "Lançamento via Nex AI",
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

  await restFetch(supabaseUrl, anonKey, accessToken, `/nexor_records?id=eq.${record.id}`, {
    method: "PATCH",
    body: { data: { key: "workspace", db } }
  });

  return summary;
}

function formatDate(iso) {
  const [y, m, d] = String(iso || "").split("-");
  return y && m && d ? `${d}/${m}` : iso;
}

function cryptoRandomId() {
  const crypto = require("crypto");
  return crypto.randomBytes(8).toString("hex");
}

async function restFetch(supabaseUrl, anonKey, accessToken, path, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1${path}`, {
    method: options.method || "GET",
    headers: {
      ...jsonHeaders,
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.message || data?.hint || text || "Erro PostgREST.");
  return Array.isArray(data) ? data : data ? [data] : [];
}
