const jsonHeaders = { "Content-Type": "application/json" };
const mainAdminEmail = "jvgsales72@gmail.com";
const allowedRoles = new Set(["gestor", "colaborador"]);
const allowedGenders = new Set(["male", "female", "neutral"]);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
    const anonKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || serviceKey;
    if (!supabaseUrl || !serviceKey) throw new Error("Supabase server env is missing.");

    // Usado como redirect_to dos emails de convite/recuperação — o Supabase
    // acrescenta os tokens de sessão no hash da URL de destino.
    const siteOrigin = (
      req.headers.origin ||
      (req.headers.host ? `https://${req.headers.host}` : "") ||
      process.env.PUBLIC_SITE_URL ||
      ""
    ).replace(/\/$/, "");
    if (!siteOrigin) throw new Error("Nao foi possivel determinar a URL do site para o convite.");

    const token = String(req.headers.authorization || "").replace("Bearer ", "").trim();
    if (!token) return res.status(401).json({ error: "Missing admin session." });

    const caller = await authUser(supabaseUrl, anonKey, token);
    const profile = await restSingle(supabaseUrl, serviceKey, `/nexor_profiles?id=eq.${encodeURIComponent(caller.id)}&select=id,email,app_role,status`);
    if (!profile || profile.app_role !== "admin" || profile.status !== "ativo") {
      return res.status(403).json({ error: "Admin access required." });
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const action = String(body.action || "");
    if (action === "create_client") return res.status(200).json(await createClientAccount(supabaseUrl, serviceKey, body, caller.id, siteOrigin));
    if (action === "update_client") return res.status(200).json(await updateClientAccount(supabaseUrl, serviceKey, body, caller.id));
    if (action === "delete_client") return res.status(200).json(await deleteClientAccount(supabaseUrl, serviceKey, body));
    if (action === "set_client_subscription") return res.status(200).json(await setClientSubscription(supabaseUrl, serviceKey, body));
    if (action === "set_client_login") return res.status(200).json(await setClientLogin(supabaseUrl, serviceKey, body));
    if (action === "reset_client_password") return res.status(200).json(await resetClientPassword(supabaseUrl, serviceKey, anonKey, body, siteOrigin));
    if (action === "create") return res.status(200).json(await createTeamUser(supabaseUrl, serviceKey, body, caller.id, siteOrigin));
    if (action === "update_password") return res.status(200).json(await updateTeamUserPassword(supabaseUrl, serviceKey, anonKey, body, caller.id, siteOrigin));
    if (action === "set_status") return res.status(200).json(await setTeamUserStatus(supabaseUrl, serviceKey, body, caller.id));
    if (action === "delete") return res.status(200).json(await deleteTeamUser(supabaseUrl, serviceKey, body, caller.id));
    if (action === "list_signup_requests") return res.status(200).json(await listSignupRequests(supabaseUrl, serviceKey));
    if (action === "approve_signup_request") return res.status(200).json(await approveSignupRequest(supabaseUrl, serviceKey, body, caller.id));
    if (action === "reject_signup_request") return res.status(200).json(await rejectSignupRequest(supabaseUrl, serviceKey, body, caller.id));

    res.status(400).json({ error: "Unknown action." });
  } catch (error) {
    res.status(400).json({ error: error.message || "Nexor admin API error." });
  }
};

async function createTeamUser(supabaseUrl, serviceKey, body, callerId, siteOrigin) {
  const payload = normalizeTeamUserPayload(body);
  if (!payload.name || !payload.email) {
    throw new Error("Informe nome e e-mail.");
  }

  const redirectTo = `${siteOrigin}/`;
  const auth = await authAdmin(supabaseUrl, serviceKey, `/invite?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: "POST",
    body: {
      email: payload.email,
      data: {
        full_name: payload.name,
        gender: payload.gender
      }
    }
  });
  const user = auth.user || auth;
  if (!user?.id) throw new Error("Usuario nao foi criado no Supabase Auth.");

  const profile = await upsertProfile(supabaseUrl, serviceKey, {
    id: user.id,
    email: payload.email,
    full_name: payload.name,
    gender: payload.gender,
    app_role: payload.role,
    status: "ativo"
  });

  return { profile };
}

async function updateTeamUserPassword(supabaseUrl, serviceKey, anonKey, body, callerId, siteOrigin) {
  const userId = String(body.userId || "");
  if (!userId) throw new Error("Usuario nao informado.");

  const protectedError = await mutableUserError(supabaseUrl, serviceKey, userId, callerId);
  if (protectedError) throw new Error(protectedError);

  const profile = await restSingle(supabaseUrl, serviceKey, `/nexor_profiles?id=eq.${encodeURIComponent(userId)}&select=email`);
  if (!profile?.email) throw new Error("Usuario nao encontrado.");

  const redirectTo = `${siteOrigin}/`;
  await authAdmin(supabaseUrl, anonKey, `/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: "POST",
    body: { email: profile.email }
  });
  return { ok: true };
}

