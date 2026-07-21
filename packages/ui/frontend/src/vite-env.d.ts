/// <reference types="vite/client" />

declare module "*.webp" {
  const src: string
  export default src
}

declare module "*.css?inline" {
  const content: string
  export default content
}

declare module "*.css" {
  const content: string
  export default content
}
