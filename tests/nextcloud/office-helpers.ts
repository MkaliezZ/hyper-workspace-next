import {
  expect,
  type BrowserContext,
  type Frame,
  type Page,
} from "@playwright/test";

type LoadingStatus =
  | "Initialized"
  | "Frame_Ready"
  | "Document_Loaded"
  | "Failed";
type OfficeEvent =
  | { kind: "loading"; status: LoadingStatus; iframeIndex: number }
  | { kind: "load-response"; success: boolean; iframeIndex: number };

/** Passive observer: never supplies the host handshake or changes editor state. */
export async function observeOffice(
  context: BrowserContext,
  editorOrigin: string,
  sourceOrigin: string,
) {
  const events = new Map<Page, { frame: Frame; event: OfficeEvent }[]>();
  const current = new Map<
    Page,
    Map<Frame, { receiver: Frame; loaded: boolean; sequence: number }>
  >();
  const navigations = new Map<Frame, number>();
  const network = new Map<Page, object[]>();
  function record(page: Page, event: object) {
    const entries = network.get(page) ?? [];
    if (entries.length < 80) entries.push(event);
    network.set(page, entries);
  }
  function originKind(value: string) {
    try {
      const url = new URL(value);
      // WebSocket traffic belongs to the same editor origin as HTTP discovery.
      if (url.protocol === "ws:") url.protocol = "http:";
      if (url.protocol === "wss:") url.protocol = "https:";
      const origin = url.origin;
      return origin === sourceOrigin
        ? "source"
        : origin === editorOrigin
          ? "editor"
          : "other";
    } catch {
      return "unavailable";
    }
  }
  function routeKind(value: string) {
    try {
      const url = new URL(value);
      const origin = originKind(value);
      if (origin === "editor") {
        if (url.pathname.startsWith("/hosting/")) return "editor-discovery";
        if (url.pathname.startsWith("/browser/")) return "editor-browser";
        if (url.pathname.startsWith("/cool/")) return "editor-session";
      }
      if (origin === "source") {
        if (url.pathname.endsWith("/richdocuments/token"))
          return "source-token";
        if (url.pathname.includes("/richdocuments/")) return "source-office";
        if (/\.(?:js|css|woff2?)$/.test(url.pathname)) return "source-assets";
        if (url.pathname.includes("/core/preview")) return "source-preview";
        if (url.pathname.includes("/avatar/")) return "source-avatar";
        if (url.pathname.includes("/ocs/")) return "source-ocs";
      }
      return origin + "-other";
    } catch {
      return "unavailable";
    }
  }
  // URL queries, encoded WOPI paths, response bodies and socket payloads can
  // contain credentials. Diagnostics retain only fixed categories and numbers.
  context.on("page", (page) => {
    page.on("request", (request) => {
      const route = routeKind(request.url());
      if (request.resourceType() === "document" || route === "source-token")
        record(page, { kind: "document-request", route });
    });
    page.on("framenavigated", (frame) => {
      navigations.set(frame, (navigations.get(frame) ?? 0) + 1);
      for (const [sender, state] of current.get(page) ?? []) {
        if (sender === frame || state.receiver === frame)
          current.get(page)!.delete(sender);
      }
    });
    page.on("response", (response) => {
      if (
        response.status() >= 400 ||
        response.request().resourceType() === "document" ||
        routeKind(response.url()) === "source-token"
      )
        record(page, {
          kind: response.status() >= 400 ? "http-error" : "document-response",
          route: routeKind(response.url()),
          status: response.status(),
        });
    });
    page.on("requestfailed", (request) =>
      record(page, { kind: "request-failed", route: routeKind(request.url()) }),
    );
    page.on("pageerror", () => record(page, { kind: "page-error" }));
    page.on("console", (message) => {
      if (
        /Content Security Policy|content security policy/.test(message.text())
      )
        record(page, {
          kind: "browser-policy",
          reason: "content-security-policy",
        });
      if (/Mixed Content|mixed content/.test(message.text()))
        record(page, { kind: "browser-policy", reason: "mixed-content" });
      if (
        /ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_TIMED_OUT/.test(
          message.text(),
        )
      )
        record(page, { kind: "browser-policy", reason: "connection-failed" });
      // CODE's close diagnostic has a free-form reason. Retain only its numeric
      // code and clean-close flag, never the reason or the complete console text.
      const close = message
        .text()
        .match(/^_onSocketClose: code=(\d{1,4}) wasClean=(true|false) reason=/);
      if (close)
        record(page, {
          kind: "socket-close-status",
          code: Number(close[1]),
          clean: close[2] === "true",
        });
    });
    page.on("websocket", (socket) => {
      const route = routeKind(socket.url());
      record(page, { kind: "socket-created", route });
      socket.on("socketerror", () =>
        record(page, { kind: "socket-error", route }),
      );
      socket.on("close", () => record(page, { kind: "socket-closed", route }));
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload !== "string") return;
        if (payload.startsWith("close: ")) {
          const reason = payload.slice(7);
          const known = [
            "ownertermination",
            "idle",
            "oom",
            "shuttingdown",
            "docdisconnected",
            "recycling",
            "documentconflict",
            "versionrestore: prerestore_ack",
            "reloadafterrename",
          ];
          record(page, {
            kind: "socket-protocol-close",
            route,
            reason: known.includes(reason) ? reason : "other",
          });
        } else if (payload.startsWith("error:")) {
          const command = payload.match(/\bcmd=([a-z]+)(?:\s|$)/)?.[1];
          const reason = payload.match(/\bkind=([a-z:-]+)(?:\s|$)/)?.[1];
          record(page, {
            kind: "socket-protocol-error",
            route,
            command: ["internal", "storage", "load", "socket"].includes(
              command ?? "",
            )
              ? command
              : "other",
            reason: [
              "unauthorized",
              "loadfailed",
              "faileddocloading",
              "docloadtimeout",
              "docunloading",
              "docalreadyloaded",
              "syntax",
              "noexport",
              "uriinvalid",
              "docexpired",
              "recycling",
              "passwordrequired:to-view",
              "passwordrequired:to-modify",
              "invalid",
              "diskfull",
              "accessrevoked",
              "accessdowngraded",
              "accessunverified",
              "wrongpassword",
              "notallowed",
              "hardlimitreached",
              "serviceunavailable",
              "limitreached",
              "restricted",
              "locked",
            ].includes(reason ?? "")
              ? reason
              : "other",
          });
        }
      });
    });
  });
  await context.exposeBinding(
    "__hyperOfficeObserved",
    async (
      { page, frame },
      value: OfficeEvent & { marker: string; sequence: number },
    ) => {
      if (originKind(frame.url()) !== "source") return;
      if (!Number.isSafeInteger(value?.iframeIndex) || value.iframeIndex < 0)
        return;
      if (
        typeof value.marker !== "string" ||
        !/^office-[a-z0-9]+-\d+$/.test(value.marker) ||
        value.marker.length > 80 ||
        !Number.isSafeInteger(value.sequence)
      )
        return;
      let event: OfficeEvent;
      if (
        value.kind === "loading" &&
        ["Initialized", "Frame_Ready", "Document_Loaded", "Failed"].includes(
          value.status,
        )
      )
        event = {
          kind: "loading",
          status: value.status,
          iframeIndex: value.iframeIndex,
        };
      else if (
        value.kind === "load-response" &&
        typeof value.success === "boolean"
      )
        event = {
          kind: "load-response",
          success: value.success,
          iframeIndex: value.iframeIndex,
        };
      else return;
      // An unrelated child (for example the editor's welcome page) may navigate
      // while this binding resolves the sender. Only receiver/sender navigation
      // can invalidate this message's document generation.
      const generations = new Map(
        page
          .frames()
          .map((candidate) => [candidate, navigations.get(candidate) ?? 0]),
      );
      const element = await frame
        .evaluateHandle(
          (marker) =>
            document.querySelector(
              `iframe[data-hyper-office-probe="${marker}"]`,
            ),
          value.marker,
        )
        .catch(() => null);
      const sender = await element
        ?.asElement()
        ?.contentFrame()
        .catch(() => null);
      await element?.dispose();
      if (
        !sender ||
        sender.isDetached() ||
        originKind(sender.url()) !== "editor" ||
        !generations.has(sender) ||
        (generations.get(frame) ?? 0) !== (navigations.get(frame) ?? 0) ||
        (generations.get(sender) ?? 0) !== (navigations.get(sender) ?? 0)
      )
        return;
      const states = current.get(page) ?? new Map();
      const previous = states.get(sender);
      if (previous && previous.sequence >= value.sequence) return;
      states.set(sender, {
        receiver: frame,
        sequence: value.sequence,
        loaded:
          event.kind === "loading"
            ? event.status === "Document_Loaded"
            : event.success && !!previous?.loaded,
      });
      current.set(page, states);
      const entries = events.get(page) ?? [];
      if (entries.length < 80) entries.push({ frame, event });
      events.set(page, entries);
    },
  );
  await context.addInitScript(
    ({ editorOrigin, sourceOrigin }) => {
      if (window.location.origin !== sourceOrigin) return;
      const markers = new WeakMap<HTMLIFrameElement, string>();
      const prefix = "office-" + Math.random().toString(36).slice(2) + "-";
      let sequence = 0;
      let nextFrame = 0;
      window.addEventListener("message", (event) => {
        if (event.origin !== editorOrigin || typeof event.data !== "string")
          return;
        const frames = Array.from(
          document.querySelectorAll<HTMLIFrameElement>(
            'iframe[data-cy="coolframe"]',
          ),
        );
        const iframeIndex = frames.findIndex(
          (frame) => frame.contentWindow === event.source,
        );
        if (iframeIndex < 0) return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        const report = (entry: object) => {
          const sender = frames[iframeIndex]!;
          let marker = markers.get(sender);
          if (!marker) {
            marker = prefix + nextFrame++;
            markers.set(sender, marker);
            sender.dataset.hyperOfficeProbe = marker;
          }
          void (
            window as unknown as {
              __hyperOfficeObserved: (value: object) => Promise<void>;
            }
          ).__hyperOfficeObserved({
            ...entry,
            iframeIndex,
            marker,
            sequence: ++sequence,
          });
        };
        if (
          message?.MessageId === "App_LoadingStatus" &&
          ["Initialized", "Frame_Ready", "Document_Loaded", "Failed"].includes(
            message.Values?.Status,
          )
        )
          report({ kind: "loading", status: message.Values.Status });
        if (
          message?.MessageId === "Action_Load_Resp" &&
          typeof message.Values?.success === "boolean"
        )
          report({ kind: "load-response", success: message.Values.success });
      });
    },
    { editorOrigin, sourceOrigin },
  );

  function loaded(page: Page) {
    return [...(current.get(page) ?? [])].find(
      ([sender, state]) =>
        !sender.isDetached() && !state.receiver.isDetached() && state.loaded,
    )?.[0];
  }
  return {
    hasLoaded: (page: Page) => !!loaded(page),
    async waitForLoaded(page: Page, timeout = 60000) {
      await expect
        .poll(
          async () => {
            const sender = loaded(page);
            if (!sender) return false;
            const element = await sender.frameElement().catch(() => null);
            const visible = await element?.isVisible().catch(() => false);
            await element?.dispose();
            return visible === true && loaded(page) === sender;
          },
          {
            message:
              "The authorized Collabora frame must report Document_Loaded",
            timeout,
          },
        )
        .toBe(true);
    },
    async diagnostics(page: Page) {
      return {
        frames: await Promise.all(
          page.frames().map(async (frame) => ({
            origin: originKind(frame.url()),
            top: frame === page.mainFrame(),
            editorFrames: await frame
              .locator('iframe[data-cy="coolframe"]')
              .count()
              .catch(() => 0),
          })),
        ),
        loading: (events.get(page) ?? []).map(({ frame, event }) => ({
          receiver: frame === page.mainFrame() ? "top" : "nested",
          ...event,
        })),
        network: network.get(page) ?? [],
      };
    },
  };
}
