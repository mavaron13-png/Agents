// @vitest-environment node
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { SignJWT, jwtVerify } from "jose";

vi.mock("server-only", () => ({}));

const mockCookieStore = {
  set: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
};

vi.mock("next/headers", () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
}));

import { createSession, getSession } from "@/lib/auth";

const TEST_SECRET = new TextEncoder().encode("development-secret-key");

function decodeBase64Url(str: string): any {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
}

function encodeBase64Url(obj: object): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function getIssuedToken(): string {
  return mockCookieStore.set.mock.calls[0][1];
}

describe("createSession — security", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Cookie security attributes
  test("sets httpOnly flag", async () => {
    await createSession("user-1", "test@example.com");
    const [, , opts] = mockCookieStore.set.mock.calls[0];
    expect(opts.httpOnly).toBe(true);
  });

  test("sets sameSite=lax", async () => {
    await createSession("user-1", "test@example.com");
    const [, , opts] = mockCookieStore.set.mock.calls[0];
    expect(opts.sameSite).toBe("lax");
  });

  test("sets path=/", async () => {
    await createSession("user-1", "test@example.com");
    const [, , opts] = mockCookieStore.set.mock.calls[0];
    expect(opts.path).toBe("/");
  });

  test("does not set secure flag outside production", async () => {
    await createSession("user-1", "test@example.com");
    const [, , opts] = mockCookieStore.set.mock.calls[0];
    expect(opts.secure).toBe(false);
  });

  test("sets secure flag in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await createSession("user-1", "test@example.com");
    const [, , opts] = mockCookieStore.set.mock.calls[0];
    expect(opts.secure).toBe(true);
    vi.unstubAllEnvs();
  });

  // JWT structure
  test("JWT uses HS256 — not alg:none or RS256", async () => {
    await createSession("user-1", "test@example.com");
    const header = decodeBase64Url(getIssuedToken().split(".")[0]);
    expect(header.alg).toBe("HS256");
  });

  test("JWT expires in 7 days", async () => {
    const before = Math.floor(Date.now() / 1000);
    await createSession("user-1", "test@example.com");
    const payload = decodeBase64Url(getIssuedToken().split(".")[1]);
    const sevenDays = 7 * 24 * 60 * 60;
    expect(payload.exp - before).toBeGreaterThanOrEqual(sevenDays - 5);
    expect(payload.exp - before).toBeLessThanOrEqual(sevenDays + 5);
  });

  test("JWT payload contains correct userId and email", async () => {
    await createSession("user-42", "alice@example.com");
    const { payload } = await jwtVerify(getIssuedToken(), TEST_SECRET);
    expect(payload.userId).toBe("user-42");
    expect(payload.email).toBe("alice@example.com");
  });

  test("JWT has an iat (issued-at) claim", async () => {
    const before = Math.floor(Date.now() / 1000);
    await createSession("user-1", "test@example.com");
    const payload = decodeBase64Url(getIssuedToken().split(".")[1]);
    expect(payload.iat).toBeGreaterThanOrEqual(before);
  });

  // Tamper / forgery attacks
  test("tampered signature is rejected by getSession", async () => {
    await createSession("user-1", "test@example.com");
    const [header, body] = getIssuedToken().split(".");
    mockCookieStore.get.mockReturnValue({ value: `${header}.${body}.invalidsignature` });
    expect(await getSession()).toBeNull();
  });

  test("token signed with a different secret is rejected", async () => {
    const wrongSecret = new TextEncoder().encode("attacker-controlled-secret");
    const forgery = await new SignJWT({ userId: "attacker", email: "evil@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("7d")
      .setIssuedAt()
      .sign(wrongSecret);
    mockCookieStore.get.mockReturnValue({ value: forgery });
    expect(await getSession()).toBeNull();
  });

  // alg:none attack — crafts an unsigned JWT
  test("alg:none token is rejected", async () => {
    const header = encodeBase64Url({ alg: "none", typ: "JWT" });
    const payload = encodeBase64Url({
      userId: "attacker",
      email: "evil@example.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    });
    mockCookieStore.get.mockReturnValue({ value: `${header}.${payload}.` });
    expect(await getSession()).toBeNull();
  });

  // Expired token
  test("expired token is rejected", async () => {
    const expired = await new SignJWT({ userId: "user-1", email: "test@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 100)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
      .sign(TEST_SECRET);
    mockCookieStore.get.mockReturnValue({ value: expired });
    expect(await getSession()).toBeNull();
  });

  // Missing token
  test("missing cookie returns null", async () => {
    mockCookieStore.get.mockReturnValue(undefined);
    expect(await getSession()).toBeNull();
  });

  // Payload injection
  test("special characters in userId and email are preserved correctly", async () => {
    await createSession("user <script>", "test+tag@example.com");
    const { payload } = await jwtVerify(getIssuedToken(), TEST_SECRET);
    expect(payload.userId).toBe("user <script>");
    expect(payload.email).toBe("test+tag@example.com");
  });
});
