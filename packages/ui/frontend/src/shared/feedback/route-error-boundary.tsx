import { Component, type ErrorInfo, type ReactNode } from "react"
import { IconAlertTriangle, IconRefresh } from "@tabler/icons-react"

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
        <div className="flex h-full w-full flex-col items-center justify-center p-6 text-center animate-fade-in">
          <div className="bg-destructive/10 text-destructive mb-4 flex size-14 items-center justify-center rounded-2xl">
            <IconAlertTriangle size={28} />
          </div>
          <h2 className="text-foreground text-lg font-bold tracking-tight">
            Something went wrong on this page
          </h2>
          <p className="text-muted-foreground mt-1.5 max-w-md text-xs font-mono">
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <div className="mt-6 flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={this.handleReset}>
              <IconRefresh className="mr-1.5 size-4" />
              Try Again
            </Button>
            <Button size="sm" onClick={() => window.location.reload()}>
              Reload Page
            </Button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
