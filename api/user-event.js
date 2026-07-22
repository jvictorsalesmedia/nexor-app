const jsonHeaders = { "Content-Type": "application/json" };
const mainAdminEmail = "jvgsales72@gmail.com";

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

    const token = String(req.headers.authorization || "").replace("Bearer ", "").trim();
    if (!token) return res.status(401).json({ error: "Missing user session." });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const action = String(body.action || "");
    if (action !== "password_changed") return res.status(400).json({ error: "Unknown action." });

    const caller = await authUser(supabaseUrl, anonKey, token);
    const profile = await restSingle(
      supabaseUrl,
      serviceKey,
      `/nexor_profiles?id=eq.${encodeURIComponent(caller.id)}&select=id,email,full_name,app_role,status`
    );
    if (!profile || profile.status !== "ativo") throw new Error("Usuario sem acesso ativo.");

    const admin = await restSingle(
      supabaseUrl,
      serviceKey,
      `/nexor_profiles?email=eq.${encodeURIComponent(mainAdminEmail)}&select=id,email,full_name&limit=1`
    );
    if (!admin?.id) throw new Error("Administrador principal nao encontrado.");

    const name = profile.full_name || caller.user_metadata?.full_name || profile.email || caller.email || "Usuario";
    const notification = {
      id: `act-${Date.now().toString(36)}`,
      label: `Senha alterada: ${name} (${profile.email || caller.email || ""})`,
      date: new Date().toISOString(),
      kind: "password_changed",
      userId: caller.id,
      userEmail: profile.email || caller.email || "",
      userName: name
    };

    await createNotificationRecord(supabaseUrl, serviceKey, admin.id, notification);
    await prependAdminActivity(supabaseUrl, serviceKey, admin.id, notification);

    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message || "Nexor user event API error." });
  }
};

async function createNotificationRecord(supabaseUrl, serviceKey, adminId, notification) {
  await restFetch(supabaseUrl, serviceKey, "/nexor_records", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: {
      owner_id: adminId,
      record_type: "notification",
      data: notification
    }
  });
}

async function prependAdminActivity(supabaseUrl, serviceKey, adminId, notification) {
  const record = await restSingle(
    supabaseUrl,
    serviceKey,
    `/nexor_records?owner_id=eq.${encodeURIComponent(adminId)}&record_type=eq.setting&data-%3E%3Ekey=eq.workspace&select=id,data&limit=1`
  );
  if (!record?.id) return;

  const data = record.data || {};
  const db = data.db || {};
  const activity = Array.isArray(db.activity) ? db.activity : [];
  db.activity = [notification, ...activity.filter(item => item.id !== notification.id)].slice(0, 60);
  data.db = db;

  await restFetch(supabaseUrl, serviceKey, `/nexor_records?id=eq.${encodeURIComponent(record.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: { data }
  });
}

async function authUser(supabaseUrl, anonKey, token) {
  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error("Sessao invalida.");
  return response.json();
}

async function restSingle(supabaseUrl, serviceKey, path) {
  const rows = await restFetch(supabaseUrl, serviceKey, path);
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
