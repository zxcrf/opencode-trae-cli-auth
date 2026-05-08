export type ToolDelta = {
  index: number
  id?: string
  name?: string
  argumentsDelta?: string
}

export type ToolDeltaState = {
  id: string
  name: string
  input: string
}

export function applyToolDelta(
  toolCalls: Map<number, ToolDeltaState>,
  delta: ToolDelta,
): void {
  const current = toolCalls.get(delta.index) ?? {
    id: delta.id ?? `call_${delta.index}`,
    name: delta.name ?? '',
    input: '',
  }
  if (delta.id) current.id = delta.id
  if (delta.name) current.name = delta.name
  if (delta.argumentsDelta) current.input += delta.argumentsDelta
  toolCalls.set(delta.index, current)
}
