function safeText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[character])
    .slice(0, maxLength);
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    const parsed = event.data ? event.data.json() : {};
    payload = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }

  const title = safeText(payload.title, 100) || "StreamPay";
  const body = safeText(payload.body, 300);
  const streamId = typeof payload.streamId === "string"
    ? safeText(payload.streamId, 128)
    : null;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/assets/splash-icon.png",
      data: { streamId },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const streamId = event.notification.data?.streamId;
  const target = streamId
    ? `/streams/${encodeURIComponent(streamId)}`
    : "/streams";
  const targetUrl = new URL(target, self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      const client = clients.find((candidate) =>
        new URL(candidate.url).origin === self.location.origin,
      );
      if (client) {
        await client.navigate(targetUrl);
        await client.focus();
        return;
      }
      await self.clients.openWindow(targetUrl);
    }),
  );
});
