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
    const projectId = String(body.projectId || "").trim();
    const contentType = String(body.contentType || "Vídeo").trim();
    const notes = String(body.notes || "").trim();
    if (!projectId) throw new Error("Projeto não informado.");

    await getCurrentUser(supabaseUrl, anonKey, accessToken);

    const rows = await restFetch(
      supabaseUrl,
      anonKey,
      accessToken,
      "/nexor_records?record_type=eq.setting&data->>key=eq.workspace&select=id,data&limit=1"
    );
    const record = rows?.[0];
    if (!record) throw new Error("Workspace não encontrado para este usuário.");

    const db = record.data?.db || {};
    const project = (db.projects || []).find(item => item.id === projectId);
    if (!project) throw new Error("Projeto não encontrado.");
    const client = (db.clients || []).find(item => item.id === project.clientId);

    const script = await generateScript(geminiKey, { project, client, contentType, notes });

    project.roteiros ||= [];
    const roteiro = {
      id: `roteiro_${cryptoRandomId()}`,
      title: script.title,
      contentType,
      content: script.content,
      createdAt: new Date().toISOString()
    };
    project.roteiros.unshift(roteiro);

    await restFetch(supabaseUrl, anonKey, accessToken, `/nexor_records?id=eq.${record.id}`, {
      method: "PATCH",
      body: { data: { key: "workspace", db } }
    });

    res.status(200).json({ ok: true, roteiro });
  } catch (error) {
    res.status(400).json({ error: error.message || "Não foi possível gerar o roteiro." });
  }
};

async function getCurrentUser(supabaseUrl, anonKey, accessToken) {
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) throw new Error("Sessão expirada. Faça login novamente.");
  return response.json();
}

async function generateScript(geminiKey, { project, client, contentType, notes }) {
  const systemPrompt = `Você é um roteirista/redator publicitário especialista, trabalhando dentro do Nexor (app de gestão de produção de conteúdo).

Escreva um roteiro/conteúdo do tipo "${contentType}" para o projeto abaixo. Seja específico e pronto pra gravar/publicar — nada de instruções genéricas de "grave um vídeo sobre...". Estruture com cenas/blocos quando fizer sentido pro tipo de conteúdo (ex: vídeo/reels → Gancho, Desenvolvimento, CTA; post estático → Legenda + sugestão visual).

Projeto: ${project.name || "Sem nome"}
Descrição do projeto: ${project.description || "Sem descrição"}
Cliente: ${client?.name || "Não informado"}${client?.company ? ` (${client.company})` : ""}
Observações do usuário: ${notes || "Nenhuma"}

Responda SOMENTE com um JSON válido, sem texto adicional, no formato:
{"title": "título curto do roteiro", "content": "o roteiro completo, com quebras de linha \\n onde fizer sentido"}`;

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `Gere o roteiro pedido.` }] }],
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
  return {
    title: parsed.title || `Roteiro — ${contentType}`,
    content: parsed.content || "Não foi possível gerar o conteúdo."
  };
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
