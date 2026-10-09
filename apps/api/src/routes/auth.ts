import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { withoutOrgScope } from "../db/pool.js";
import { asyncRoute, HttpError } from "../middleware/errorHandler.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt.js";

export const authRouter = Router();

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
            role: "owner_admin" | "manager" | "staff";
            status: string;
            auth_version: number;
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

    const accessToken = signAccessToken({
      sub: user.id,
      organizationId: user.organization_id,
      role: user.role,
    });
    const refreshToken = signRefreshToken(user.id, user.auth_version);
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
        | { id: string; organization_id: string; role: "owner_admin" | "manager" | "staff"; status: string; auth_version: number }
        | undefined;
    });
    if (!user || user.status !== "active") {
      throw new HttpError(401, "Account no longer active");
    }
    if ((claims.authVersion ?? 1) !== user.auth_version) {
      throw new HttpError(401, "Password changed; please sign in again");
    }

    const accessToken = signAccessToken({
      sub: user.id,
      organizationId: user.organization_id,
      role: user.role,
    });
    res.json({ accessToken });
  })
);
