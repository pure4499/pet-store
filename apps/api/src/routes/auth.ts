import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { withOrgScope, withoutOrgScope } from "../db/pool.js";
import { asyncRoute, HttpError } from "../middleware/errorHandler.js";
import {
  signAccessToken,
  signPasswordResetToken,
  signRefreshToken,
  verifyPasswordResetToken,
  verifyRefreshToken,
} from "../utils/jwt.js";

export const authRouter = Router();
const PASSWORD_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

function passwordHasExpired(passwordChangedAt: string | Date): boolean {
  return Date.now() - new Date(passwordChangedAt).getTime() >= PASSWORD_MAX_AGE_MS;
}

const signupSchema = z.object({
  orgName: z.string().min(1),
  orgSlug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers, and hyphens"),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8),
  adminFullName: z.string().min(1),
});

// Self-serve org signup. Runs pre-auth, before any organization_id/RLS context
// exists, so it goes through the narrow create_organization_with_admin()
// SECURITY DEFINER function (see 0001_init_core_schema.sql) rather than a
// direct INSERT that RLS would otherwise reject outright.
authRouter.post(
  "/organizations",
  asyncRoute(async (req, res) => {
    const body = signupSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(body.adminPassword, 10);

    const { organizationId, userId } = await withoutOrgScope(async (client) => {
      const result = await client.query(
        "SELECT * FROM create_organization_with_admin($1, $2, $3, $4, $5)",
        [body.orgName, body.orgSlug, body.adminEmail, passwordHash, body.adminFullName]
      );
      return {
        organizationId: result.rows[0].organization_id as string,
        userId: result.rows[0].user_id as string,
      };
    });

    const accessToken = signAccessToken({ sub: userId, organizationId, role: "owner_admin" });
    const refreshToken = signRefreshToken(userId, 1);
    res.status(201).json({ organizationId, userId, accessToken, refreshToken });
  })
);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post(
  "/auth/login",
  asyncRoute(async (req, res) => {
    const body = loginSchema.parse(req.body);

    const user = await withoutOrgScope(async (client) => {
      const result = await client.query("SELECT * FROM find_user_for_login($1)", [body.email]);
      return result.rows[0] as
        | {
            id: string;
            organization_id: string;
            password_hash: string;
            role: "super_admin" | "owner_admin" | "manager" | "staff";
            status: string;
            auth_version: number;
            password_changed_at: string;
          }
        | undefined;
    });

    if (!user || user.status !== "active") {
      throw new HttpError(401, "Invalid email or password");
    }
    const passwordMatches = await bcrypt.compare(body.password, user.password_hash);
    if (!passwordMatches) {
      throw new HttpError(401, "Invalid email or password");
    }

    if (user.role !== "super_admin" && passwordHasExpired(user.password_changed_at)) {
      const passwordResetToken = signPasswordResetToken({
        sub: user.id,
        organizationId: user.organization_id,
        role: user.role,
        authVersion: user.auth_version,
      });
      return res.json({ passwordChangeRequired: true, passwordResetToken });
    }

    const accessToken = signAccessToken({
      sub: user.id,
      organizationId: user.organization_id,
      role: user.role,
    });
    const refreshToken = signRefreshToken(user.id, user.auth_version);
    res.json({ passwordChangeRequired: false, accessToken, refreshToken });
  })
);

const replaceExpiredPasswordSchema = z.object({
  passwordResetToken: z.string().min(1),
  newPassword: z.string().min(8),
});

authRouter.post(
  "/auth/password/expired",
  asyncRoute(async (req, res) => {
    const body = replaceExpiredPasswordSchema.parse(req.body);
    let claims: ReturnType<typeof verifyPasswordResetToken>;
    try {
      claims = verifyPasswordResetToken(body.passwordResetToken);
    } catch {
      throw new HttpError(401, "Password reset session expired; please sign in again");
    }

    const passwordHash = await bcrypt.hash(body.newPassword, 10);
    const user = await withOrgScope(claims.organizationId, async (client) => {
      const result = await client.query(
        `SELECT users.password_hash, users.status, users.auth_version, roles.slug AS role
         FROM users
         JOIN user_role_assignments assignments ON assignments.user_id = users.id
         JOIN roles ON roles.id = assignments.role_id
         WHERE users.id = $1 AND users.organization_id = $2`,
        [claims.sub, claims.organizationId]
      );
      const current = result.rows[0] as
        | { password_hash: string; status: string; auth_version: number; role: "super_admin" | "owner_admin" | "manager" | "staff" }
        | undefined;
      if (!current || current.status !== "active" || current.auth_version !== claims.authVersion) return null;
      if (await bcrypt.compare(body.newPassword, current.password_hash)) {
        throw new HttpError(400, "New password must be different from the current password");
      }
      const nextAuthVersion = current.auth_version + 1;
      await client.query(
        `UPDATE users
         SET password_hash = $1, password_changed_at = now(), auth_version = $2
         WHERE id = $3 AND organization_id = $4`,
        [passwordHash, nextAuthVersion, claims.sub, claims.organizationId]
      );
      return { authVersion: nextAuthVersion, role: current.role };
    });
    if (!user) throw new HttpError(401, "Password reset session is no longer valid; please sign in again");

    const accessToken = signAccessToken({
      sub: claims.sub,
      organizationId: claims.organizationId,
      role: user.role,
    });
    const refreshToken = signRefreshToken(claims.sub, user.authVersion);
    res.json({ accessToken, refreshToken });
  })
);

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

authRouter.post(
  "/auth/refresh",
  asyncRoute(async (req, res) => {
    const body = refreshSchema.parse(req.body);
    let claims: { sub: string; authVersion?: number };
    try {
      claims = verifyRefreshToken(body.refreshToken);
    } catch {
      throw new HttpError(401, "Invalid or expired refresh token");
    }

    // Re-derive the user's current org/role rather than trusting anything from
    // the refresh token beyond identity, in case role/org membership changed.
    const user = await withoutOrgScope(async (client) => {
      const result = await client.query("SELECT * FROM find_user_by_id($1)", [claims.sub]);
      return result.rows[0] as
        | { id: string; organization_id: string; role: "super_admin" | "owner_admin" | "manager" | "staff"; status: string; auth_version: number; password_changed_at: string }
        | undefined;
    });
    if (!user || user.status !== "active") {
      throw new HttpError(401, "Account no longer active");
    }
    if ((claims.authVersion ?? 1) !== user.auth_version) {
      throw new HttpError(401, "Password changed; please sign in again");
    }
    if (user.role !== "super_admin" && passwordHasExpired(user.password_changed_at)) {
      throw new HttpError(401, "Password expired; please sign in to choose a new password");
    }

    const accessToken = signAccessToken({
      sub: user.id,
      organizationId: user.organization_id,
      role: user.role,
    });
    res.json({ accessToken });
  })
);
