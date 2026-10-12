import bcrypt from "bcryptjs";
import { Router } from "express";
import { z } from "zod";
import { withOrgScope } from "../db/pool.js";
import { asyncRoute, HttpError } from "../middleware/errorHandler.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

export const organizationsRouter = Router();
organizationsRouter.use(requireAuth);

organizationsRouter.get(
  "/organizations/me",
  asyncRoute(async (req, res) => {
    const org = await withOrgScope(req.auth!.organizationId, async (client) => {
      const orgResult = await client.query(
        `SELECT o.*, s.best_photo_count, s.match_confidence_threshold, s.low_confidence_threshold, s.collar_feature_enabled
         FROM organizations o JOIN organization_settings s ON s.organization_id = o.id
         WHERE o.id = $1`,
        [req.auth!.organizationId]
      );
      return orgResult.rows[0];
    });
    res.json(org);
  })
);

organizationsRouter.get(
  "/users/me",
  asyncRoute(async (req, res) => {
    const profile = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `SELECT users.id, users.email, users.full_name, users.status,
                users.created_at, users.last_login_at,
                roles.id AS role_id, roles.slug AS role_slug,
                roles.display_name AS role_name, roles.description AS role_description,
                organizations.name AS organization_name
         FROM users
         JOIN user_role_assignments assignments ON assignments.user_id = users.id
         JOIN roles ON roles.id = assignments.role_id
         JOIN organizations ON organizations.id = users.organization_id
         WHERE users.id = $1 AND users.organization_id = $2`,
        [req.auth!.sub, req.auth!.organizationId]
      );
      return result.rows[0];
    });
    if (!profile) throw new HttpError(404, "User not found");
    res.json(profile);
  })
);

organizationsRouter.get(
  "/organizations/me/facilities",
  asyncRoute(async (req, res) => {
    const facilities = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `SELECT facilities.id, facilities.name, facilities.is_default, facilities.is_active
         FROM facilities
         WHERE facilities.organization_id = $1
           AND facilities.is_active = true
           AND (
             $2::text <> 'staff'
             OR EXISTS (
               SELECT 1 FROM user_facility_assignments assignment
               WHERE assignment.organization_id = facilities.organization_id
                 AND assignment.facility_id = facilities.id
                 AND assignment.user_id = $3
             )
           )
         ORDER BY facilities.is_default DESC, facilities.name`,
        [req.auth!.organizationId, req.auth!.role, req.auth!.sub]
      );
      return result.rows;
    });
    res.json(facilities);
  })
);

const createFacilitySchema = z.object({ name: z.string().trim().min(1).max(120) });

organizationsRouter.post(
  "/organizations/me/facilities",
  requireRole("owner_admin"),
  asyncRoute(async (req, res) => {
    const body = createFacilitySchema.parse(req.body);
    const facility = await withOrgScope(req.auth!.organizationId, async (client) => {
      try {
        const result = await client.query(
          `INSERT INTO facilities (organization_id, name)
           VALUES ($1, $2)
           RETURNING id, name, is_default, is_active`,
          [req.auth!.organizationId, body.name]
        );
        return result.rows[0];
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new HttpError(409, "A location with that name already exists");
        }
        throw error;
      }
    });
    res.status(201).json(facility);
  })
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
}).refine((body) => body.currentPassword !== body.newPassword, {
  message: "New password must be different from the current password",
  path: ["newPassword"],
});

