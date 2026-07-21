import { useQuery } from "@tanstack/react-query"

import { getGatewayStatus } from "@/api/gateway"

export function useGatewayQuery(enabled = true) {
  return useQuery({
    queryKey: ["gateway", "status"],
    queryFn: getGatewayStatus,
    enabled,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      if (status === "starting" || status === "restarting" || status === "stopping") {
        return 1000 // Fast polling during state transitions
      }
      return 3000 // Standard polling
    },
    staleTime: 1000,
  })
}
