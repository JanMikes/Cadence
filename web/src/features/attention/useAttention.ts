import { useQuery } from "@tanstack/react-query";
import { getAttention } from "../../lib/api";

/**
 * The unified "needs you" feed (§10). Shared by the top-bar pill and the Attention
 * Center so they read one cache entry. WS events invalidate ["attention"] (App.tsx);
 * the poll is a safety net (and keeps live tool-approvals snappy).
 */
export function useAttention() {
  return useQuery({ queryKey: ["attention"], queryFn: getAttention, refetchInterval: 3000 });
}
