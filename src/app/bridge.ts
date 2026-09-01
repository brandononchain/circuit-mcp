/**
 * Minimal MCP Apps (SEP-1865) view-side client.
 *
 * The official @modelcontextprotocol/ext-apps App class carries the whole MCP
 * SDK with it — 300 kB inlined into every ui:// read. This speaks the same
 * protocol in about 4 kB. It is verified against the official AppBridge host
 * implementation in scripts/harness.ts.
 *
 * Protocol version 2026-01-26.
 */
const PROTOCOL_VERSION = "2026-01-26";

type Json = Record<string, any>;
type Handlers = {
  ontoolinput?: (p: Json) => void;
  ontoolinputpartial?: (p: Json) => void;
  ontoolresult?: (p: Json) => void;
  ontoolcancelled?: (p: Json) => void;
  onhostcontextchanged?: (p: Json) => void;
  onteardown?: () => void;
};

export type HostContext = {
  theme?: "light" | "dark";
  displayMode?: string;
  containerDimensions?: { width?: number; maxHeight?: number };
  styles?: Json;
  locale?: string;
};

export class AppClient {
  private id = 0;
  private pending = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>();
  private target: Window = window.parent;
  private ctx: HostContext = {};
  private ro?: ResizeObserver;
  h: Handlers = {};

  constructor(private info: { name: string; version: string; title?: string },
              private opts: { autoResize?: boolean } = {}) {}

  hostContext(): HostContext { return this.ctx; }

  async connect(): Promise<void> {
    window.addEventListener("message", this.onMessage);
    const result = await this.request("ui/initialize", {
      protocolVersion: PROTOCOL_VERSION,
      appInfo: this.info,
      appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    });
    this.ctx = (result?.hostContext ?? {}) as HostContext;
    this.notify("ui/notifications/initialized", {});
    if (this.opts.autoResize) this.watchSize();
  }

  /** Call a tool on the MCP server this app came from. */
  callServerTool(name: string, args: Json): Promise<Json> {
    return this.request("tools/call", { name, arguments: args });
  }
  requestDisplayMode(mode: "inline" | "fullscreen" | "pip"): Promise<Json> {
    return this.request("ui/request-display-mode", { mode });
  }
  sendMessage(text: string) { this.notify("ui/message", { content: [{ type: "text", text }] }); }
  openLink(url: string) { this.notify("ui/open-link", { url }); }

  private watchSize() {
    let last = -1;
    const report = () => {
      const h = Math.ceil(document.documentElement.scrollHeight);
      if (h !== last && h > 0) {
        last = h;
        this.notify("ui/notifications/size-changed", { height: h });
      }
    };
    this.ro = new ResizeObserver(report);
    this.ro.observe(document.documentElement);
    report();
  }

  private request(method: string, params: Json): Promise<any> {
    const id = ++this.id;
    return new Promise((ok, err) => {
      this.pending.set(id, { ok, err });
      this.post({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pending.delete(id)) err(new Error(`${method} timed out`));
      }, 60_000);
    });
  }
  private notify(method: string, params: Json) { this.post({ jsonrpc: "2.0", method, params }); }
  private post(msg: Json) { this.target.postMessage(msg, "*"); }

  private onMessage = (ev: MessageEvent) => {
    const m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;

    // response to something we asked for
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.err(new Error(m.error.message ?? "request failed")) : p.ok(m.result);
      return;
    }

    // request from the host — must always answer
    if (m.id !== undefined && m.method) {
      if (m.method === "ping") return this.post({ jsonrpc: "2.0", id: m.id, result: {} });
      if (m.method === "ui/resource-teardown") {
        this.h.onteardown?.();
        return this.post({ jsonrpc: "2.0", id: m.id, result: {} });
      }
      if (m.method === "tools/list") return this.post({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });
      return this.post({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no handler for ${m.method}` } });
    }

    // notification from the host
    switch (m.method) {
      case "ui/notifications/tool-input": return void this.h.ontoolinput?.(m.params ?? {});
      case "ui/notifications/tool-input-partial": return void this.h.ontoolinputpartial?.(m.params ?? {});
      case "ui/notifications/tool-result": return void this.h.ontoolresult?.(m.params ?? {});
      case "ui/notifications/tool-cancelled": return void this.h.ontoolcancelled?.(m.params ?? {});
      case "ui/notifications/host-context-changed":
        this.ctx = { ...this.ctx, ...(m.params?.hostContext ?? m.params ?? {}) };
        return void this.h.onhostcontextchanged?.(this.ctx);
    }
  };
}