async function setTeamUserStatus(supabaseUrl, serviceKey, body, callerId) {
  const userId = String(body.userId || "");
  if (!userId) throw new Error("Usuario nao informado.");

  const protectedError = await mutableUserError(supabaseUrl, serviceKey, userId, callerId);
  if (protectedError) throw new Error(protectedError);

  const status = String(body.status || "") === "inativo" ? "inativo" : "ativo";
  const profile = await restPatch(supabaseUrl, serviceKey, `/nexor_profiles?id=eq.${encodeURIComponent(userId)}`, { status });
  return { profile };
}

async function deleteTeamUser(supabaseUrl, serviceKey, body, callerId) {
  const userId = String(body.userId || "");
  if (!userId) throw new Error("Usuario nao informado.");

  const protectedError = await mutableUserError(supabaseUrl, serviceKey, userId, callerId);
  if (protectedError) throw new Error(protectedError);

  await authAdmin(supabaseUrl, serviceKey, `/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
  return { ok: true };
}

async function listSignupRequests(supabaseUrl, serviceKey) {
  const rows = await restFetch(
    supabaseUrl,
    serviceKey,
    "/nexor_signup_requests?select=*&order=created_at.desc&limit=100"
  );
  return { requests: rows || [] };
}

async function approveSignupRequest(supabaseUrl, serviceKey, body, callerId) {
  const request = await restSingle(
    supabaseUrl,
    serviceKey,
    `/nexor_signup_requests?id=eq.${encodeURIComponent(body.requestId || "")}&select=*`
  );
  if (!request) throw new Error("Pre-cadastro nao encontrado.");
  if (request.status !== "pendente") throw new Error("Este pre-cadastro ja foi analisado.");

  const businessName = request.business_name || `Conta ${request.responsible_name || request.email.split("@")[0]}`;
  const responsibleName = request.responsible_name || request.email.split("@")[0];
  const accessUsername = request.access_username || request.email.split("@")[0];
  const slug = slugify(body.slug || `${businessName}-${String(request.id).slice(0, 8)}`);

  // A conta so eh criada agora, na aprovacao, com uma senha provisoria
  // aleatoria que so vai pro email da pessoa — nunca fica guardada por nos.
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

  const client = await upsertClient(supabaseUrl, serviceKey, {
    auth_user_id: user.id,
    business_name: businessName,
    responsible_name: responsibleName,
    document: request.document || "",
    email: request.email,
    whatsapp: request.whatsapp || "",
    access_username: accessUsername,
    slug,
    monthly_value: body.monthlyValue || 0,
    subscription_status: body.subscriptionStatus || "pendente",
    payment_due_date: body.paymentDueDate || null,
    last_payment_date: body.lastPaymentDate || null,
    notes: [body.notes, "Criado a partir de pre-cadastro aprovado."].filter(Boolean).join("\n"),
    login_blocked: false,
    created_by: callerId
  });

  const updated = await restPatch(
    supabaseUrl,
    serviceKey,
    `/nexor_signup_requests?id=eq.${encodeURIComponent(request.id)}`,
    {
      status: "aprovado",
      decision_note: String(body.notes || ""),
      reviewed_by: callerId,
      reviewed_at: new Date().toISOString(),
      created_client_id: client.id,
      auth_user_id: user.id
    }
  );

  try {
    await sendCredentialsEmail(request.email, tempPassword, { reset: false });
  } catch (error) {
    console.error("Falha ao enviar email de aprovacao:", error.message);
  }

  return { request: updated, client };
}

async function rejectSignupRequest(supabaseUrl, serviceKey, body, callerId) {
  const requestId = String(body.requestId || "");
  if (!requestId) throw new Error("Pre-cadastro nao informado.");

  const request = await restPatch(
    supabaseUrl,
    serviceKey,
    `/nexor_signup_requests?id=eq.${encodeURIComponent(requestId)}`,
    {
      status: "reprovado",
      decision_note: String(body.note || ""),
      reviewed_by: callerId,
      reviewed_at: new Date().toISOString()
    }
  );

  return { request };
}

function generateTempPassword() {
  const crypto = require("crypto");
  // 10 caracteres alfanumericos, gerados com crypto (nao Math.random) —
  // suficiente pra uma senha provisoria que a pessoa vai trocar depois.
  return crypto.randomBytes(8).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
}

async function sendCredentialsEmail(email, password, { reset }) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("GMAIL_USER/GMAIL_APP_PASSWORD nao configurados.");

  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass }
  });

  const text = reset
    ? `Sua senha foi redefinida. Usuário: ${email}. Nova senha provisória: ${password}. Para mais dúvidas, 5522998229144`
    : `Você já pode acessar o Nexor. Usuário: ${email}. Senha provisória: ${password}. Para mais dúvidas, 5522998229144`;

  await transporter.sendMail({
    from: `Nexor <${user}>`,
    to: email,
    subject: reset ? "Senha redefinida — Nexor" : "Acesso liberado — Nexor",
    text
  });
}

function normalizeTeamUserPayload(body) {
  const role = allowedRoles.has(String(body.role)) ? String(body.role) : "colaborador";
  const gender = allowedGenders.has(String(body.gender)) ? String(body.gender) : "neutral";
  return {
    name: String(body.name || "").trim(),
    email: String(body.email || "").trim().toLowerCase(),
    gender,
    role
  };
}

async function mutableUserError(supabaseUrl, serviceKey, userId, callerId) {
  if (userId === callerId) return "O administrador atual nao pode alterar o proprio acesso por aqui.";
  const profile = await restSingle(supabaseUrl, serviceKey, `/nexor_profiles?id=eq.${encodeURIComponent(userId)}&select=id,email,app_role`);
  if (!profile) return "Usuario nao encontrado.";
  if (String(profile.email || "").toLowerCase() === mainAdminEmail || profile.app_role === "admin") {
    return "O acesso do administrador principal e protegido.";
  }
  return "";
}

async function createClientAccount(supabaseUrl, serviceKey, body, callerId, siteOrigin) {
  const payload = normalizeClientPayload(body);
  if (!payload.businessName || !payload.responsibleName || !payload.email || !payload.accessUsername) {
    throw new Error("Campos obrigatórios ausentes.");
  }

  // Convite por email: a pessoa define a própria senha ao clicar no link. O
  // redirect leva direto para a área do cliente recém-criado.
  const redirectTo = `${siteOrigin}/cliente/${encodeURIComponent(payload.slug)}`;
  const auth = await authAdmin(supabaseUrl, serviceKey, `/invite?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: "POST",
    body: {
      email: payload.email,
      data: {
        full_name: payload.responsibleName,
        business_name: payload.businessName,
        access_username: payload.accessUsername,
        slug: payload.slug
      }
    }
  });
  const user = auth.user || auth;
  if (!user?.id) throw new Error("Usuário não foi criado no Supabase Auth.");

  await upsertProfile(supabaseUrl, serviceKey, {
    id: user.id,
    email: payload.email,
    full_name: payload.responsibleName,
    gender: "neutral",
    app_role: "cliente",
    status: "ativo"
  });

  const client = await upsertClient(supabaseUrl, serviceKey, {
    auth_user_id: user.id,
    business_name: payload.businessName,
    responsible_name: payload.responsibleName,
    document: payload.document,
    email: payload.email,
    whatsapp: payload.whatsapp,
    access_username: payload.accessUsername,
    slug: payload.slug,
    monthly_value: payload.monthlyValue,
    subscription_status: payload.subscriptionStatus,
    payment_due_date: payload.paymentDueDate || null,
    last_payment_date: payload.lastPaymentDate || null,
    notes: payload.notes,
    login_blocked: false,
    created_by: callerId
  });

  return { client };
}

