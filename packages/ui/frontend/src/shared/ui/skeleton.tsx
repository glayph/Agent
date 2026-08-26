import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "motion-shimmer bg-muted overflow-hidden rounded-md",
        className,
      )}
      {...props}
    />
  )
}

export { Skeleton }
