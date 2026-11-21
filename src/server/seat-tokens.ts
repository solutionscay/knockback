/** Seat tokens: random ids, and the sha256 the server keeps instead of the token. */
import { createHash, randomBytes } from "node:crypto";

export const hex = (bytes: number) => randomBytes(bytes).toString("hex");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
