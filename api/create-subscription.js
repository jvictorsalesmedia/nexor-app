const { userError, sendSafeError } = require("./_lib/safe-error");
const { checkRateLimit, getClientIp } = require("./_lib/rate-limit");

const jsonHeaders = { "Content-Type": "application/json" };

const PLAN_PRICES = { basico: 30, premium: 50, pro: 75 };

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
    const email = String(body.email || "").trim().toLowerCase();
    if (!requestId && !email) throw userError("Informe a solicitacao ou o e-mail.");

    let request;
    if (requestId) {
      request = await restSingle(
        supabaseUrl,
        serviceKey,
        `/nexor_signup_requests?id=eq.${encodeURIComponent(requestId)}&select=*`
      );
    } else {
      // Caminho de "retomar pagamento": publico e so identificado por
      // e-mail, entao precisa de rate limit pra nao virar oraculo de
      // enumeracao nem jeito de spammar reenvio de email.
      const byIdentifier = await checkRateLimit(supabaseUrl, serviceKey, "resume-signup:id", email, { max: 5, windowSeconds: 3600 });
      const byIp = await checkRateLimit(supabaseUrl, serviceKey, "resume-signup:ip", getClientIp(req), { max: 20, windowSeconds: 3600 });
      if (!byIdentifier.allowed || !byIp.allowed) {
        res.status(429).json({ error: "Muitas tentativas. Tente novamente mais tarde." });
        return;
      }
      request = await restSingle(
        supabaseUrl,
        serviceKey,
        `/nexor_signup_requests?email=eq.${encodeURIComponent(email)}&status=eq.pendente&order=created_at.desc&limit=1&select=*`
      );
    }
    if (!request) throw userError("Pre-cadastro nao encontrado.");
    if (request.status !== "pendente") throw userError("Este pre-cadastro ja foi processado.");

    // Ja tem assinatura criada (ex: usuario recarregou a pagina, ou clicou em
    // "retomar pagamento") — so devolve o link existente em vez de criar
    // tudo de novo no Asaas, e sem reenviar o email de cobranca.
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

    try {
      await sendInvoiceEmail(request.email, invoiceUrl, request.business_name);
    } catch (error) {
      console.error("create-subscription: falha ao enviar email de cobranca:", error.message);
    }

    res.status(200).json({ invoiceUrl });
  } catch (error) {
    sendSafeError(res, error, "Nao foi possivel gerar a cobranca. Tente novamente em instantes.");
  }
};

function planLabel(plan) {
  return { basico: "Básico", premium: "Premium", pro: "Pro" }[plan] || plan;
}

// Manda o link de pagamento por email assim que a cobranca e criada — e o
// que garante que a pessoa consegue retomar o pagamento mesmo se fechar a
// aba do Asaas sem pagar, sem depender de lembrar de voltar ao site.
async function sendInvoiceEmail(email, invoiceUrl, businessName) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.error("create-subscription: GMAIL_USER/GMAIL_APP_PASSWORD nao configurados, email de cobranca nao enviado.");
    return;
  }

  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass }
  });

  await transporter.sendMail({
    from: `Nexor <${user}>`,
    to: email,
    subject: "Finalize seu cadastro no Nexor",
    text: `Olá! Recebemos seu pré-cadastro${businessName ? ` para ${businessName}` : ""} no Nexor.\n\nPara ativar sua conta, finalize o pagamento pelo link abaixo:\n${invoiceUrl}\n\nSe o link expirar ou você perder este email, é só voltar ao site e usar a opção "Já enviei meu pré-cadastro, retomar pagamento" informando este mesmo email.\n\nQualquer dúvida, fale com a gente: 5522998229144`
  });
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
