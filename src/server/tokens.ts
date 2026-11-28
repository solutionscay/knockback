/** Credentials for owner keys and Arena seats. */
import { createHash, randomBytes } from "node:crypto";

export const hex = (bytes: number) => randomBytes(bytes).toString("hex");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const bearer = (req: Request) => /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;
