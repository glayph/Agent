export function cookieHeaderFromNetscapeJar(contents) {
  return String(contents)
    .split(/\r?\n/)
    .filter(
      (line) =>
        line && (!line.startsWith("#") || line.startsWith("#HttpOnly_")),
    )
    .map((line) => line.replace(/^#HttpOnly_/, ""))
    .map((line) => line.split("\t"))
    .filter((fields) => fields.length >= 7 && fields[5] && fields[6])
    .map((fields) => `${fields[5]}=${fields[6]}`)
    .join("; ");
}
