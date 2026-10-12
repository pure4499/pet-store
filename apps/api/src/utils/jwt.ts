import jwt from "jsonwebtoken";
import { config } from "../config.js";

export interface AccessTokenClaims {
  sub: string; // user id
  organizationId: string;
  role: "super_admin" | "owner_admin" | "manager" | "staff";
}

interface PasswordResetTokenClaims extends AccessTokenClaims {
  authVersion: number;
  purpose: "expired-password-reset";
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, config.jwt.accessSecret, { expiresIn: config.jwt.accessTtl });
}

export function signRefreshToken(userId: string, authVersion = 1): string {
  return jwt.sign({ sub: userId, authVersion }, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshTtl });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  return jwt.verify(token, config.jwt.accessSecret) as AccessTokenClaims;
}

export function verifyRefreshToken(token: string): { sub: string; authVersion?: number } {
  return jwt.verify(token, config.jwt.refreshSecret) as { sub: string; authVersion?: number };
}

export function signPasswordResetToken(
  claims: Omit<PasswordResetTokenClaims, "purpose">
): string {
  return jwt.sign(
    { ...claims, purpose: "expired-password-reset" },
    config.jwt.accessSecret,
    { expiresIn: "10m" }
  );
}

export function verifyPasswordResetToken(token: string): PasswordResetTokenClaims {
  const claims = jwt.verify(token, config.jwt.accessSecret) as PasswordResetTokenClaims;
  if (claims.purpose !== "expired-password-reset") throw new Error("Invalid password reset token");
  return claims;
}
