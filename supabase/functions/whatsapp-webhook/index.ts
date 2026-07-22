import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN") ?? "";
const WHATSAPP_ACCESS_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "";
const WHATSAPP_PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const ownerIdByPhone = new Map<string, string>();

type ChatTurn = { role: string; content: string };

type ParsedMessage = {
  type: "task" | "habit" | "lead" | "finance" | "query" | "report" | "chat" | "unclear";
  data: Record<string, any>;
};

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

    const ownerId = await resolveOwnerIdByPhone(message.from);
    if (!ownerId) {
      await sendWhatsappReply(
        message.from,
        "Esse número ainda não está vinculado a nenhuma conta Nexor. Entra no app, vai em Configurações e vincula seu WhatsApp na seção \"Nex AI no WhatsApp\"."
      );
      return Response.json({ ok: true, skipped: true });
    }

    const history = await fetchHistory(ownerId, message.from);
    const inboxId = await insertInbox(ownerId, message.from, message.text);

    let parsed: ParsedMessage | null = null;
    try {
      parsed = await classifyMessage(message.text, history);
    } catch (error) {
      console.error("whatsapp_webhook: falha na classificacao IA:", (error as Error).message);
    }

    if (!parsed || parsed.type === "unclear") {
      const reply = "Não entendi essa mensagem 🤔 Posso criar tarefas, hábitos, leads, lançamentos financeiros, responder perguntas sobre seus dados ou só bater um papo. Pode reformular?";
      await updateInbox(inboxId, { status: "erro", parsed_type: parsed?.type || "unclear", parsed_data: parsed?.data || {}, reply });
      await sendWhatsappReply(message.from, reply);
      return Response.json({ ok: true });
    }

    try {
      let reply = "";
      if (parsed.type === "chat") {
        reply = await answerChat(message.text, history);
      } else if (parsed.type === "query") {
        reply = await answerQuery(ownerId, message.text, history);
      } else if (parsed.type === "report") {
        const answer = await answerQuery(ownerId, message.text, history);
        reply = `${answer}\n\n(Relatório em PDF completo: acesse o Nex AI pelo site do Nexor.)`;
      } else {
        reply = await appendRecord(ownerId, parsed);
      }
      await updateInbox(inboxId, { status: "processado", parsed_type: parsed.type, parsed_data: parsed.data, reply });
      await sendWhatsappReply(message.from, reply);
    } catch (error) {
      console.error("whatsapp_webhook: falha ao processar:", (error as Error).message);
      const reply = "Entendi a mensagem mas tive um problema pra processar. Tenta de novo em instantes.";
      await updateInbox(inboxId, { status: "erro", parsed_type: parsed.type, parsed_data: parsed.data, reply });
      await sendWhatsappReply(message.from, reply);
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

// ---------- Owner (por numero de WhatsApp vinculado) ----------

function normalizePhone(raw: string): string {
  return String(raw || "").replace(/\D/g, "");
}

function phoneMatches(a: string, b: string): boolean {
  const x = normalizePhone(a);
  const y = normalizePhone(b);
  if (!x || !y) return false;
  return x.endsWith(y) || y.endsWith(x);
}

async function resolveOwnerIdByPhone(fromPhone: string): Promise<string> {
  const cached = ownerIdByPhone.get(fromPhone);
  if (cached) return cached;

  const rows = await restFetch(
    `/nexor_records?record_type=eq.setting&data->>key=eq.workspace&select=owner_id,data`
  );
  for (const row of rows) {
    const savedPhone = row?.data?.db?.whatsappPhone;
    if (savedPhone && phoneMatches(fromPhone, savedPhone)) {
      ownerIdByPhone.set(fromPhone, row.owner_id);
      return row.owner_id;
    }
  }
  return "";
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

async function fetchHistory(ownerId: string, phone: string): Promise<ChatTurn[]> {
  try {
    const rows = await restFetch(
      `/nexor_whatsapp_inbox?owner_id=eq.${ownerId}&phone=eq.${phone}&order=created_at.desc&limit=6&select=message,reply`
    );
    const items = rows.reverse();
    const history: ChatTurn[] = [];
    for (const item of items) {
      if (item.message) history.push({ role: "user", content: item.message });
      if (item.reply) history.push({ role: "assistant", content: item.reply });
    }
    return history.slice(-12);
  } catch {
    return [];
  }
}

function historyAsText(history: ChatTurn[]): string {
  if (!history.length) return "(sem mensagens anteriores)";
  return history
    .map(item => `${item.role === "assistant" ? "Nex AI" : "Usuário"}: ${String(item.content || "").slice(0, 400)}`)
    .join("\n");
}

// ---------- Classificacao via Gemini ----------

async function classifyMessage(text: string, history: ChatTurn[]): Promise<ParsedMessage> {
  const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

  const systemPrompt = `Você interpreta mensagens de WhatsApp para o Nexor, um app de organização/produtividade.
Data e hora atual (America/Sao_Paulo): ${now}.

Histórico recente da conversa (pode ajudar a entender o contexto de uma mensagem curta ou de acompanhamento):
${historyAsText(history)}

Classifique a ÚLTIMA mensagem do usuário em um destes tipos:
- "task": inclui compromissos/eventos de agenda.
- "habit": pedido pra criar um hábito/rotina recorrente (ex: "quero criar o hábito de beber água").
- "lead": oportunidade comercial nova.
- "finance": lançamento financeiro, entrada ou saída de dinheiro.
- "query": pergunta sobre dados que já existem no sistema do usuário (ex: "quanto vou receber essa semana").
- "report": pedido explícito de relatório/documento/PDF.
- "chat": qualquer outra coisa — conversa, pedido de conselho, dúvida sobre qualquer assunto, brainstorm, ajuda pra escrever algo, etc. Modo padrão quando não é claramente uma das ações acima.
- "unclear": mensagem vazia ou impossível de entender (raro — prefira "chat" quando houver qualquer conteúdo interpretável).

Responda SOMENTE com um JSON válido, sem texto adicional, no formato:
{"type": "task", "data": {"title": "...", "dueDate": "YYYY-MM-DD", "time": "HH:MM", "priority": "Baixa|Média|Alta"}}
ou
{"type": "habit", "data": {"name": "...", "frequency": "Diária|Semanal", "days": ["Segunda", "..."], "target": 1}}
ou
{"type": "lead", "data": {"name": "...", "business": "...", "contact": "...", "value": 0, "notes": "..."}}
ou
{"type": "finance", "data": {"title": "...", "type": "Receita|Despesa", "value": 0, "date": "YYYY-MM-DD", "status": "Pago|Pendente"}}
ou
{"type": "query", "data": {}}
ou
{"type": "report", "data": {}}
ou
{"type": "chat", "data": {}}
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

  if (!["task", "habit", "lead", "finance", "query", "report", "chat", "unclear"].includes(parsed.type)) {
    return { type: "unclear", data: {} };
  }
  return { type: parsed.type, data: parsed.data || {} };
}

// ---------- Conversa livre ----------

async function answerChat(message: string, history: ChatTurn[]): Promise<string> {
  const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const systemPrompt = `Você é o Nex AI, o assistente de inteligência artificial embutido no Nexor (app de organização, rotina, projetos, financeiro e produtividade), respondendo agora pelo WhatsApp. Data e hora atual (America/Sao_Paulo): ${now}.

Converse normalmente e ajude com qualquer assunto que a pessoa trouxer — dê conselhos práticos, explique conceitos, ajude a pensar estratégia de negócio, marketing, gestão de tempo, produtividade, redação de textos, o que for preciso. Assuma o papel de especialista no assunto perguntado sempre que fizer sentido. Seja direto e útil, em português, sem markdown (é WhatsApp — nada de *, #, listas com marcação; só texto corrido e quebras de linha). Respostas curtas e objetivas.

Histórico recente da conversa:
${historyAsText(history)}`;

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: message }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] }
      })
    }
  );

  if (!response.ok) throw new Error(`Gemini API respondeu ${response.status}: ${await response.text()}`);
  const result = await response.json();
  return result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Não consegui responder agora, tenta de novo.";
}

// ---------- Perguntas sobre dados existentes ----------

async function fetchWorkspaceRecord(ownerId: string) {
  const rows = await restFetch(
    `/nexor_records?record_type=eq.setting&owner_id=eq.${ownerId}&data->>key=eq.workspace&select=id,data&limit=1`
  );
  const record = rows?.[0];
  if (!record) throw new Error("Workspace (nexor_records/setting) nao encontrado para o owner.");
  return record;
}

async function answerQuery(ownerId: string, question: string, history: ChatTurn[]): Promise<string> {
  const record = await fetchWorkspaceRecord(ownerId);
  const db = record.data?.db || {};
  const clientNames: Record<string, string> = Object.fromEntries((db.clients || []).map((c: any) => [c.id, c.name]));

  const finance = (db.finance || []).slice(0, 300).map((item: any) => ({
    title: item.title,
    type: item.type,
    value: item.value,
    date: item.date,
    status: item.status,
    cliente: clientNames[item.clientId] || ""
  }));
  const tasks = (db.tasks || []).slice(0, 300).map((item: any) => ({
    title: item.title,
    dueDate: item.dueDate,
    status: item.status,
    priority: item.priority
  }));
  const leads = (db.leads || []).slice(0, 200).map((item: any) => ({
    name: item.name,
    stage: item.stage,
    value: item.value,
    nextDate: item.nextDate
  }));

  const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const systemPrompt = `Você é o Nex AI, assistente do Nexor (app de organização/produtividade/financeiro), respondendo pelo WhatsApp. Data e hora atual (America/Sao_Paulo): ${now}.

Histórico recente da conversa (use como contexto se a pergunta atual for de acompanhamento):
${historyAsText(history)}

Responda a pergunta do usuário SOMENTE com base nos dados JSON fornecidos abaixo — nunca invente valores. Se os dados não permitirem responder, diga isso claramente. Responda em português, direto, no máximo 3 frases, sem markdown (é WhatsApp).

Lançamentos financeiros (finance): ${JSON.stringify(finance)}
Tarefas (tasks): ${JSON.stringify(tasks)}
Leads (leads): ${JSON.stringify(leads)}`;

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: question }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] }
      })
    }
  );

  if (!response.ok) throw new Error(`Gemini API respondeu ${response.status}: ${await response.text()}`);
  const result = await response.json();
  return result?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "Não consegui calcular isso com os dados atuais.";
}

// ---------- Gravar no workspace (nexor_records / record_type=setting) ----------

async function appendRecord(ownerId: string, parsed: ParsedMessage): Promise<string> {
  const record = await fetchWorkspaceRecord(ownerId);

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
  } else if (parsed.type === "habit") {
    db.habits ||= [];
    const item = {
      id,
      name: parsed.data.name || "Hábito via WhatsApp",
      frequency: parsed.data.frequency || "Diária",
      days: Array.isArray(parsed.data.days) && parsed.data.days.length ? parsed.data.days : ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"],
      target: Number(parsed.data.target || 1),
      streak: 0,
      bestStreak: 0,
      doneToday: false,
      history: []
    };
    db.habits.unshift(item);
    summary = `✅ Hábito criado: ${item.name} — ${item.frequency}`;
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
