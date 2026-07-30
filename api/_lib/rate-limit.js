// Consulta a funcao nexor_check_rate_limit (ver migration
// 20260727120500_rate_limit.sql) via RPC do PostgREST. Falha aberta (nao
// bloqueia) se a propria checagem der erro de infra — rate limit e
// mitigacao, nao pode derrubar o endpoint inteiro sozinho por conta disso.
async function checkRateLimit(supabaseUrl, serviceKey, bucket, identifier, { max, windowSeconds }) {
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/nexor_check_rate_limit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`
      },
      body: JSON.stringify({
        p_bucket: bucket,
        p_identifier: identifier,
        p_max: max,
        p_window_seconds: windowSeconds
      })
    });
    if (!response.ok) return { allowed: true, retryAfterSeconds: 0 };
    const data = await response.json();
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return { allowed: true, retryAfterSeconds: 0 };
    return { allowed: Boolean(row.allowed), retryAfterSeconds: Number(row.retry_after_seconds || 0) };
  } catch (error) {
    console.error("rate-limit: falha ao checar, seguindo sem bloquear -", error.message);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

module.exports = { checkRateLimit, getClientIp };
