// ---------------------------------------------------------------------------
// 桌宠 mod — 对话记忆
//
// 没有记忆的桌宠每次说话都像第一次见你；有了它，连续几句对话才有来有回。
//
// 存储形态：
//   · 只存「说过的话」，按时间顺序，最新的在后面
//   · 上限按**条数**和**字符数**双重截断 —— 长句子不该因为条数够就无限增长
//   · 语音和识屏都进同一个历史，因为对用户来说那就是「和桌宠的对话」
//
// 为什么不用宿主的能力：这是桌宠自己的对话，别的工具没有理由读它。
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Turn {
  /** who said it */
  role: 'user' | 'pet'
  text: string
  /** epoch ms */
  at: number
  /** how the turn arrived: typed, spoken, or a screen description */
  source: 'voice' | 'vision' | 'chat'
}

/** Keep this many turns around; roughly a few minutes of conversation. */
const MAX_TURNS = 40
/** …and never more characters than this, so one huge pasted block cannot blow it up. */
const MAX_CHARS = 6000

export class Memory {
  private turns: Turn[] = []

  constructor(
    private readonly dataDir: string,
    /** injected so the summary prompt can reuse the host's AI */
    private readonly chat: (messages: { role: string; content: string }[]) => Promise<{
      ok: boolean
      content: string
      error: string | null
    }>
  ) {}

  private file(): string {
    return join(this.dataDir, 'chat.json')
  }

  load(): void {
    try {
      if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true })
      if (!existsSync(this.file())) return
      const raw = JSON.parse(readFileSync(this.file(), 'utf8')) as { turns?: Turn[] }
      if (Array.isArray(raw.turns)) this.turns = raw.turns.filter(isTurn).slice(-MAX_TURNS)
    } catch {
      // a corrupt history is not worth refusing to boot over
      this.turns = []
    }
  }

  save(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true })
      writeFileSync(this.file(), JSON.stringify({ turns: this.turns }, null, 2), 'utf8')
    } catch {
      /* non-fatal */
    }
  }

  all(): Turn[] {
    return [...this.turns]
  }

  push(turn: Omit<Turn, 'at'>): void {
    this.turns.push({ ...turn, at: Date.now() })
    // drop from the front until both limits hold
    let total = this.turns.reduce((n, t) => n + t.text.length, 0)
    while (this.turns.length > MAX_TURNS || total > MAX_CHARS) {
      if (!this.turns.length) break
      const removed = this.turns.shift()
      total -= removed ? removed.text.length : 0
    }
    this.save()
  }

  clear(): void {
    this.turns = []
    this.save()
  }

  /**
   * The recent past as chat messages.
   *
   * Only the last few turns go to the model: older context makes replies drift and
   * costs tokens on every request. The pet is a desktop companion, not a chatbot that
   * needs the whole transcript.
   */
  contextMessages(limit = 8): { role: 'user' | 'assistant'; content: string }[] {
    return this.turns.slice(-limit).map((t) => ({
      role: t.role === 'pet' ? 'assistant' : 'user',
      content: t.text
    }))
  }

  /**
   * One-line recap of what happened before, used as a system hint.
   *
   * Kept deliberately terse: it costs a token budget on every request, and a paragraph
   * of recap tends to be recited back verbatim instead of answered.
   */
  recap(): string {
    if (this.turns.length === 0) return ''
    const lastUser = [...this.turns].reverse().find((t) => t.role === 'user')
    if (!lastUser) return ''
    return `上一轮用户说的是：「${lastUser.text.slice(0, 60)}」`
  }
}

function isTurn(v: unknown): v is Turn {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return typeof r['text'] === 'string' && (r['role'] === 'user' || r['role'] === 'pet')
}
