import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";

function rolesFromPayload(payload) {
  if (Array.isArray(payload.roles) && payload.roles.length > 0) return payload.roles;
  if (payload.role) return [payload.role];
  return ["rider"];
}

/** @param {string} userId @param {import("mongoose").Document | { role?: string, roles?: string[] } | string} userOrRole */
export function signToken(userId, userOrRole) {
  let roles;
  if (typeof userOrRole === "string") {
    roles = [userOrRole];
  } else if (userOrRole && typeof userOrRole === "object") {
    if (Array.isArray(userOrRole.roles) && userOrRole.roles.length > 0) {
      roles = userOrRole.roles;
    } else if (userOrRole.role) {
      roles = [userOrRole.role];
    } else {
      roles = ["rider"];
    }
  } else {
    roles = ["rider"];
  }
  const primary = roles[0] || "rider";
  return jwt.sign({ sub: userId, role: primary, roles }, JWT_SECRET, {
    expiresIn: "7d",
  });
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Missing token" });
    return;
  }
  try {
    const payload = verifyToken(token);
    req.userId = payload.sub != null ? String(payload.sub) : "";
    const roles = rolesFromPayload(payload);
    req.userRoles = roles;
    req.userRole = roles[0] || payload.role || "rider";
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

export function requireRole(role) {
  return (req, res, next) => {
    const roles = req.userRoles || [];
    if (!roles.includes(role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}
