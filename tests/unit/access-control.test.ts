import type { Express, NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createAccessControl } from "../../server/src/accessControl.js";

type ResponseState = {
  body?: unknown;
  ended: boolean;
  headers: Record<string, string>;
  status: number;
};

function createRequest(input: {
  body?: unknown;
  headers?: Record<string, string>;
  ip?: string;
  method?: string;
  secure?: boolean;
} = {}): Request {
  const headers = new Map(
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLocaleLowerCase(), value])
  );
  return {
    body: input.body ?? {},
    get: (name: string) => headers.get(name.toLocaleLowerCase()),
    ip: input.ip ?? "127.0.0.1",
    method: input.method ?? "GET",
    secure: input.secure ?? false,
    socket: { remoteAddress: input.ip ?? "127.0.0.1" }
  } as unknown as Request;
}

function createResponse(): { response: Response; state: ResponseState } {
  const state: ResponseState = { ended: false, headers: {}, status: 200 };
  const response = {
    end: () => { state.ended = true; },
    json: (body: unknown) => { state.body = body; },
    setHeader: (name: string, value: string | number | readonly string[]) => {
      state.headers[name.toLocaleLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
    },
    status: (status: number) => {
      state.status = status;
      return response;
    }
  } as unknown as Response;
  return { response, state };
}

function callMiddleware(
  access: ReturnType<typeof createAccessControl>,
  request: Request
): { next: ReturnType<typeof vi.fn>; state: ResponseState } {
  const { response, state } = createResponse();
  const next = vi.fn() as unknown as NextFunction;
  access.middleware(request, response, next);
  return { next: next as ReturnType<typeof vi.fn>, state };
}

describe("Alexandria access control", () => {
  it("keeps local-only mode open while advertising the network boundary", () => {
    const access = createAccessControl({ lanMode: false });
    const result = callMiddleware(access, createRequest({ method: "POST" }));

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.state.status).toBe(200);
    expect(result.state.headers["x-amw-network-mode"]).toBe("local-only");
    expect(access.mode).toBe("local-only");
  });

  it("allows direct LAN access without a pairing code by default", () => {
    const access = createAccessControl({ lanMode: true });
    const result = callMiddleware(access, createRequest());

    expect(result.next).toHaveBeenCalledOnce();
    expect(result.state.status).toBe(200);
    expect(result.state.headers["x-amw-network-mode"]).toBe("lan-open");
    expect(access.mode).toBe("lan-open");
  });

  it("requires authentication in LAN mode and accepts an explicit bearer token", () => {
    const access = createAccessControl({
      lanMode: true,
      requireAuthentication: true,
      accessToken: "test-access-token"
    });

    const anonymous = callMiddleware(access, createRequest());
    expect(anonymous.next).not.toHaveBeenCalled();
    expect(anonymous.state.status).toBe(401);
    expect(anonymous.state.body).toMatchObject({ code: "AMW_AUTH_REQUIRED" });

    const authenticated = callMiddleware(access, createRequest({
      headers: { authorization: "Bearer test-access-token" }
    }));
    expect(authenticated.next).toHaveBeenCalledOnce();
    expect(authenticated.state.headers["x-amw-network-mode"]).toBe("lan-protected");
  });

  it("rejects cross-origin writes but permits same-origin writes", () => {
    const access = createAccessControl({
      lanMode: true,
      requireAuthentication: true,
      accessToken: "test-access-token"
    });
    const commonHeaders = { authorization: "Bearer test-access-token", host: "192.168.1.20:3000" };

    const rejected = callMiddleware(access, createRequest({
      method: "POST",
      headers: { ...commonHeaders, origin: "http://attacker.example" }
    }));
    expect(rejected.next).not.toHaveBeenCalled();
    expect(rejected.state.status).toBe(403);
    expect(rejected.state.body).toMatchObject({ code: "AMW_ORIGIN_REJECTED" });

    const accepted = callMiddleware(access, createRequest({
      method: "POST",
      headers: { ...commonHeaders, origin: "http://192.168.1.20:3000" }
    }));
    expect(accepted.next).toHaveBeenCalledOnce();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("guards %s requests with the same origin policy", (method) => {
    const access = createAccessControl({ lanMode: true });
    const rejected = callMiddleware(access, createRequest({
      method,
      headers: { host: "nas.local:5188", origin: "https://attacker.example" }
    }));
    const accepted = callMiddleware(access, createRequest({
      method,
      headers: { host: "nas.local:5188", origin: "http://nas.local:5188" }
    }));

    expect(rejected.next).not.toHaveBeenCalled();
    expect(rejected.state.body).toMatchObject({ code: "AMW_ORIGIN_REJECTED" });
    expect(accepted.next).toHaveBeenCalledOnce();
  });

  it("accepts a configured origin without trusting forwarded headers", () => {
    const access = createAccessControl({
      lanMode: true,
      allowedOrigins: ["https://alexandria.example.com"]
    });
    const accepted = callMiddleware(access, createRequest({
      method: "POST",
      headers: {
        host: "127.0.0.1:3001",
        origin: "https://alexandria.example.com"
      }
    }));

    expect(accepted.next).toHaveBeenCalledOnce();
  });

  it("accepts a trusted public proxy origin and rejects spoofed forwarded headers", () => {
    const request = createRequest({
      method: "POST",
      headers: {
        host: "127.0.0.1:3001",
        origin: "https://nas.example.com",
        "x-forwarded-host": "nas.example.com",
        "x-forwarded-proto": "https"
      }
    });

    const trusted = callMiddleware(createAccessControl({ lanMode: true, trustProxy: true }), request);
    expect(trusted.next).toHaveBeenCalledOnce();

    const untrusted = callMiddleware(createAccessControl({ lanMode: true, trustProxy: false }), request);
    expect(untrusted.next).not.toHaveBeenCalled();
    expect(untrusted.state.body).toMatchObject({ code: "AMW_ORIGIN_REJECTED" });
  });

  it("accepts a trusted gateway that records the original public origin", () => {
    const access = createAccessControl({ lanMode: true, trustProxy: true });
    const accepted = callMiddleware(access, createRequest({
      method: "POST",
      headers: {
        host: "127.0.0.1:3001",
        origin: "http://192.168.50.21:5179",
        "x-forwarded-host": "nas.local:5188",
        "x-forwarded-origin": "http://nas.local:5188",
        "x-forwarded-proto": "http"
      }
    }));

    expect(accepted.next).toHaveBeenCalledOnce();
  });

  it("pairs with the configured code and issues an HttpOnly strict cookie", () => {
    const access = createAccessControl({
      lanMode: true,
      requireAuthentication: true,
      accessToken: "test-access-token",
      pairingCode: "246810",
      sessionTtlSeconds: 600
    });
    const routes = new Map<string, (req: Request, res: Response) => void>();
    const app = {
      get: (path: string, handler: (req: Request, res: Response) => void) => { routes.set(`GET ${path}`, handler); },
      post: (path: string, handler: (req: Request, res: Response) => void) => { routes.set(`POST ${path}`, handler); },
      use: vi.fn()
    } as unknown as Express;
    access.register(app);

    const pair = routes.get("POST /api/access/pair");
    expect(pair).toBeDefined();
    const { response, state } = createResponse();
    pair?.(createRequest({ body: { code: "246810" } }), response);

    expect(state.status).toBe(200);
    expect(state.body).toEqual({ authenticated: true, mode: "lan-protected" });
    expect(state.headers["set-cookie"]).toContain("amw_session=");
    expect(state.headers["set-cookie"]).toContain("HttpOnly");
    expect(state.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(state.headers["set-cookie"]).toContain("Max-Age=600");

    const cookie = state.headers["set-cookie"].split(";")[0];
    expect(access.isAuthenticated(createRequest({ headers: { cookie } }))).toBe(true);
  });
});