organizationsRouter.put(
  "/users/me/password",
  asyncRoute(async (req, res) => {
    const body = changePasswordSchema.parse(req.body);
    const updated = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `SELECT password_hash FROM users
         WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
        [req.auth!.sub, req.auth!.organizationId]
      );
      if (!result.rows[0]) return false;
      const matches = await bcrypt.compare(body.currentPassword, result.rows[0].password_hash);
      if (!matches) throw new HttpError(400, "Current password is incorrect");
      const passwordHash = await bcrypt.hash(body.newPassword, 10);
      await client.query(
        `UPDATE users
         SET password_hash = $1, password_changed_at = now(), auth_version = auth_version + 1
         WHERE id = $2 AND organization_id = $3`,
        [passwordHash, req.auth!.sub, req.auth!.organizationId]
      );
      return true;
    });
    if (!updated) throw new HttpError(404, "User not found");
    res.json({ updated: true });
  })
);

organizationsRouter.get(
  "/organizations/me/users",
  requireRole("owner_admin", "manager"),
  asyncRoute(async (req, res) => {
    const users = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `SELECT users.id, users.email, users.full_name, users.status,
                users.created_at, users.last_login_at,
                roles.id AS role_id, roles.slug AS role_slug,
                roles.display_name AS role_name, roles.description AS role_description,
                COALESCE((
                  SELECT json_agg(json_build_object('id', facilities.id, 'name', facilities.name) ORDER BY facilities.is_default DESC, facilities.name)
                  FROM user_facility_assignments assignment
                  JOIN facilities ON facilities.id = assignment.facility_id
                    AND facilities.organization_id = assignment.organization_id
                  WHERE assignment.organization_id = users.organization_id
                    AND assignment.user_id = users.id
                    AND facilities.is_active = true
                ), '[]'::json) AS facilities
         FROM users
         JOIN user_role_assignments assignments ON assignments.user_id = users.id
         JOIN roles ON roles.id = assignments.role_id
         WHERE users.organization_id = $1 AND roles.slug <> 'super_admin'
         ORDER BY users.full_name, users.email`,
        [req.auth!.organizationId]
      );
      return result.rows;
    });
    res.json(users);
  })
);

organizationsRouter.get(
  "/organizations/me/roles",
  requireRole("owner_admin", "manager"),
  asyncRoute(async (req, res) => {
    const roles = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `SELECT id, slug, display_name, description, priority
         FROM roles
         WHERE organization_id = $1 AND slug <> 'super_admin'
         ORDER BY priority DESC`,
        [req.auth!.organizationId]
      );
      return result.rows;
    });
    res.json(roles);
  })
);

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(1),
  roleId: z.string().uuid().optional(),
  role: z.enum(["manager", "staff"]).optional(),
  facilityIds: z.array(z.string().uuid()).max(100).optional(),
}).refine((body) => body.roleId || body.role, { message: "A role is required" });

organizationsRouter.post(
  "/organizations/me/users",
  requireRole("owner_admin"),
  asyncRoute(async (req, res) => {
    const body = createUserSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(body.password, 10);
    const user = await withOrgScope(req.auth!.organizationId, async (client) => {
      try {
        const roleResult = await client.query(
          `SELECT id FROM roles
           WHERE organization_id = $1
             AND slug IN ('manager', 'staff')
             AND (
               ($2::uuid IS NOT NULL AND id = $2)
               OR ($2::uuid IS NULL AND slug = $3 AND slug IN ('manager', 'staff'))
             )`,
          [req.auth!.organizationId, body.roleId ?? null, body.role ?? null]
        );
        if (!roleResult.rows[0]) throw new HttpError(400, "Role not found");

        const userResult = await client.query(
          `INSERT INTO users (organization_id, email, password_hash, full_name)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [req.auth!.organizationId, body.email, passwordHash, body.fullName]
        );
        await client.query(
          `INSERT INTO user_role_assignments
             (organization_id, user_id, role_id, assigned_by)
           VALUES ($1, $2, $3, $4)`,
          [req.auth!.organizationId, userResult.rows[0].id, roleResult.rows[0].id, req.auth!.sub]
        );
        if (body.facilityIds !== undefined) {
          const uniqueFacilityIds = [...new Set(body.facilityIds)];
          const validFacilities = await client.query(
            `SELECT id FROM facilities
             WHERE organization_id = $1 AND is_active = true AND id = ANY($2::uuid[])`,
            [req.auth!.organizationId, uniqueFacilityIds]
          );
          if (validFacilities.rows.length !== uniqueFacilityIds.length) {
            throw new HttpError(400, "One or more locations were not found");
          }
          if (uniqueFacilityIds.length === 0) throw new HttpError(400, "Assign at least one location");
          await client.query(
            `DELETE FROM user_facility_assignments
             WHERE organization_id = $1 AND user_id = $2`,
            [req.auth!.organizationId, userResult.rows[0].id]
          );
          await client.query(
            `INSERT INTO user_facility_assignments (organization_id, user_id, facility_id, assigned_by)
             SELECT $1, $2, facility_id, $3
             FROM unnest($4::uuid[]) AS facility_id`,
            [req.auth!.organizationId, userResult.rows[0].id, req.auth!.sub, uniqueFacilityIds]
          );
        }
        const result = await client.query(
          `SELECT users.id, users.email, users.full_name, users.status,
                  users.created_at, users.last_login_at,
                  roles.id AS role_id, roles.slug AS role_slug,
                  roles.display_name AS role_name, roles.description AS role_description,
                  COALESCE((
                    SELECT json_agg(json_build_object('id', facilities.id, 'name', facilities.name) ORDER BY facilities.is_default DESC, facilities.name)
                    FROM user_facility_assignments assignment
                    JOIN facilities ON facilities.id = assignment.facility_id
                      AND facilities.organization_id = assignment.organization_id
                    WHERE assignment.organization_id = users.organization_id
                      AND assignment.user_id = users.id
                      AND facilities.is_active = true
                  ), '[]'::json) AS facilities
           FROM users
           JOIN user_role_assignments assignments ON assignments.user_id = users.id
           JOIN roles ON roles.id = assignments.role_id
           WHERE users.id = $1 AND users.organization_id = $2`,
          [userResult.rows[0].id, req.auth!.organizationId]
        );
        return result.rows[0];
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new HttpError(409, "An account with that email already exists");
        }
        throw error;
      }
    });
    res.status(201).json(user);
  })
);

