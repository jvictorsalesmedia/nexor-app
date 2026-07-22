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
    const history = Array.isArray(body.history) ? body.history.slice(-12) : [];
    if (!message) throw new Error("Digite uma mensagem.");

    // Confirma que o token pertence a um usuario real antes de gastar chamada de IA.
    await getCurrentUser(supabaseUrl, anonKey, accessToken);

    const parsed = await classifyMessage(geminiKey, message, history);

    if (parsed.type === "unclear") {
      res.status(200).json({ ok: true, type: "unclear", summary: "Não entendi essa mensagem. Pode reformular?" });
      return;
    }

    if (parsed.type === "query") {
      const answer = await answerQuery(supabaseUrl, anonKey, accessToken, geminiKey, message, history);
      res.status(200).json({ ok: true, type: "query", summary: answer });
      return;
    }

    if (parsed.type === "chat") {
      const answer = await answerChat(geminiKey, message, history);
      res.status(200).json({ ok: true, type: "chat", summary: answer });
      return;
    }

    if (parsed.type === "report") {
      const report = await generateReport(supabaseUrl, anonKey, accessToken, parsed);
      res.status(200).json({ ok: true, type: "report", summary: report.summary, pdfBase64: report.pdfBase64, filename: report.filename });
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

function historyAsText(history) {
  if (!history.length) return "(sem mensagens anteriores)";
  return history
    .map(item => `${item.role === "assistant" ? "Nex AI" : "Usuário"}: ${String(item.content || "").slice(0, 400)}`)
    .join("\n");
}

async function classifyMessage(geminiKey, text, history) {
  const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

  const systemPrompt = `Você interpreta mensagens curtas de texto para o Nexor, um app de organização/produtividade.
Data e hora atual (America/Sao_Paulo): ${now}.

Histórico recente da conversa (pode ajudar a entender o contexto de uma mensagem curta ou uma resposta de acompanhamento):
${historyAsText(history)}

Classifique a ÚLTIMA mensagem do usuário em um destes tipos:
- "task": inclui compromissos/eventos de agenda.
- "habit": pedido pra criar um hábito/rotina recorrente (ex: "quero criar o hábito de beber água", "me ajuda a acompanhar treino toda segunda").
- "lead": oportunidade comercial nova.
- "finance": lançamento financeiro, entrada ou saída de dinheiro.
- "query": pergunta sobre dados que já existem no sistema do usuário (ex: "quanto vou receber essa semana", "qual cliente mais gastou comigo").
- "report": pedido explícito de relatório/documento/PDF (ex: "emitir relatório dos meus gastos do mês passado", "gera um PDF do financeiro de junho", "quero um relatório de tarefas concluídas essa semana").
- "chat": qualquer outra coisa — conversa, pedido de conselho, dúvida sobre qualquer assunto (marketing, gestão, produtividade, o que for), brainstorm, ajuda pra escrever algo, etc. Esse é o modo padrão quando não é claramente uma das ações acima.
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
{"type": "report", "data": {"scope": "finance|tasks|leads", "startDate": "YYYY-MM-DD", "endDate": "YYYY-MM-DD", "title": "..."}}
ou
{"type": "chat", "data": {}}
ou
{"type": "unclear", "data": {}}

Pra "report": "scope" é sempre "finance" a menos que a pessoa peça claramente tarefas ou leads. "startDate"/"endDate" cobrem o período pedido (ex: "mês passado" = do dia 1 ao último dia do mês anterior à data atual informada; "esse mês" = do dia 1 até hoje). "title" é um título curto pro relatório, ex: "Financeiro — Junho/2026".

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

  if (!["task", "habit", "lead", "finance", "query", "report", "chat", "unclear"].includes(parsed.type)) return { type: "unclear", data: {} };
  return { type: parsed.type, data: parsed.data || {} };
}

async function answerChat(geminiKey, message, history) {
  const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const systemPrompt = `Você é o Nex AI, o assistente de inteligência artificial embutido no Nexor (app de organização, rotina, projetos, financeiro e produtividade). Data e hora atual (America/Sao_Paulo): ${now}.

Converse normalmente e ajude com qualquer assunto que a pessoa trouxer — dê conselhos práticos, explique conceitos, ajude a pensar estratégia de negócio, marketing, gestão de tempo, produtividade, redação de textos, o que for preciso. Assuma o papel de especialista no assunto perguntado sempre que fizer sentido. Seja direto e útil, em português, sem enrolação e sem markdown pesado (pode usar quebras de linha e listas simples com "-").

Histórico recente da conversa:
${historyAsText(history)}`;

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
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

async function fetchWorkspaceDb(supabaseUrl, anonKey, accessToken) {
  const rows = await restFetch(
    supabaseUrl,
    anonKey,
    accessToken,
    "/nexor_records?record_type=eq.setting&data->>key=eq.workspace&select=id,data&limit=1"
  );
  const record = rows?.[0];
  if (!record) throw new Error("Workspace não encontrado para este usuário.");
  return record;
}

async function answerQuery(supabaseUrl, anonKey, accessToken, geminiKey, question, history) {
  const record = await fetchWorkspaceDb(supabaseUrl, anonKey, accessToken);
  const db = record.data?.db || {};
  const clientNames = Object.fromEntries((db.clients || []).map(client => [client.id, client.name]));

  const finance = (db.finance || []).slice(0, 300).map(item => ({
    title: item.title,
    type: item.type,
    value: item.value,
    date: item.date,
    status: item.status,
    cliente: clientNames[item.clientId] || ""
  }));
  const tasks = (db.tasks || []).slice(0, 300).map(item => ({
    title: item.title,
    dueDate: item.dueDate,
    status: item.status,
    priority: item.priority
  }));
  const leads = (db.leads || []).slice(0, 200).map(item => ({
    name: item.name,
    stage: item.stage,
    value: item.value,
    nextDate: item.nextDate
  }));

  const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const systemPrompt = `Você é o Nex AI, assistente do Nexor (app de organização/produtividade/financeiro). Data e hora atual (America/Sao_Paulo): ${now}.

Histórico recente da conversa (use como contexto se a pergunta atual for de acompanhamento):
${historyAsText(history)}

Responda a pergunta do usuário SOMENTE com base nos dados JSON fornecidos abaixo — nunca invente valores. Se os dados não permitirem responder, diga isso claramente. Responda em português, direto, no máximo 3 frases, sem markdown.

Lançamentos financeiros (finance): ${JSON.stringify(finance)}
Tarefas (tasks): ${JSON.stringify(tasks)}
Leads (leads): ${JSON.stringify(leads)}`;

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
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

async function generateReport(supabaseUrl, anonKey, accessToken, parsed) {
  const record = await fetchWorkspaceDb(supabaseUrl, anonKey, accessToken);
  const db = record.data?.db || {};
  const clientNames = Object.fromEntries((db.clients || []).map(client => [client.id, client.name]));

  const scope = ["finance", "tasks", "leads"].includes(parsed.data.scope) ? parsed.data.scope : "finance";
  const today = new Date().toISOString().slice(0, 10);
  const startDate = parsed.data.startDate || today.slice(0, 8) + "01";
  const endDate = parsed.data.endDate || today;
  const title = parsed.data.title || `Relatório — ${scope}`;

  const PDFDocument = require("pdfkit");
  const doc = new PDFDocument({ margin: 44, size: "A4" });
  const chunks = [];
  doc.on("data", chunk => chunks.push(chunk));
  const done = new Promise(resolve => doc.on("end", resolve));

  doc.fontSize(20).text("Nexor", { continued: true }).fontSize(20).fillColor("#666").text("  •  Relatório gerado pelo Nex AI", { continued: false });
  doc.moveDown(0.3);
  doc.fillColor("#000").fontSize(16).text(title);
  doc.fontSize(10).fillColor("#666").text(`Período: ${formatDate(startDate)} a ${formatDate(endDate)}  •  Gerado em ${formatDate(today)}`);
  doc.moveDown(1);
  doc.strokeColor("#ccc").moveTo(44, doc.y).lineTo(551, doc.y).stroke();
  doc.moveDown(0.6);

  let summary = "";

  if (scope === "finance") {
    const items = (db.finance || []).filter(item => item.date >= startDate && item.date <= endDate);
    const revenue = items.filter(item => item.type === "Receita").reduce((total, item) => total + Number(item.value || 0), 0);
    const expense = items.filter(item => item.type === "Despesa").reduce((total, item) => total + Number(item.value || 0), 0);

    doc.fontSize(11).fillColor("#000");
    doc.text(`Total de receitas: ${money(revenue)}`);
    doc.text(`Total de despesas: ${money(expense)}`);
    doc.text(`Saldo do período: ${money(revenue - expense)}`);
    doc.moveDown(0.8);

    if (!items.length) {
      doc.fontSize(11).fillColor("#666").text("Nenhum lançamento encontrado nesse período.");
    } else {
      drawTableHeader(doc, ["Data", "Lançamento", "Tipo", "Valor", "Cliente"], [58, 150, 60, 80, 130]);
      items.sort((a, b) => String(a.date).localeCompare(String(b.date))).forEach(item => {
        drawTableRow(doc, [formatDate(item.date), String(item.title || ""), item.type, money(item.value), clientNames[item.clientId] || "—"], [58, 150, 60, 80, 130]);
      });
    }
    summary = `📄 Relatório financeiro gerado: ${formatDate(startDate)} a ${formatDate(endDate)} — receita ${money(revenue)}, despesa ${money(expense)}, saldo ${money(revenue - expense)}.`;
  } else if (scope === "tasks") {
    const items = (db.tasks || []).filter(item => item.dueDate >= startDate && item.dueDate <= endDate);
    const done = items.filter(item => item.status === "Concluído").length;
    doc.fontSize(11).fillColor("#000").text(`Total de tarefas no período: ${items.length} (${done} concluídas)`);
    doc.moveDown(0.8);
    if (!items.length) {
      doc.fontSize(11).fillColor("#666").text("Nenhuma tarefa encontrada nesse período.");
    } else {
      drawTableHeader(doc, ["Data", "Tarefa", "Prioridade", "Status"], [58, 230, 90, 100]);
      items.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))).forEach(item => {
        drawTableRow(doc, [formatDate(item.dueDate), String(item.title || ""), item.priority || "—", item.status || "—"], [58, 230, 90, 100]);
      });
    }
    summary = `📄 Relatório de tarefas gerado: ${formatDate(startDate)} a ${formatDate(endDate)} — ${items.length} tarefas (${done} concluídas).`;
  } else {
    const items = (db.leads || []).filter(item => item.createdAt >= startDate && item.createdAt <= endDate);
    const value = items.reduce((total, item) => total + Number(item.value || 0), 0);
    doc.fontSize(11).fillColor("#000").text(`Total de leads no período: ${items.length}  •  Valor somado: ${money(value)}`);
    doc.moveDown(0.8);
    if (!items.length) {
      doc.fontSize(11).fillColor("#666").text("Nenhum lead encontrado nesse período.");
    } else {
      drawTableHeader(doc, ["Data", "Lead", "Estágio", "Valor"], [58, 230, 110, 80]);
      items.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).forEach(item => {
        drawTableRow(doc, [formatDate(item.createdAt), String(item.name || ""), item.stage || "—", money(item.value)], [58, 230, 110, 80]);
      });
    }
    summary = `📄 Relatório de leads gerado: ${formatDate(startDate)} a ${formatDate(endDate)} — ${items.length} leads, valor total ${money(value)}.`;
  }

  doc.end();
  await done;
  const pdfBase64 = Buffer.concat(chunks).toString("base64");
  const filename = `nexor-relatorio-${scope}-${today}.pdf`;

  return { pdfBase64, filename, summary };
}

function drawTableHeader(doc, columns, widths) {
  const y = doc.y;
  let x = 44;
  doc.fontSize(9).fillColor("#666");
  columns.forEach((label, index) => {
    doc.text(label, x, y, { width: widths[index], continued: false });
    x += widths[index];
  });
  doc.moveDown(0.3);
  doc.strokeColor("#ddd").moveTo(44, doc.y).lineTo(551, doc.y).stroke();
  doc.moveDown(0.2);
}

function drawTableRow(doc, values, widths) {
  if (doc.y > 760) {
    doc.addPage();
  }
  const y = doc.y;
  let x = 44;
  doc.fontSize(9).fillColor("#111");
  values.forEach((value, index) => {
    doc.text(value, x, y, { width: widths[index], continued: false });
    x += widths[index];
  });
  doc.moveDown(0.35);
}

async function appendRecord(supabaseUrl, anonKey, accessToken, parsed) {
  const record = await fetchWorkspaceDb(supabaseUrl, anonKey, accessToken);

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
  } else if (parsed.type === "habit") {
    db.habits ||= [];
    const item = {
      id,
      name: parsed.data.name || "Hábito via Nex AI",
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
  return y && m && d ? `${d}/${m}/${y}` : String(iso || "");
}

function money(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
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
