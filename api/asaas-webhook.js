const jsonHeaders = { "Content-Type": "application/json" };

const PLAN_PRICES = { basico: 30, premium: 50, pro: 75 };
const CONFIRMING_EVENTS = new Set(["PAYMENT_CONFIRMED", "PAYMENT_RECEIVED"]);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Sempre responde 200 pro Asaas, mesmo em erro interno — senao ele reentrega
  // o mesmo evento em loop. Erros ficam so no log.
  try {
    const configuredToken = process.env.ASAAS_WEBHOOK_TOKEN || "";
    const receivedToken = req.headers["asaas-access-token"] || "";
    if (!configuredToken || receivedToken !== configuredToken) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
    if (!supabaseUrl || !serviceKey) throw new Error("Supabase server env is missing.");

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const event = body.event;
    const payment = body.payment;

    if (!CONFIRMING_EVENTS.has(event) || !payment?.subscription) {
      res.status(200).json({ ok: true, skipped: true });
      return;
    }

    const request = await restSingle(
      supabaseUrl,
      serviceKey,
      `/nexor_signup_requests?asaas_subscription_id=eq.${encodeURIComponent(payment.subscription)}&select=*`
    );
    if (!request || request.status !== "pendente") {
      res.status(200).json({ ok: true, skipped: true });
      return;
    }

    const plan = ["basico", "premium", "pro"].includes(request.plan) ? request.plan : "basico";
    const businessName = request.business_name || `Conta ${request.responsible_name || request.email.split("@")[0]}`;
    const responsibleName = request.responsible_name || request.email.split("@")[0];
    const accessUsername = request.access_username || request.email.split("@")[0];
    const slug = slugify(`${businessName}-${String(request.id).slice(0, 8)}`);

    const tempPassword = generateTempPassword();
    const auth = await authAdmin(supabaseUrl, serviceKey, "/admin/users", {
      method: "POST",
      body: {
        email: request.email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: {
          full_name: responsibleName,
          business_name: businessName,
          access_username: accessUsername,
          slug
        }
      }
    });
    const user = auth.user || auth;
    if (!user?.id) throw new Error("Usuario nao foi criado no Supabase Auth.");

    await upsertProfile(supabaseUrl, serviceKey, {
      id: user.id,
      email: request.email,
      full_name: responsibleName,
      gender: "neutral",
      app_role: "cliente",
      status: "ativo"
    });

    const today = new Date().toISOString().slice(0, 10);
    const client = await upsertClient(supabaseUrl, serviceKey, {
      auth_user_id: user.id,
      business_name: businessName,
      responsible_name: responsibleName,
      document: request.document || "",
      email: request.email,
      whatsapp: request.whatsapp || "",
      access_username: accessUsername,
      slug,
      plan,
      monthly_value: PLAN_PRICES[plan],
      subscription_status: "pago",
      payment_due_date: payment.nextDueDate || null,
      last_payment_date: today,
      asaas_customer_id: request.asaas_customer_id,
      asaas_subscription_id: request.asaas_subscription_id,
      notes: "Criado automaticamente apos confirmacao de pagamento (Asaas).",
      login_blocked: false
    });

    await restFetch(supabaseUrl, serviceKey, `/nexor_signup_requests?id=eq.${encodeURIComponent(request.id)}`, {
      method: "PATCH",
      body: {
        status: "aprovado",
        decision_note: "Aprovado automaticamente apos pagamento confirmado.",
        reviewed_at: new Date().toISOString(),
        created_client_id: client.id,
        auth_user_id: user.id
      }
    });

    try {
      await sendCredentialsEmail(request.email, tempPassword);
    } catch (error) {
      console.error("asaas_webhook: falha ao enviar email:", error.message);
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("asaas_webhook: erro:", error.message);
    res.status(200).json({ ok: true });
  }
};

function generateTempPassword() {
  const crypto = require("crypto");
  return crypto.randomBytes(8).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || `cliente-${Date.now().toString(36)}`;
}

async function sendCredentialsEmail(email, password) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("GMAIL_USER/GMAIL_APP_PASSWORD nao configurados.");

  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass }
  });

  await transporter.sendMail({
    from: `Nexor <${user}>`,
    to: email,
    subject: "Pagamento confirmado — acesso liberado no Nexor",
    text: `Seu pagamento foi confirmado e o acesso ao Nexor já está liberado. Usuário: ${email}. Senha provisória: ${password}. Para mais dúvidas, 5522998229144`
  });
}

async function authAdmin(supabaseUrl, serviceKey, path, options = {}) {
  const response = await fetch(`${supabaseUrl}/auth/v1${path}`, {
    method: options.method || "GET",
    headers: { ...jsonHeaders, apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.msg || data.error_description || data.error || text || "Erro Auth Admin.");
  return data;
}

async function restSingle(supabaseUrl, serviceKey, path) {
  const rows = await restFetch(supabaseUrl, serviceKey, path);
  return Array.isArray(rows) ? rows[0] : rows;
}

async function upsertProfile(supabaseUrl, serviceKey, body) {
  return upsertRest(supabaseUrl, serviceKey, "/nexor_profiles?on_conflict=id", body);
}

async function upsertClient(supabaseUrl, serviceKey, body) {
  return upsertRest(supabaseUrl, serviceKey, "/nexor_clients?on_conflict=id", body);
}

async function upsertRest(supabaseUrl, serviceKey, path, body) {
  const rows = await restFetch(supabaseUrl, serviceKey, path, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body
  });
  return Array.isArray(rows) ? rows[0] : rows;
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
  return Array.isArray(data) ? data : data ? [data] : [];
}