const updateUserSchema = z.object({
  fullName: z.string().trim().min(1).optional(),
  email: z.string().trim().email().transform((value) => value.toLowerCase()).optional(),
  status: z.enum(["active", "disabled"]).optional(),
}).refine((body) => body.fullName !== undefined || body.email !== undefined || body.status !== undefined, {
  message: "At least one user field is required",
});

organizationsRouter.patch(
  "/organizations/me/users/:userId",
  requireRole("owner_admin"),
  asyncRoute(async (req, res) => {
    const body = updateUserSchema.parse(req.body);
    const user = await withOrgScope(req.auth!.organizationId, async (client) => {
      const targetRole = await client.query(
        `SELECT roles.slug
         FROM users
         JOIN user_role_assignments assignments ON assignments.user_id = users.id
         JOIN roles ON roles.id = assignments.role_id
         WHERE users.id = $1 AND users.organization_id = $2`,
        [req.params.userId, req.auth!.organizationId]
      );
      if (!targetRole.rows[0] || targetRole.rows[0].slug === "super_admin") {
        throw new HttpError(404, "User not found");
      }
      if (body.status === "disabled") {
        if (targetRole.rows[0].slug === "owner_admin") {
          const otherOwners = await client.query(
            `SELECT count(*)::int AS count
             FROM users
             JOIN user_role_assignments assignments ON assignments.user_id = users.id
             JOIN roles ON roles.id = assignments.role_id
             WHERE users.organization_id = $1 AND users.status = 'active'
               AND users.id <> $2 AND roles.slug = 'owner_admin'`,
            [req.auth!.organizationId, req.params.userId]
          );
          if (otherOwners.rows[0].count === 0) {
            throw new HttpError(400, "The organization must keep one active owner administrator");
          }
        }
      }
      try {
        const result = await client.query(
          `UPDATE users
           SET full_name = COALESCE($1, full_name),
               email = COALESCE($2, email),
               status = COALESCE($3, status)
           WHERE id = $4 AND organization_id = $5
           RETURNING id, email, full_name, status, created_at, last_login_at`,
          [body.fullName, body.email, body.status, req.params.userId, req.auth!.organizationId]
        );
        return result.rows[0];
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new HttpError(409, "An account with that email already exists");
        }
        throw error;
      }
    });
    if (!user) throw new HttpError(404, "User not found");
    res.json(user);
  })
);

