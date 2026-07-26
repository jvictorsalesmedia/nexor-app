import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const WHATSAPP_ACCESS_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "";
const WHATSAPP_PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const TEMPLATE_NAME = "lembrete_pagamento";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000)
    .toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // YYYY-MM-DD

  const rows = await restFetch(
    `/nexor_records?record_type=eq.setting&data->>key=eq.workspace&select=id,data`
  );

  let sent = 0;
  let errors = 0;

  for (const row of rows) {
    const db = row?.data?.db;
    if (!db) continue;

    const clientNames = new Map((db.clients || []).map((c: any) => [c.id, c]));
    let changed = false;

    for (const collectionName of ["projects", "productions"]) {
      const items = db[collectionName] || [];
      for (const item of items) {
        if (item.paymentDueDate !== tomorrow) continue;
        if (item.paymentReminderSentFor === tomorrow) continue;

        const client = clientNames.get(item.clientId);
        const phone = normalizePhone(client?.whatsapp);
        if (!phone) continue;

        const label = item.name || item.type || "seu trabalho";
        const ok = await sendTemplateReminder(phone, client.name || "Cliente", label, formatDateBR(tomorrow));
        if (ok) {
          item.paymentReminderSentFor = tomorrow;
          changed = true;
          sent++;
        } else {
          errors++;
        }
      }
    }

    if (changed) {
      await restFetch(`/nexor_records?id=eq.${row.id}`, {
        method: "PATCH",
        body: { data: { key: "workspace", db } }
      });
    }
  }

  return Response.json({ ok: true, date: tomorrow, sent, errors });
});

function normalizePhone(raw: string | undefined): string {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length <= 11) return `55${digits}`;
  return digits;
}

function formatDateBR(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

async function sendTemplateReminder(to: string, clientName: string, label: string, dueDateBR: string): Promise<boolean> {
  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) return false;
  try {
    const response = await fetch(`https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name: TEMPLATE_NAME,
          language: { code: "pt_BR" },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: clientName },
                { type: "text", text: label },
                { type: "text", text: dueDateBR }
              ]
            }
          ]
        }
      })
    });
    if (!response.ok) {
      console.error("payment_reminder: falha ao enviar template:", await response.text());
      return false;
    }
    return true;
  } catch (error) {
    console.error("payment_reminder: erro ao enviar:", (error as Error).message);
    return false;
  }
}

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
