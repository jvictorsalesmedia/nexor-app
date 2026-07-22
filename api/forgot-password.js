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
    const identifier = String(body.identifier || "").trim().toLowerCase();
    if (!identifier) throw new Error("Informe seu email ou usuário de acesso.");

    const clients = await restFetch(
      supabaseUrl,
      serviceKey,
      `/nexor_clients?or=(email.eq.${encodeURIComponent(identifier)},access_username.eq.${encodeURIComponent(identifier)})&select=auth_user_id,email&limit=1`
    );
    const client = clients[0];

    // Sempre responde "ok" mesmo se nao encontrar nada — evita confirmar pra
    // quem esta tentando adivinhar quais emails/usuarios existem no sistema.
    if (!client) {
      res.status(200).json({ ok: true });
      return;
    }

    const tempPassword = generateTempPassword();
    await authAdmin(supabaseUrl, serviceKey, `/admin/users/${client.auth_user_id}`, {
      method: "PUT",
      body: { password: tempPassword }
    });

    try {
      await sendResetEmail(client.email, tempPassword);
    } catch (error) {
      console.error("Falha ao enviar email de redefinicao:", error.message);
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message || "Nao foi possivel redefinir a senha." });
  }
};

function generateTempPassword() {
  const crypto = require("crypto");
  return crypto.randomBytes(8).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
}

async function sendResetEmail(email, password) {
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
    subject: "Senha redefinida — Nexor",
    text: `Sua senha foi redefinida. Usuário: ${email}. Nova senha provisória: ${password}. Para mais dúvidas, 5522998229144`
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