const assignRoleSchema = z.object({ roleId: z.string().uuid() });
const assignFacilitiesSchema = z.object({ facilityIds: z.array(z.string().uuid()).min(1).max(100) });

const resetPasswordSchema = z.object({ newPassword: z.string().min(8) });

organizationsRouter.put(
  "/organizations/me/users/:userId/facilities",
  requireRole("owner_admin"),
  asyncRoute(async (req, res) => {
    const body = assignFacilitiesSchema.parse(req.body);
    const facilityIds = [...new Set(body.facilityIds)];
    const assignments = await withOrgScope(req.auth!.organizationId, async (client) => {
      const user = await client.query(
        `SELECT users.id
         FROM users
         JOIN user_role_assignments assignments ON assignments.user_id = users.id
         JOIN roles ON roles.id = assignments.role_id
         WHERE users.id = $1 AND users.organization_id = $2 AND roles.slug <> 'super_admin'`,
        [req.params.userId, req.auth!.organizationId]
      );
      if (!user.rows[0]) throw new HttpError(404, "User not found");
      const valid = await client.query(
        `SELECT id FROM facilities
         WHERE organization_id = $1 AND is_active = true AND id = ANY($2::uuid[])`,
        [req.auth!.organizationId, facilityIds]
      );
      if (valid.rows.length !== facilityIds.length) throw new HttpError(400, "One or more locations were not found");
      await client.query(
        `DELETE FROM user_facility_assignments WHERE organization_id = $1 AND user_id = $2`,
        [req.auth!.organizationId, req.params.userId]
      );
      await client.query(
        `INSERT INTO user_facility_assignments (organization_id, user_id, facility_id, assigned_by)
         SELECT $1, $2, facility_id, $3 FROM unnest($4::uuid[]) AS facility_id`,
        [req.auth!.organizationId, req.params.userId, req.auth!.sub, facilityIds]
      );
      return valid.rows;
    });
    res.json({ facilities: assignments });
  })
);

organizationsRouter.put(
  "/organizations/me/users/:userId/password",
  requireRole("owner_admin"),
  asyncRoute(async (req, res) => {
    const body = resetPasswordSchema.parse(req.body);
    const passwordHash = await bcrypt.hash(body.newPassword, 10);
    const updated = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `UPDATE users
         SET password_hash = $1, password_changed_at = now(), auth_version = auth_version + 1
         WHERE id = $2 AND organization_id = $3
           AND NOT EXISTS (
             SELECT 1 FROM user_role_assignments assignments
             JOIN roles ON roles.id = assignments.role_id
             WHERE assignments.user_id = users.id AND roles.slug = 'super_admin'
           )
         RETURNING id`,
        [passwordHash, req.params.userId, req.auth!.organizationId]
      );
      return result.rows[0];
    });
    if (!updated) throw new HttpError(404, "User not found");
    res.json({ updated: true });
  })
);

organizationsRouter.put(
  "/organizations/me/users/:userId/role",
  requireRole("owner_admin"),
  asyncRoute(async (req, res) => {
    const body = assignRoleSchema.parse(req.body);
    const assignment = await withOrgScope(req.auth!.organizationId, async (client) => {
      const roleResult = await client.query(
        `SELECT id, slug, display_name, description
         FROM roles WHERE id = $1 AND organization_id = $2 AND slug <> 'super_admin'`,
        [body.roleId, req.auth!.organizationId]
      );
      const role = roleResult.rows[0];
      if (!role) throw new HttpError(400, "Role not found");

      const currentResult = await client.query(
        `SELECT roles.slug
         FROM users
         JOIN user_role_assignments assignments ON assignments.user_id = users.id
         JOIN roles ON roles.id = assignments.role_id
         WHERE users.id = $1 AND users.organization_id = $2`,
        [req.params.userId, req.auth!.organizationId]
      );
      if (!currentResult.rows[0]) throw new HttpError(404, "User not found");
      if (currentResult.rows[0].slug === "super_admin") throw new HttpError(404, "User not found");
      if (currentResult.rows[0].slug === "owner_admin" && role.slug !== "owner_admin") {
        const otherOwners = await client.query(
          `SELECT count(*)::int AS count
           FROM users
           JOIN user_role_assignments assignments ON assignments.user_id = users.id
           JOIN roles ON roles.id = assignments.role_id
           WHERE users.organization_id = $1 AND users.status = 'active'
             AND users.id <> $2 AND roles.slug = 'owner_admin'`,
          [req.auth!.organizationId, req.params.userId]
        );
        if (otherOwners.rows[0].count === 0) {
          throw new HttpError(400, "The organization must keep one active owner administrator");
        }
      }

      await client.query(
        `UPDATE user_role_assignments
         SET role_id = $1, assigned_by = $2, assigned_at = now()
         WHERE user_id = $3 AND organization_id = $4`,
        [role.id, req.auth!.sub, req.params.userId, req.auth!.organizationId]
      );
      return { roleId: role.id, roleSlug: role.slug, roleName: role.display_name, roleDescription: role.description };
    });
    res.json(assignment);
  })
);

