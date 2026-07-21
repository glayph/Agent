import path from "path"

import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  return values.find((value) => value?.trim())
}

function localGatewayOrigin(env: Record<string, string>): string {
  // GATEWAY_PORT from .env can be a pending restart value. Use only explicit
  // frontend overrides here so the dev proxy keeps targeting the live gateway.
  const port = firstNonEmpty(
    env.VITE_GATEWAY_PORT,
    process.env.VITE_GATEWAY_PORT,
  )
  return `http://127.0.0.1:${port ?? "18800"}`
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const apiOrigin =
    env.VITE_API_HOST ||
    env.CORE_DEV_ORIGIN ||
    process.env.VITE_API_HOST ||
    process.env.CORE_DEV_ORIGIN ||
    localGatewayOrigin(env)
  const wsOrigin = apiOrigin.replace(/^http(s?):\/\//, (_, secure) =>
    secure ? "wss://" : "ws://",
  )

  return {
    plugins: [
      tanstackRouter({
        target: "react",
        autoCodeSplitting: true,
      }),
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    build: {
      chunkSizeWarningLimit: 2048,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes("node_modules")) return undefined
            if (/[\\/]node_modules[\\/](react|react-dom)[\\/]/.test(id)) {
              return "vendor-react"
            }
            if (
              /[\\/]node_modules[\\/]@tanstack[\\/](react-router|react-query|router-)/.test(
                id,
              )
            ) {
              return "vendor-tanstack"
            }
            if (
              /[\\/]node_modules[\\/](react-markdown|remark-|rehype-|micromark|mdast-|hast-|unist-|vfile|property-information|space-separated-tokens|comma-separated-tokens|html-void-elements|decode-named-character-reference|markdown-table|trim-lines|ccount|devlop)[\\/]/.test(
                id,
              )
            ) {
              return "vendor-markdown"
            }
            if (/[\\/]node_modules[\\/]highlight.js[\\/]/.test(id)) {
              return "vendor-highlight"
            }
            if (
              /[\\/]node_modules[\\/](@radix-ui|radix-ui|cmdk)[\\/]/.test(id)
            ) {
              return "vendor-ui"
            }
            // Separate i18n libraries
            if (
              /[\\/]node_modules[\\/](i18next|react-i18next|i18next-browser-languagedetector)[\\/]/.test(
                id,
              )
            ) {
              return "vendor-i18n"
            }
            // Separate icon library
            if (/[\\/]node_modules[\\/]@tabler[\\/]/.test(id)) {
              return "vendor-icons"
            }
            return undefined
          },
        },
      },
      modulePreload: {
        resolveDependencies(_filename, deps) {
          return deps.filter(
            (dep) =>
              !/assistant-message|message-code-block|vendor-markdown/.test(dep),
          )
        },
      },
    },
    server: {
      proxy: {
        "/api": {
          target: apiOrigin,
          changeOrigin: true,
        },
        "/gateway": {
          target: apiOrigin,
          changeOrigin: true,
        },
        "/pico/media": {
          target: apiOrigin,
          changeOrigin: true,
        },
        "/pico/ws": {
          target: wsOrigin,
          ws: true,
        },
      },
    },
  }
})
