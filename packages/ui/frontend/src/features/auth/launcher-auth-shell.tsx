import { IconSparkles } from "@tabler/icons-react"
import type * as React from "react"

import launcherMobileWallpaperUrl from "@/assets/launcher-wallpaper-mobile.webp"
import launcherWallpaperUrl from "@/assets/launcher-wallpaper.webp"

type LauncherAuthShellProps = {
  actions: React.ReactNode
  children: React.ReactNode
  page: "login" | "setup"
}

export function LauncherAuthShell({
  actions,
  children,
  page,
}: LauncherAuthShellProps) {
  return (
    <div data-launcher-auth-shell="true" data-miki-page={page} className="launcher-auth-shell">
      <picture className="launcher-auth-wallpaper" aria-hidden="true">
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
          data-launcher-wallpaper="true"
          width={1376}
          height={768}
          loading="eager"
          decoding="async"
        />
      </picture>
      <div className="launcher-auth-backdrop" aria-hidden="true" />
      <div className="launcher-auth-frame">
        <header className="launcher-auth-header">
          <div className="launcher-auth-brand">
            <span className="launcher-auth-mark" aria-hidden="true">
              <IconSparkles stroke={1.8} className="size-5" />
            </span>
            <span className="launcher-auth-wordmark">Miki</span>
          </div>
          <div className="launcher-auth-actions">{actions}</div>
        </header>

        <main className="launcher-auth-main">
          <div className="launcher-auth-content">{children}</div>
        </main>
      </div>
    </div>
  )
}
