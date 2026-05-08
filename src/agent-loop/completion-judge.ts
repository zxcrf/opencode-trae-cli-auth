import type { LanguageModelV2CallOptions } from '@ai-sdk/provider'
import { clipText, collectRecentToolResults, getFirstUserText, listToolNames, parseJsonObjectLenient } from './prompt-utils.js'

export type CompletionJudgeDecision = {
  status: 'complete' | 'incomplete' | 'needs_user'
  reason?: string
  nextExpectation?: 'final_answer' | 'tool_call' | 'clarification'
}

export type StopRetryDecision = {
  shouldRetry: boolean
  retryPrompt?: LanguageModelV2CallOptions
}

export function buildCompletionJudgePrompt(args: {
  options: LanguageModelV2CallOptions
  assistantText: string
}): LanguageModelV2CallOptions {
  const toolNames = listToolNames(args.options.tools)
  const toolResultSummary = collectRecentToolResults(args.options).slice(-3).map((entry) => `${entry.toolName}[${entry.id}]: ${clipText(entry.output, 400)}`).join('\n')
  const userGoal = getFirstUserText(args.options)
  return {
    ...args.options,
    tools: undefined,
    prompt: [
      {
        role: 'system',
        content: [
          'You are a task completion judge for an OpenCode agent loop.',
          'Return strict JSON only.',
          'Schema: {"status":"complete"|"incomplete"|"needs_user","reason":"short explanation","next_expectation":"final_answer"|"tool_call"|"clarification"}',
          'Judge whether assistant_output satisfies user_goal, using recent_tool_results as execution evidence.',
          'Use "complete" only when the assistant output is a user-facing final answer that satisfies the original goal.',
          'Use "incomplete" when the assistant output is a plan, promise, intermediate status, unexecuted next step, or fails to consume tool results.',
          'Use "needs_user" only when progress requires user choice, credentials, permission, or clarification.',
          'For action tasks such as modify, install, upgrade, run, write, or verify, completion requires evidence that the action was executed or a clear explanation of why it cannot be completed.',
          'A tool result by itself is not a final answer unless assistant_output explains the result to the user.',
          'Never request tools. Never explain outside JSON.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [{
          type: 'text',
          text: [
            'completion judge',
            `user_goal:\n${userGoal || '(empty)'}`,
            `assistant_output:\n${args.assistantText || '(empty)'}`,
            `available_tools:\n${toolNames.join(', ') || '(none)'}`,
            `recent_tool_results:\n${toolResultSummary || '(none)'}`,
          ].join('\n\n'),
        }],
      },
    ],
  }
}

export function parseCompletionJudgeDecision(text: string): CompletionJudgeDecision | undefined {
  const parsed = parseJsonObjectLenient(text)
  if (!parsed) return undefined
  const rawStatus = parsed.status ?? parsed.action
  const status = rawStatus === 'stop' ? 'complete' : rawStatus === 'continue' ? 'incomplete' : rawStatus
  if (status !== 'complete' && status !== 'incomplete' && status !== 'needs_user') return undefined
  const rawNextExpectation = parsed.next_expectation ?? parsed.nextExpectation
  const nextExpectation = rawNextExpectation === 'final_answer' || rawNextExpectation === 'tool_call' || rawNextExpectation === 'clarification'
    ? rawNextExpectation
    : undefined
  return {
    status,
    reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    nextExpectation,
  }
}

export function buildJudgeSessionId(sessionId: string | undefined): string {
  const suffix = `judge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return sessionId ? `${sessionId}-${suffix}` : suffix
}

export function shouldRetryStoppedActionTurn(args: {
  options: LanguageModelV2CallOptions
  text: string
  finishReason: 'stop' | 'tool-calls' | 'error'
  sawOutput: boolean
  toolCalls: number
  judgeDecision?: CompletionJudgeDecision
}): StopRetryDecision {
  if (args.finishReason !== 'stop') return { shouldRetry: false }
  if (args.toolCalls > 0) return { shouldRetry: false }
  if (!args.sawOutput || !args.text.trim()) return { shouldRetry: false }
  if (!args.judgeDecision || args.judgeDecision.status !== 'incomplete') return { shouldRetry: false }
  return {
    shouldRetry: true,
    retryPrompt: withStoppedActionRetryPrompt(args.options),
  }
}

export function withStoppedActionRetryPrompt(options: LanguageModelV2CallOptions): LanguageModelV2CallOptions {
  return {
    ...options,
    prompt: [
      {
        role: 'system',
        content: [
          'The completion judge marked your previous response as incomplete for the original OpenCode task.',
          'Retry now.',
          'If the task still needs filesystem, shell, edit, write, glob, grep, read, or task actions, output exactly one concrete <opencode_tool_call> JSON block and no other text.',
          'If enough evidence is already available, answer with the final user-facing result.',
          'If user input is required, ask one concise clarification question.',
        ].join(' '),
      },
      ...(options.prompt ?? []),
    ],
  }
}
