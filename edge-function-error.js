// Supabase wraps non-2xx responses in a generic FunctionsHttpError.
// Keep the server's validation message so the user can resolve the failure.
export async function edgeFunctionError(error) {
  const response = error?.context;
  if (response && typeof response.json === 'function') {
    try {
      const payload = await (typeof response.clone === 'function' ? response.clone() : response).json();
      const message = typeof payload?.error === 'string' ? payload.error : payload?.message;
      if (typeof message === 'string' && message.trim()) {
        const detail = new Error(message);
        detail.cause = error;
        detail.status = response.status;
        return detail;
      }
    } catch { /* Network failures and non-JSON responses keep their original message. */ }
  }
  return error instanceof Error ? error : new Error(error?.message || String(error || 'פעולת השרת נכשלה'));
}