async function updateClientAccount(supabaseUrl, serviceKey, body, callerId) {
  const payload = normalizeClientPayload(body);
  const client = await restSingle(supabaseUrl, serviceKey, `/nexor_clients?id=eq.${encodeURIComponent(payload.id)}&select=*`);
  if (!client) throw new Error("Cliente não encontrado.");

  const authPatch = {
    email: payload.email,
    user_metadata: {
      full_name: payload.responsibleName,
      business_name: payload.businessName,
      access_username: payload.accessUsername,
      slug: payload.slug
    }
  };
  await authAdmin(supabaseUrl, serviceKey, `/admin/users/${client.auth_user_id}`, {
    method: "PUT",
    body: authPatch
  });

  await upsertProfile(supabaseUrl, serviceKey, {
    id: client.auth_user_id,
    email: payload.email,
    full_name: payload.responsibleName,
    gender: "neutral",
    app_role: "cliente",
    status: "ativo"
  });

  const updated = await upsertClient(supabaseUrl, serviceKey, {
    id: client.id,
    auth_user_id: client.auth_user_id,
    business_name: payload.businessName,
    responsible_name: payload.responsibleName,
    document: payload.document,
    email: payload.email,
    whatsapp: payload.whatsapp,
    access_username: payload.accessUsername,
    slug: payload.slug,
    monthly_value: payload.monthlyValue,
    subscription_status: payload.subscriptionStatus,
    payment_due_date: payload.paymentDueDate || null,
    last_payment_date: payload.lastPaymentDate || null,
    notes: payload.notes,
    login_blocked: Boolean(client.login_blocked)
  });

  return { client: updated };
}

