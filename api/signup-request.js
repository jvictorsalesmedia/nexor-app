const jsonHeaders = { "Content-Type": "application/json" };

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
    if (!supabaseUrl || !serviceKey) throw new Error("Supabase server env is missing.");

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const payload = normalizeSignupRequest(body);
    validateSignupRequest(payload);

    const existingClients = await restFetch(
      supabaseUrl,
      serviceKey,
      `/nexor_clients?or=(email.eq.${encodeURIComponent(payload.email)},access_username.eq.${encodeURIComponent(payload.accessUsername)})&select=id&limit=1`
    );
    if (existingClients.length) {
      res.status(409).json({ error: "Ja existe uma conta com este e-mail ou usuario de acesso." });
      return;
    }

    // Nao cria nenhuma conta nem senha aqui — isso so acontece na aprovacao
    // (api/admin-client.js gera uma senha provisoria aleatoria e manda por
    // email). O pre-cadastro so guarda os dados do pedido, pendente.
    const rows = await restFetch(supabaseUrl, serviceKey, "/nexor_signup_requests", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: {
        business_name: payload.businessName,
        responsible_name: payload.responsibleName,
        document: payload.document,
        email: payload.email,
        whatsapp: payload.whatsapp,
        access_username: payload.accessUsername,
        responsible_photo_data_url: payload.photoDataUrl,
        status: "pendente"
      }
    });

    res.status(200).json({ request: rows[0] });
  } catch (error) {
    const message = error.message || "Nao foi possivel enviar o pre-cadastro.";
    const status = /duplicate|unique|nexor_signup_requests_pending_email/i.test(message) ? 409 : 400;
    res.status(status).json({ error: status === 409 ? "Ja existe um pre-cadastro pendente para este e-mail." : message });
  }
};

function normalizeSignupRequest(body) {
  const email = String(body.email || "").trim().toLowerCase();
  const businessName = String(body.businessName || "").trim();
  const accessUsername = String(body.accessUsername || email.split("@")[0] || "").trim().toLowerCase();
  return {
    businessName,
    responsibleName: String(body.responsibleName || "").trim(),
    document: String(body.document || "").trim(),
    email,
    whatsapp: String(body.whatsapp || "").trim(),
    accessUsername,
    photoDataUrl: String(body.photoDataUrl || "")
  };
}

function validateSignupRequest(payload) {
  if (!payload.responsibleName || !payload.email) {
    throw new Error("Informe nome do responsavel e e-mail.");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
    throw new Error("Informe um e-mail valido.");
  }
  if (!payload.photoDataUrl || !/^data:image\/(png|jpe?g|webp);base64,/i.test(payload.photoDataUrl)) {
    throw new Error("Envie uma foto do responsavel.");
  }
  if (payload.photoDataUrl.length > 1800000) {
    throw new Error("A foto esta muito grande. Envie uma imagem menor.");
  }
}

async function restFetch(supabaseUrl, serviceKey, path, options = {}) {
  const response = await fetch(`${supabaseUrl}/rest/v1${path}`, {
    method: options.method || "GET",
    headers: {
      ...jsonHeaders,
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.message || data?.hint || text || "Erro PostgREST.");
  return Array.isArray(data) ? data : [];
}