const updateSettingsSchema = z.object({
  bestPhotoCount: z.number().int().min(1).max(50).optional(),
  matchConfidenceThreshold: z.number().min(0).max(1).optional(),
  lowConfidenceThreshold: z.number().min(0).max(1).optional(),
  collarFeatureEnabled: z.boolean().optional(),
});

organizationsRouter.patch(
  "/organizations/me/settings",
  requireRole("owner_admin", "manager"),
  asyncRoute(async (req, res) => {
    const body = updateSettingsSchema.parse(req.body);
    const settings = await withOrgScope(req.auth!.organizationId, async (client) => {
      const result = await client.query(
        `UPDATE organization_settings
         SET best_photo_count = COALESCE($1, best_photo_count),
             match_confidence_threshold = COALESCE($2, match_confidence_threshold),
             low_confidence_threshold = COALESCE($3, low_confidence_threshold),
             collar_feature_enabled = COALESCE($4, collar_feature_enabled),
             updated_at = now()
         WHERE organization_id = $5
         RETURNING *`,
        [
          body.bestPhotoCount,
          body.matchConfidenceThreshold,
          body.lowConfidenceThreshold,
          body.collarFeatureEnabled,
          req.auth!.organizationId,
        ]
      );
      return result.rows[0];
    });
    res.json(settings);
  })
);

organizationsRouter.get(
  "/organizations/me/collar-palette",
  asyncRoute(async (req, res) => {
    const rows = await withOrgScope(req.auth!.organizationId, async (client) => {
      // Colors currently claimed by an active session, so the client can grey
      // them out before submitting a check-in (mirroring the backend's
      // uq_active_collar_per_org constraint rather than relying on it alone).
      const result = await client.query(
        `SELECT c.*, 'ucbarkley://collar/' || c.id::text AS qr_payload, EXISTS (
           SELECT 1 FROM sessions s
           WHERE s.collar_palette_id = c.id AND s.status = 'active'
         ) AS in_use
         FROM organization_collar_palette c
         WHERE c.organization_id = $1 AND c.is_active = true
         ORDER BY c.color_name`,
        [req.auth!.organizationId]
      );
      return result.rows;
    });
    res.json(rows);
  })
);

const createColorSchema = z.object({
  colorName: z.string().trim().min(1).max(80),
  colorHex: z.string().regex(/^#[0-9a-f]{6}$/i, "Choose a valid collar color"),
});

organizationsRouter.post(
  "/organizations/me/collar-palette",
  requireRole("owner_admin", "manager"),
  asyncRoute(async (req, res) => {
    const body = createColorSchema.parse(req.body);
    const color = await withOrgScope(req.auth!.organizationId, async (client) => {
      try {
        const result = await client.query(
          `INSERT INTO organization_collar_palette (organization_id, color_name, color_hex)
           VALUES ($1, $2, $3) RETURNING *`,
          [req.auth!.organizationId, body.colorName, body.colorHex]
        );
        return result.rows[0];
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw new HttpError(409, "A collar with that color name already exists");
        }
        throw error;
      }
    });
    res.status(201).json(color);
  })
);