async function resetClientPassword(supabaseUrl, serviceKey, anonKey, body, siteOrigin) {
  const client = await restSingle(supabaseUrl, serviceKey, `/nexor_clients?id=eq.${encodeURIComponent(body.clientId || "")}&select=id,email,slug`);
  if (!client) throw new Error("Cliente não encontrado.");

  // /recover é o endpoint certo para usuário que já existe (o /invite rejeita
  // quem já confirmou a conta). Usa a anon key, como o GoTrue espera nesse
  // endpoint público de "esqueci minha senha".
  const redirectTo = `${siteOrigin}/cliente/${encodeURIComponent(client.slug)}`;
  await authAdmin(supabaseUrl, anonKey, `/recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
    method: "POST",
    body: { email: client.email }
  });
  return { ok: true };
}

async function deleteClientAccount(supabaseUrl, serviceKey, body) {
  const client = await restSingle(supabaseUrl, serviceKey, `/nexor_clients?id=eq.${encodeURIComponent(body.clientId || "")}&select=*`);
  if (!client) throw new Error("Cliente não encontrado.");
  await authAdmin(supabaseUrl, serviceKey, `/admin/users/${client.auth_user_id}`, { method: "DELETE" });
  return { ok: true };
}

async function setClientSubscription(supabaseUrl, serviceKey, body) {
  const status = ["pago", "pendente", "atrasado"].includes(body.subscriptionStatus) ? body.subscriptionStatus : "pendente";
  const patch = {
    subscription_status: status,
    last_payment_date: body.lastPaymentDate || null
  };
  if (status === "pago") patch.login_blocked = false;
  const client = await restPatch(supabaseUrl, serviceKey, `/nexor_clients?id=eq.${encodeURIComponent(body.clientId || "")}`, patch);
  return { client };
}

async function setClientLogin(supabaseUrl, serviceKey, body) {
  const client = await restPatch(supabaseUrl, serviceKey, `/nexor_clients?id=eq.${encodeURIComponent(body.clientId || "")}`, {
    login_blocked: Boolean(body.loginBlocked)
  });
  return { client };
}

function normalizeClientPayload(body) {
  const businessName = String(body.businessName || "").trim();
  return {
    id: String(body.id || body.clientId || ""),
    businessName,
    responsibleName: String(body.responsibleName || "").trim(),
    document: String(body.document || "").trim(),
    email: String(body.email || "").trim().toLowerCase(),
    whatsapp: String(body.whatsapp || "").trim(),
    accessUsername: String(body.accessUsername || "").trim().toLowerCase(),
    monthlyValue: Number(body.monthlyValue || 0),
    subscriptionStatus: ["pago", "pendente", "atrasado"].includes(body.subscriptionStatus) ? body.subscriptionStatus : "pendente",
    paymentDueDate: String(body.paymentDueDate || ""),
    lastPaymentDate: String(body.lastPaymentDate || ""),
    notes: String(body.notes || "").trim(),
    slug: slugify(body.slug || businessName)
  };
}

async function authUser(supabaseUrl, anonKey, token) {
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error("Sessão inválida.");
  return response.json();
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

async function restPatch(supabaseUrl, serviceKey, path, body) {
  const rows = await restFetch(supabaseUrl, serviceKey, path, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body
  });
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
  return data;
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
