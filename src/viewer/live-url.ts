/** Preserve an explicit match selection when connecting the live viewer. */
export function liveStreamUrl(params: URLSearchParams): string {
  const match = params.get("match");
  return match ? `/api/live?${new URLSearchParams({ match })}` : "/api/live";
}
