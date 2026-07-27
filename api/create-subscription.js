const jsonHeaders = { "Content-Type": "application/json" };

const PLAN_PRICES = { basico: 30, premium: 50, pro: 75 };

// Erros "esperados" (validacao nossa ou resposta da API do Asaas) sao seguros
// pra mostrar pro usuario. Qualquer outra excecao (ex: erro nativo do fetch
// que pode embutir o valor de um header invalido na mensagem) fica só no log.
function userError(message) {
  const error = new Error(message);
  error.expose = true;
  return error;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const supabaseUrl = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
    const asaasApiKey = String(process.env.ASAAS_API_KEY || "").trim();
    if (!supabaseUrl || !serviceKey) throw new Error("Supabase server env is missing.");
    if (!asaasApiKey) throw new Error("ASAAS_API_KEY nao configurada.");
    // Detecta env var mal colada (ex: duas linhas coladas no mesmo campo) antes
    // de usar o valor num header, pra nao deixar um erro nativo do fetch
    // vazar o conteudo da chave na mensagem de erro.
    if (/\s/.test(asaasApiKey) || !asaasApiKey.startsWith("$aact_")) {
      throw new Error("ASAAS_API_KEY malformada.");
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const requestId = String(body.requestId || "").trim();
    if (!requestId) throw userError("Solicitacao nao informada.");

    const request = await restSingle(
      supabaseUrl,
      serviceKey,
      `/nexor_signup_requests?id=eq.${encodeURIComponent(requestId)}&select=*`
    );
    if (!request) throw userError("Pre-cadastro nao encontrado.");
    if (request.status !== "pendente") throw userError("Este pre-cadastro ja foi processado.");

    // Ja tem assinatura criada (ex: usuario recarregou a pagina) — so devolve
    // o link de pagamento existente em vez de criar tudo de novo no Asaas.
    if (request.asaas_subscription_id) {
      const invoiceUrl = await fetchInvoiceUrl(asaasApiKey, request.asaas_subscription_id);
      res.status(200).json({ invoiceUrl });
      return;
    }

    const plan = ["basico", "premium", "pro"].includes(request.plan) ? request.plan : "basico";
    const value = PLAN_PRICES[plan];

    const customer = await asaasFetch(asaasApiKey, "/customers", {
      method: "POST",
      body: {
        name: request.responsible_name,
        email: request.email,
        cpfCnpj: onlyDigits(request.document),
        mobilePhone: onlyDigits(request.whatsapp),
        externalReference: request.id
      }
    });

    const today = new Date().toISOString().slice(0, 10);
    const subscription = await asaasFetch(asaasApiKey, "/subscriptions", {
      method: "POST",
      body: {
        customer: customer.id,
        billingType: "UNDEFINED",
        value,
        nextDueDate: today,
        cycle: "MONTHLY",
        description: `Nexor — Plano ${planLabel(plan)}`,
        externalReference: request.id
      }
    });

    const invoiceUrl = await fetchInvoiceUrl(asaasApiKey, subscription.id);

    await restFetch(supabaseUrl, serviceKey, `/nexor_signup_requests?id=eq.${encodeURIComponent(request.id)}`, {
      method: "PATCH",
      body: {
        asaas_customer_id: customer.id,
        asaas_subscription_id: subscription.id
      }
    });

    res.status(200).json({ invoiceUrl });
  } catch (error) {
    // Nunca ecoar error.message pro cliente: pode conter detalhe interno
    // (ex: valor de header/env var invalido aparece na mensagem de erro
    // nativa do fetch). Log fica só no servidor.
    console.error("create-subscription:", error.message);
    res.status(400).json({ error: error.expose ? error.message : "Nao foi possivel gerar a cobranca. Tente novamente em instantes." });
  }
};

function planLabel(plan) {
  return { basico: "Básico", premium: "Premium", pro: "Pro" }[plan] || plan;
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

async function fetchInvoiceUrl(asaasApiKey, subscriptionId) {
  const payments = await asaasFetch(asaasApiKey, `/payments?subscription=${encodeURIComponent(subscriptionId)}&limit=1`);
  const payment = payments?.data?.[0];
  if (!payment?.invoiceUrl) throw userError("Cobranca criada, mas o link de pagamento nao foi encontrado.");
  return payment.invoiceUrl;
}

async function asaasFetch(asaasApiKey, path, options = {}) {
  const response = await fetch(`https://api.asaas.com/v3${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Nexor/1.0",
      access_token: asaasApiKey
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data?.errors?.[0]?.description || "Erro na API do Asaas.";
    throw userError(message);
  }
  return data;
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
  return Array.isArray(data) ? data : data ? [data] : [];
}
