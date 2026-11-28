export const PUBLIC_RECORDS = "/records/";
export const INTERNAL_DIR = "internal";

export function recordPath(file: string, internal = false): string {
  return internal ? `${INTERNAL_DIR}/${file}` : PUBLIC_RECORDS + file;
}

export function publicRecordFile(path: string): string | null {
  return path.startsWith(PUBLIC_RECORDS) ? path.slice(PUBLIC_RECORDS.length) : null;
}
