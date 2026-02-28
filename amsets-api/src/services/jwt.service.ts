import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET ?? "change-me";
const EXPIRES_IN = process.env.JWT_EXPIRES_IN ?? "7d";

export interface JwtPayload {
  sub: string; // wallet address
  userId: string;
}

export interface ContentJwtPayload {
  sub: string; // wallet address
  contentId: string;
  allowedActions: string[];
}

export function signUserJwt(payload: JwtPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES_IN } as jwt.SignOptions);
}

export function verifyUserJwt(token: string): JwtPayload {
  return jwt.verify(token, SECRET) as JwtPayload;
}

export function signContentJwt(payload: ContentJwtPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: "1h" } as jwt.SignOptions);
}

export function verifyContentJwt(token: string): ContentJwtPayload {
  return jwt.verify(token, SECRET) as ContentJwtPayload;
}
