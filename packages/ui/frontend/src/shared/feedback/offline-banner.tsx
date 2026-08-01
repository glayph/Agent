import { IconWifiOff } from "@tabler/icons-react"
import { useEffect, useState } from "react"

export function OfflineBanner() {
  const [isOffline, setIsOffline] = useState(
    typeof navigator !== "undefined" ? !navigator.onLine : false,
  )

  useEffect(() => {
    function handleOnline() {
      setIsOffline(false)
    }
    function handleOffline() {
      setIsOffline(true)
    }

    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)

    return () => {
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [])

  if (!isOffline) return null

  return (
    <div className="bg-destructive text-destructive-foreground fixed inset-x-0 top-0 z-[200] flex items-center justify-center gap-2 py-1.5 px-4 text-xs font-medium shadow-md animate-in slide-in-from-top">
      <IconWifiOff size={16} />
      <span>You are currently offline. Check your network connection.</span>
    </div>
  )
}
