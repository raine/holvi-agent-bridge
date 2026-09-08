// This function runs in the page world and must not reference module bindings.
export async function pageHeartbeat(
  origin: string,
  group: string,
): Promise<void> {
  const inScope = (url: URL): boolean => {
    const match = url.pathname.match(/^\/group\/([^/]+)(?:\/|$)/);
    try {
      return (
        url.origin === origin &&
        !!match?.[1] &&
        decodeURIComponent(match[1]) === group
      );
    } catch {
      return false;
    }
  };
  if (!inScope(new URL(window.location.href))) return;

  const target = document.documentElement || document;
  const options = { bubbles: true, clientX: 1, clientY: 1, view: window };
  if (typeof window.PointerEvent === "function") {
    target.dispatchEvent(new PointerEvent("pointermove", options));
  }
  target.dispatchEvent(new MouseEvent("mousemove", options));

  try {
    await fetch(window.location.href, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      headers: { Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // Navigation, expired sessions, and network failures need no retry here.
  }
}

export const heartbeatAlarm = "holvi-session-heartbeat";

export class SessionHeartbeat {
  private running = false;
  private enabledUntil = 0;

  constructor(
    private readonly target: () => {
      tabId: number;
      origin: string;
      group: string;
    } | null,
    private readonly execute: (
      tabId: number,
      origin: string,
      group: string,
    ) => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {}

  recordActivity(): void {
    this.enabledUntil = this.now() + 30 * 60 * 1000;
  }

  async run(): Promise<void> {
    const target = this.target();
    if (!target || this.running || this.now() >= this.enabledUntil) return;
    this.running = true;
    try {
      await this.execute(target.tabId, target.origin, target.group);
    } catch {
      // Tabs can close or navigate between selection and script injection.
    } finally {
      this.running = false;
    }
  }
}
