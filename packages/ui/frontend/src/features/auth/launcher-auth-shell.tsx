import type * as React from "react"

import launcherMobileWallpaperUrl from "@/assets/launcher-wallpaper-mobile.webp"
import launcherWallpaperUrl from "@/assets/launcher-wallpaper.webp"

type LauncherAuthShellProps = {
  actions: React.ReactNode
  children: React.ReactNode
}

export function LauncherAuthShell({
  actions,
  children,
}: LauncherAuthShellProps) {
  return (
    <div
      data-launcher-auth-shell="true"
      className="bg-background text-foreground relative isolate min-h-dvh overflow-hidden"
    >
      <picture className="absolute inset-0 -z-30 block size-full">
        <source
          media="(max-width: 720px) and (max-height: 1600px)"
          srcSet={launcherMobileWallpaperUrl}
          type="image/webp"
          width={720}
          height={1600}
        />
        <img
          src={launcherWallpaperUrl}
          alt=""
          aria-hidden="true"
          data-launcher-wallpaper="true"
          className="size-full object-cover object-center"
          width={1376}
          height={768}
          loading="eager"
          decoding="async"
        />
      </picture>
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-20 bg-[linear-gradient(90deg,rgba(5,18,19,0.54)_0%,rgba(11,33,38,0.26)_34%,rgba(255,246,207,0.04)_68%,rgba(6,24,28,0.36)_100%)]"
      />
      <div
        aria-hidden="true"
        className="from-background/75 via-background/18 absolute inset-x-0 bottom-0 -z-10 h-52 bg-gradient-to-t to-transparent"
      />

      <div className="relative z-10 flex min-h-dvh flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between gap-3 px-4 sm:px-6 lg:px-10">
          <div className="flex items-center gap-2 rounded-md border border-white/20 bg-white/16 px-2.5 py-2 text-white shadow-sm backdrop-blur-md dark:bg-black/18">
            <div className="flex size-8 items-center justify-center rounded-md bg-white/88 text-[13px] font-semibold text-[#14251f]">
              O
            </div>
            <span className="text-sm font-semibold">Hiro</span>
          </div>
          <div className="flex items-center gap-2 rounded-md border border-white/20 bg-white/16 p-1.5 shadow-sm backdrop-blur-md dark:bg-black/18">
            {actions}
          </div>
        </header>

        <main className="flex flex-1 items-center justify-center px-4 py-8 sm:px-8 lg:justify-end lg:px-16">
          <div className="w-full max-w-md">{children}</div>
        </main>
      </div>
    </div>
  )
}
