export type FlatValue = string | number | boolean | undefined
export type ErrorField = [name: string, value: FlatValue]
export type OutputField = [name: string, value: FlatValue]
export type OutputPayload = {
  key: string
  value: string
}

const normalizeScalar = (value: Exclude<FlatValue, undefined>) => String(value).replace(/\r?\n/g, " ")

export const formatOutput = (parts: Array<OutputField | OutputPayload>) => {
  const out: string[] = []
  for (const part of parts) {
    if (Array.isArray(part)) {
      const [name, value] = part
      if (value === undefined) continue
      out.push(`#${name}:${normalizeScalar(value)}`)
      continue
    }

    out.push(`#${part.key}_bytes:${Buffer.byteLength(part.value, "utf8")}`)
    if (part.value.length > 0) out.push(part.value)
  }
  return out.join("\n")
}

export const outputPayload = (key: string, value: string): OutputPayload => ({ key, value })

export const formatError = (code: string, message: string, fields: ErrorField[] = []) => {
  return formatOutput([
    ["error", code],
    ["message", message],
    ...fields,
  ])
}

export const isErrorOutput = (value: string) => value.startsWith("#error:")
