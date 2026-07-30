const { userError, sendSafeError } = require("./_lib/safe-error");
const { checkRateLimit, getClientIp } = require("./_lib/rate-limit");

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
    const slug = String(body.slug || "").trim().toLowerCase();
    const identifier = String(body.identifier || "").trim().toLowerCase();
    if (!slug || !identifier) throw userError("Informe o link e o usuário de acesso.");

    // So confirma existencia/dados do cliente, nao e destrutivo — limite mais
    // permissivo que o do forgot-password, so pra evitar varredura em massa.
    const byIdentifier = await checkRateLimit(supabaseUrl, serviceKey, "resolve-client-login:id", `${slug}:${identifier}`, { max: 10, windowSeconds: 900 });
    const byIp = await checkRateLimit(supabaseUrl, serviceKey, "resolve-client-login:ip", getClientIp(req), { max: 30, windowSeconds: 900 });
    if (!byIdentifier.allowed || !byIp.allowed) {
      res.status(429).json({ error: "Muitas tentativas. Tente novamente mais tarde." });
      return;
    }

    const rows = await restFetch(
      supabaseUrl,
      serviceKey,
      `/nexor_clients?slug=eq.${encodeURIComponent(slug)}&or=(access_username.eq.${encodeURIComponent(identifier)},email.eq.${encodeURIComponent(identifier)})&select=*`
    );
    const client = rows[0];
    if (!client) return res.status(404).json({ error: "Cliente ou usuário de acesso não encontrado." });

    const state = clientAccessState(client);
    if (!state.allowed) {
      return res.status(403).json({ allowed: false, reason: state.reason });
    }

    res.status(200).json({
      allowed: true,
      email: client.email,
      businessName: client.business_name,
      slug: client.slug
    });
  } catch (error) {
    sendSafeError(res, error, "Não foi possível resolver o login.");
  }
};

async function restFetch(supabaseUrl, serviceKey, path) {
  const response = await fetch(`${supabaseUrl}/rest/v1${path}`, {
    headers: {
      ...jsonHeaders,
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.message || data?.hint || text || "Erro PostgREST.");
  return Array.isArray(data) ? data : [];
}

function clientAccessState(client) {
  const lateDays = businessDaysLate(client.payment_due_date);
  if (client.login_blocked) return { allowed: false, reason: "Login bloqueado pelo administrador.", lateDays };
  if (client.subscription_status === "pago") return { allowed: true, reason: "Assinatura paga.", lateDays };
  if (lateDays > 1) return { allowed: false, reason: "Mensalidade com atraso maior que 1 dia útil.", lateDays };
  return { allowed: true, reason: "Mensalidade dentro da tolerância.", lateDays };
}

function businessDaysLate(dateValue) {
  if (!dateValue) return 0;
  const due = new Date(`${dateValue}T12:00:00`);
  const now = new Date();
  const reference = new Date(`${now.toISOString().slice(0, 10)}T12:00:00`);
  if (Number.isNaN(due.getTime()) || reference <= due) return 0;
  let count = 0;
  const cursor = new Date(due);
  cursor.setDate(cursor.getDate() + 1);
  while (cursor <= reference) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}
