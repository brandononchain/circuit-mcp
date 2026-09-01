/* Local host harness: renders the Circuit app the way Claude would, without Claude. */
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

declare const BOARD_HTML: string;
declare const FIXTURES: any;

const iframe = document.getElementById("view") as HTMLIFrameElement;
iframe.srcdoc = BOARD_HTML;

const fakeClient: any = {
  getServerCapabilities: () => ({ tools: {}, resources: {} }),
  callTool: async (params: any) => {
    log(`app → server  ${params.name}(${JSON.stringify(params.arguments).slice(0, 90)})`);
    return FIXTURES.afterMove;
  },
  listTools: async () => ({ tools: [] }),
  readResource: async () => ({ contents: [] }),
};

const bridge = new AppBridge(
  fakeClient,
  { name: "harness", version: "1.0.0" },
  { openLinks: {}, serverTools: {}, logging: {} },
  {
    hostContext: {
      theme: (new URLSearchParams(location.search).get("theme") as any) ?? "dark",
      displayMode: "inline",
      containerDimensions: { width: 1200, maxHeight: 900 },
    },
  } as any,
);

function log(s: string) {
  const el = document.getElementById("hostlog")!;
  el.textContent = (el.textContent + "\n" + s).trim().split("\n").slice(-6).join("\n");
}

bridge.oninitialized = async () => {
  log("view initialized");
  const scene = new URLSearchParams(location.search).get("scene") ?? "build";
  if (scene === "build") {
    const steps = FIXTURES.design.structuredContent.workflow.steps;
    for (let i = 1; i <= steps.length; i++) {
      bridge.sendToolInputPartial({ arguments: { name: "Inbox triage & reply", steps: steps.slice(0, i) } });
      await new Promise((r) => setTimeout(r, 260));
    }
    bridge.sendToolInput({ arguments: { name: "Inbox triage & reply", steps } });
    bridge.sendToolResult(FIXTURES.design);
  } else if (scene === "run") {
    bridge.sendToolInput({ arguments: {} });
    bridge.sendToolResult(FIXTURES.run);
  } else {
    bridge.sendToolInput({ arguments: {} });
    bridge.sendToolResult(FIXTURES.held);
  }
};

// connect before the view finishes loading, so its ui/initialize is never missed
(async () => {
  const transport = new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!);
  await bridge.connect(transport);
  log("bridge listening");
})();
