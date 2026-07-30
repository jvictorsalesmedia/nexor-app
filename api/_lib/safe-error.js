// Erros "esperados" (validacao nossa, ou mensagem de uma API parceira
// pensada pra aparecer pro usuario) sao seguros de mostrar. Qualquer outra
// excecao (ex: erro nativo do fetch/Headers que pode embutir o valor de uma
// env var/header invalido na mensagem, ou erro cru do PostgREST/Auth do
// Supabase) fica so no log do servidor.
function userError(message) {
  const error = new Error(message);
  error.expose = true;
  return error;
}

function sendSafeError(res, error, fallbackMessage, status = 400) {
  console.error(fallbackMessage.replace(/[.:]+$/, ""), "-", error?.message);
  res.status(status).json({ error: error?.expose ? error.message : fallbackMessage });
}

module.exports = { userError, sendSafeError };
