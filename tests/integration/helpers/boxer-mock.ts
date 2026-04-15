/**
 * In-process HTTP server that mimics the Boxer REST API.
 * Keeps the test stack real — BoxerClient talks to this server over loopback.
 *
 * Usage:
 *   const boxer = new BoxerMock();
 *   await boxer.start();
 *   // pass boxer.baseUrl to BoxerClient / agent runner
 *   boxer.stop();
 */

/** Matches src/sandbox/types.ts RunRequest */
export interface RunRequest {
  image: string;
  cmd: string[];
  workspaceId?: string;
  network?: string;
  limits?: { timeoutSecs?: number };
}

export class BoxerMock {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private _port = 0;

  /** Called for every /run request. Override per-test to customise output. */
  onRun: (req: RunRequest) => { stdout: string; stderr: string; exitCode: number } = () => ({
    stdout: "(mock output)",
    stderr: "",
    exitCode: 0,
  });

  private workspaces = new Map<string, { name: string; image: string }>();
  private _runRequests: RunRequest[] = [];

  get baseUrl(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  get runRequests(): readonly RunRequest[] {
    return this._runRequests;
  }

  async start(): Promise<void> {
    const self = this;

    // Pick an available port by binding to :0
    this.server = Bun.serve({
      port: 0, // OS assigns a free port
      fetch(req) {
        return self._handle(req);
      },
    });

    this._port = this.server.port ?? 0;
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  private async _handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // POST /run
    if (req.method === "POST" && path === "/run") {
      const body = (await req.json()) as RunRequest;
      this._runRequests.push(body);
      const result = this.onRun(body);
      return Response.json({ execId: `exec-mock-${Date.now()}`, wallTimeMs: 1, ...result });
    }

    // POST /workspaces  — create workspace
    if (req.method === "POST" && path === "/workspaces") {
      const body = (await req.json()) as { name: string; image: string };
      const workspaceId = `ws-mock-${Date.now()}`;
      this.workspaces.set(workspaceId, { name: body.name, image: body.image });
      return Response.json({ workspaceId, name: body.name, image: body.image, createdAt: new Date().toISOString() });
    }

    // GET /workspaces
    if (req.method === "GET" && path === "/workspaces") {
      const list = Array.from(this.workspaces.entries()).map(([id, ws]) => ({
        workspaceId: id,
        ...ws,
      }));
      return Response.json(list);
    }

    // DELETE /workspaces/:id
    const deleteMatch = path.match(/^\/workspaces\/([^/]+)$/);
    if (req.method === "DELETE" && deleteMatch) {
      const id = deleteMatch[1]!;
      this.workspaces.delete(id);
      return Response.json({ deleted: true });
    }

    return new Response("Not found", { status: 404 });
  }
}
