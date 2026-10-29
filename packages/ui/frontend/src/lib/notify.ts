import { toast, type ExternalToast } from "sonner"

/** A small, consistent toast API. Supplying the same id updates that toast. */
type NotifyOptions = ExternalToast

function optionsWithDefaults(
  defaults: ExternalToast,
  options?: NotifyOptions,
): ExternalToast {
  return { ...defaults, ...options }
}

export const notify = {
  success(message: string, options?: NotifyOptions) {
    toast.success(message, optionsWithDefaults({ duration: 2500 }, options))
  },
  error(message: string, options?: NotifyOptions) {
    toast.error(
      message,
      optionsWithDefaults({ duration: 6000, closeButton: true }, options),
    )
  },
  warning(message: string, options?: NotifyOptions) {
    toast.warning(message, optionsWithDefaults({ duration: 5000 }, options))
  },
  info(message: string, options?: NotifyOptions) {
    toast.info(message, optionsWithDefaults({ duration: 3500 }, options))
  },
  loading(message: string, options?: NotifyOptions) {
    toast.loading(message, optionsWithDefaults({ duration: Infinity }, options))
  },
  dismiss(id?: string | number) {
    toast.dismiss(id)
  },
}
