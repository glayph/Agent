import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react"
import { Component, type ErrorInfo, type ReactNode } from "react"

import { Button } from "@/shared/ui/button"

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export class RouteErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Route Error Caught:", error, errorInfo)
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="animate-fade-in flex h-full w-full flex-col items-center justify-center p-6 text-center">
          <div className="bg-destructive/10 text-destructive mb-4 flex size-14 items-center justify-center rounded-2xl">
            <IconAlertTriangle size={28} />
          </div>
          <h2 className="text-foreground text-lg font-bold tracking-tight">
            Something went wrong on this page
          </h2>
          <div className="mt-4 w-full max-w-md">
            <details className="group rounded-lg border border-border/70 bg-muted/30 text-left">
              <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
                <span className="flex items-center justify-between gap-3">
                  <span>Technical details</span>
                  <span className="transition-transform group-open:rotate-180">⌄</span>
                </span>
              </summary>
              <div className="border-t border-border/60 px-3 py-2.5 font-mono text-[11px] leading-5 break-words text-muted-foreground">
                {this.state.error?.message || "An unexpected error occurred."}
              </div>
            </details>
          </div>
          <div className="mt-5 flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={this.handleReset}>
              <IconRefresh className="mr-1.5 size-4" />
              Retry
            </Button>
            <Button size="sm" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
