import jwt from "jsonwebtoken";
import { config } from "../config.js";

export interface AccessTokenClaims {
  sub: string; // user id
  organizationId: string;
  role: "owner_admin" | "manager" | "staff";
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
