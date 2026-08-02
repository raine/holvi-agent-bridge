(() => {
  "use strict";

  const config = HOLVI_AGENT_BRIDGE_STATIC_CONFIG;
  if (
    location.origin !== config.accountOrigin ||
    !location.pathname.startsWith(config.groupPathPrefix)
  ) {
    return;
  }

  const readCookie = (name: string): string => {
    const prefix = `${encodeURIComponent(name)}=`;
    for (const part of document.cookie.split(";")) {
      const candidate = part.trim();
      if (candidate.startsWith(prefix)) {
        return decodeURIComponent(candidate.slice(prefix.length));
      }
    }
    return "";
  };

  const port = chrome.runtime.connect({ name: "holvi-tab" });

  port.onMessage.addListener((message: unknown) => {
    const request = message as { type?: string; requestId?: string };
    if (!request || request.type !== "auth_request") {
      return;
    }

    port.postMessage({
      type: "auth_response",
      requestId: request.requestId,
      href: location.href,
      origin: location.origin,
      pathname: location.pathname,
      token: readCookie("holvi_jwt_auth"),
      csrfToken: readCookie("csrftoken"),
    });
  });

  const sendHello = (): void => {
    port.postMessage({
      type: "tab_hello",
      href: location.href,
      origin: location.origin,
      pathname: location.pathname,
    });
  };

  let lastHref = location.href;
  sendHello();
  window.setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      sendHello();
    }
  }, 1000);
})();
