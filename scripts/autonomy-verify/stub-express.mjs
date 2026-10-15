const chain = () => new Proxy(function () {}, { get: () => chain(), apply: () => chain() })
export const Router = () => chain()
export default function express() { return chain() }
