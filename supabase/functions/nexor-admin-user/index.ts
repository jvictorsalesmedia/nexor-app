import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

const mainAdminEmail = "jvgsales72@gmail.com";
const allowedRoles = new Set(["gestor", "colaborador"]);
const allowedGenders = new Set(["male", "female", "neutral"]);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return json({ ok: true });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_SECRET_KEY") ||
    "";

  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "Missing Supabase server secrets" }, 500);
  }

  const bearer = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
  if (!bearer) {
    return json({ error: "Missing bearer token" }, 401);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false }
  });

  const { data: callerData, error: callerError } = await admin.auth.getUser(bearer);
  if (callerError || !callerData.user) {
    return json({ error: "Invalid session" }, 401);
  }

  const { data: callerProfile, error: profileError } = await admin
    .from("nexor_profiles")
    .select("id, app_role, status")
    .eq("id", callerData.user.id)
    .maybeSingle();

  if (profileError) {
    return json({ error: profileError.message }, 500);
  }
  if (!callerProfile || callerProfile.app_role !== "admin" || callerProfile.status !== "ativo") {
    return json({ error: "Admin access required" }, 403);
  }

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");

  if (action === "create") return createUser(admin, body, callerData.user.id);
  if (action === "update_password") return updatePassword(admin, body, callerData.user.id);
  if (action === "set_status") return setStatus(admin, body, callerData.user.id);
  if (action === "delete") return deleteUser(admin, body, callerData.user.id);

  return json({ error: "Unknown action" }, 400);
});

async function createUser(
  admin: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  callerId: string
) {
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const name = String(body.name || "").trim();
  const gender = allowedGenders.has(String(body.gender)) ? String(body.gender) : "neutral";
  const role = allowedRoles.has(String(body.role)) ? String(body.role) : "colaborador";

  if (!name || !email || password.length < 6) {
    return json({ error: "Name, email and a password with at least 6 characters are required" }, 400);
  }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name, gender }
  });

  if (error) {
    return json({ error: error.message }, 400);
  }

  const userId = data.user?.id;
  if (!userId) {
    return json({ error: "User not created" }, 500);
  }

  const { data: profile, error: upsertError } = await admin
    .from("nexor_profiles")
    .upsert(
      {
        id: userId,
        email,
        full_name: name,
        gender,
        app_role: role,
        status: "ativo"
      },
      { onConflict: "id" }
    )
    .select()
    .single();

  if (upsertError) {
    return json({ error: upsertError.message }, 500);
  }

  const passwordError = await savePasswordNote(admin, userId, password, callerId);
  if (passwordError) {
    return json({ error: passwordError }, 500);
  }

  return json({ profile });
}

async function updatePassword(
  admin: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  callerId: string
) {
  const userId = String(body.userId || "");
  const password = String(body.password || "");

  if (!userId || password.length < 6) {
    return json({ error: "User id and a password with at least 6 characters are required" }, 400);
  }

  const protectedError = await mutableUserError(admin, userId, callerId);
  if (protectedError) {
    return json({ error: protectedError }, 403);
  }

  const { error } = await admin.auth.admin.updateUserById(userId, { password });
  if (error) {
    return json({ error: error.message }, 400);
  }

  const passwordError = await savePasswordNote(admin, userId, password, callerId);
  if (passwordError) {
    return json({ error: passwordError }, 500);
  }

  return json({ ok: true });
}

async function setStatus(
  admin: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  callerId: string
) {
  const userId = String(body.userId || "");
  const status = String(body.status || "") === "inativo" ? "inativo" : "ativo";

  if (!userId) {
    return json({ error: "User id is required" }, 400);
  }

  const protectedError = await mutableUserError(admin, userId, callerId);
  if (protectedError) {
    return json({ error: protectedError }, 403);
  }

  const { data, error } = await admin
    .from("nexor_profiles")
    .update({ status })
    .eq("id", userId)
    .select()
    .single();

  if (error) {
    return json({ error: error.message }, 400);
  }

  return json({ profile: data });
}

async function deleteUser(
  admin: ReturnType<typeof createClient>,
  body: Record<string, unknown>,
  callerId: string
) {
  const userId = String(body.userId || "");
  if (!userId) {
    return json({ error: "User id is required" }, 400);
  }

  const protectedError = await mutableUserError(admin, userId, callerId);
  if (protectedError) {
    return json({ error: protectedError }, 403);
  }

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    return json({ error: error.message }, 400);
  }

  return json({ ok: true });
}

async function mutableUserError(
  admin: ReturnType<typeof createClient>,
  userId: string,
  callerId: string
) {
  if (userId === callerId) {
    return "The current admin cannot change their own access from this panel";
  }

  const { data, error } = await admin
    .from("nexor_profiles")
    .select("email")
    .eq("id", userId)
    .maybeSingle();

  if (error) return error.message;
  if (!data) return "User not found";
  if (String(data.email || "").toLowerCase() === mainAdminEmail) {
    return "Main admin access is protected";
  }

  return "";
}

async function savePasswordNote(
  admin: ReturnType<typeof createClient>,
  userId: string,
  password: string,
  updatedBy: string
) {
  const { error } = await admin
    .from("nexor_user_password_notes")
    .upsert(
      {
        user_id: userId,
        password_note: password,
        updated_by: updatedBy
      },
      { onConflict: "user_id" }
    );

  return error?.message || "";
}

function json(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: corsHeaders });
}
