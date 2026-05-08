export type TraeProviderOptions = {
  allowCliFallback?: boolean
  cliPath?: string
  pat?: string
  traeRawBaseURL?: string
  traeRawApiKey?: string
  traeRawHeaders?: Record<string, string>
  traeRawConfigName?: string
  traeRawModelName?: string
  openaiBaseURL?: string
  openaiApiKey?: string
  openaiHeaders?: Record<string, string>
  modelName?: string
  modelAliases?: Record<string, string>
  enableToolCalling?: boolean
  queryTimeout?: number
  includeToolHistory?: boolean
  maxPromptMessages?: number
  maxPromptChars?: number
  maxToolPayloadChars?: number
  codingSystemPreamble?: string
  injectCodingSystemPrompt?: boolean
  extraArgs?: string[]
  enforceTextOnly?: boolean
  maxRetries?: number
  retryDelayMs?: number
  sessionId?: string
}
