export function AppBackground() {
  return (
    <div className="app-background" aria-hidden="true">
      <div data-bg-layer="aurora" />
      <div data-bg-layer="grid" />
      <svg
        className="app-background__mesh"
        viewBox="0 0 1200 800"
        preserveAspectRatio="none"
        focusable="false"
      >
        <defs>
          <linearGradient id="app-background-flow" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--ring)" stopOpacity="0.12" />
            <stop offset="44%" stopColor="var(--primary)" stopOpacity="0.34" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.16" />
          </linearGradient>
        </defs>
        <path
          data-bg-line="slow"
          d="M-60 210 C170 112 286 302 430 232 C586 156 628 80 792 144 C944 203 998 356 1260 246"
        />
        <path
          data-bg-line="medium"
          d="M-40 558 C134 454 226 620 382 516 C540 412 640 522 790 440 C920 370 1010 246 1240 330"
        />
        <path
          data-bg-line="fast"
          d="M56 764 C190 672 278 686 404 604 C548 510 606 340 780 330 C952 320 1018 476 1188 420"
        />
      </svg>
    </div>
  )
}
