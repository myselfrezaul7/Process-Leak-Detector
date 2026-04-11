const crypto = require("crypto");

const DEFAULT_USERS = [
  { email: "ceo@pld.local", role: "ceo", name: "CEO User", password: "ChangeMe123!" },
  { email: "ops@pld.local", role: "ops", name: "Ops Lead", password: "ChangeMe123!" },
  { email: "store@pld.local", role: "store", name: "Store Manager", password: "ChangeMe123!" }
];

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function hashPassword(password, salt) {
  return crypto.createHash("sha256").update(`${salt}:${password}`).digest("hex");
}

function buildUserRecord(user) {
  const salt = crypto.randomBytes(8).toString("hex");
  return {
    id: crypto.randomUUID(),
    email: user.email,
    role: user.role,
    name: user.name,
    salt,
    passwordHash: hashPassword(user.password, salt),
    createdAt: new Date().toISOString()
  };
}

async function ensureDefaultUsers(storage, tenantId) {
  const users = await storage.readUsers(tenantId);
  if (users.length > 0) return users;
  const seeded = DEFAULT_USERS.map(buildUserRecord);
  await storage.writeUsers(tenantId, seeded);
  return seeded;
}

function issueToken(user, secret, ttlSeconds = 60 * 60 * 12) {
  const payloadObj = {
    sub: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds
  };
  const payload = base64Url(JSON.stringify(payloadObj));
  const signature = sign(payload, secret);
  return `${payload}.${signature}`;
}

function verifyToken(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  if (sign(payload, secret) !== signature) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (parsed.exp && Date.now() / 1000 > parsed.exp) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

async function authenticate(storage, tenantId, email, password) {
  const users = await ensureDefaultUsers(storage, tenantId);
  const user = users.find((u) => String(u.email).toLowerCase() === String(email || "").toLowerCase());
  if (!user) return null;
  const hash = hashPassword(password || "", user.salt);
  if (hash !== user.passwordHash) return null;
  return user;
}

function parseAuthHeader(headers) {
  const auth = headers && (headers.authorization || headers.Authorization);
  if (!auth) return null;
  const [scheme, token] = String(auth).split(" ");
  if (scheme !== "Bearer" || !token) return null;
  return token;
}

function hasRole(user, requiredRoles) {
  if (!requiredRoles || requiredRoles.length === 0) return true;
  if (!user) return false;
  return requiredRoles.includes(user.role);
}

module.exports = {
  ensureDefaultUsers,
  issueToken,
  verifyToken,
  authenticate,
  parseAuthHeader,
  hasRole
};
