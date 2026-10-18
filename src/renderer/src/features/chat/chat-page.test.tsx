import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, ChatSessionInfo } from '@shared/chat-types'
import { ChatPage } from './chat-page'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }))
const session = { id: '175a1f7f-75bd-47f0-8188-788282755caf', title: 'Chat conversation', createdAt: 1, updatedAt: 2, status: 'idle' as const, model: 'mock/chat' }
let emit: (event: ChatEvent) => void
let invoke: ReturnType<typeof vi.fn>
const original = window.piDesktop
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  invoke = vi.fn(async (channel: string, request?: { id?: string }) => {
    if (channel === 'ipc:chat.list') return { sessions: [session] }
    if (channel === 'ipc:chat.models') return { models: [{ id: 'chat', provider: 'mock', name: 'Chat model' }] }
    if (channel === 'ipc:chat.open') return { session: { ...session, id: request?.id }, messages: [{ id: 'old', role: 'assistant', text: 'Earlier answer' }] }
    if (channel === 'ipc:chat.create') return { session }
    if (channel === 'ipc:chat.send') {
      emit({ kind: 'session', session: { ...session, status: 'running', updatedAt: 3 } })
      emit({ kind: 'messages', id: session.id, messages: [{ id: 'user-1', role: 'user', text: 'Hello' }] })
      return { accepted: true }
    }
    return { ok: true }
  })
  Object.defineProperty(window, 'piDesktop', { configurable: true, writable: true, value: { invoke, onChatEvent: (fn: typeof emit) => { emit = fn; return vi.fn() } } })
})
afterEach(() => { cleanup(); window.piDesktop = original })
describe('isolated Chat product', () => {
  it('creates a Chat session and never calls Code prompt or filesystem APIs', async () => {
    render(<ChatPage onSettings={vi.fn()} />)
    await screen.findByRole('button', { name: 'Chat conversation' })
    fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send Chat message' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ipc:chat.send', { id: session.id, text: 'Hello' }))
    expect(invoke).toHaveBeenCalledWith('ipc:chat.create', { model: 'mock/chat', thinkingLevel: 'off' })
    expect(invoke.mock.calls.every(([channel]) => channel.startsWith('ipc:chat.'))).toBe(true)
    expect(screen.getByRole('button', { name: 'Stop response' })).toBeInTheDocument()
  })
  it('projects streamed replies and authoritative final messages independently', async () => {
    render(<ChatPage onSettings={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Chat conversation' }))
    await screen.findByText('Earlier answer')
    act(() => emit({ kind: 'delta', id: session.id, messageId: 'answer-2', delta: 'Live reply' }))
    expect(screen.getByText('Live reply')).toBeInTheDocument()
    act(() => emit({ kind: 'messages', id: session.id, messages: [{ id: 'answer-2', role: 'assistant', text: 'Final answer', pending: false }] }))
    expect(screen.getByText('Final answer')).toBeInTheDocument()
    expect(screen.queryByText('Live reply')).not.toBeInTheDocument()
  })
  it('reconciles an opening history snapshot with later revisioned stream events', async () => {
    let finishOpen!: (value: unknown) => void
    const base = invoke.getMockImplementation()! as (channel: string, request?: { id?: string }) => Promise<unknown>
    invoke.mockImplementation((channel: string, request?: { id?: string }) => channel === 'ipc:chat.open' ? new Promise((resolve) => { finishOpen = resolve }) : base(channel, request))
    render(<ChatPage onSettings={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Chat conversation' }))
    act(() => emit({ kind: 'delta', id: session.id, messageId: 'stream', delta: ' world', revision: 2 }))
    await act(async () => finishOpen({ session, revision: 1, messages: [{ id: 'earlier', role: 'user', text: 'Earlier question' }, { id: 'stream', role: 'assistant', text: 'Hello', pending: true }] }))
    expect(await screen.findByText('Earlier question')).toBeInTheDocument()
    expect(screen.getByText('Hello world')).toBeInTheDocument()
  })

  it('keeps existing conversations locked to their actual model and allows model choice only for new chats', async () => {
    const base = invoke.getMockImplementation()! as (channel: string, request?: { id?: string }) => Promise<unknown>
    invoke.mockImplementation((channel: string, request?: { id?: string }) => channel === 'ipc:chat.models' ? Promise.resolve({ models: [{ id: 'other', provider: 'mock', name: 'Another model' }] }) : base(channel, request))
    render(<ChatPage onSettings={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'New chat model' })).toHaveTextContent('Another model'))
    fireEvent.click(await screen.findByRole('button', { name: 'Chat conversation' }))
    await screen.findByText('Earlier answer')
    expect(screen.queryByRole('button', { name: 'New chat model' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Locked conversation model')).toHaveTextContent('mock/chat')
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: 'Hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send Chat message' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ipc:chat.create', { model: 'mock/other', thinkingLevel: 'off' }))
  })

  it('sends the new-chat thinking selection and limits choices when changing models without losing the draft', async () => {
    const base = invoke.getMockImplementation()! as (channel: string, request?: { id?: string }) => Promise<unknown>
    invoke.mockImplementation((channel: string, request?: { id?: string }) => channel === 'ipc:chat.models' ? Promise.resolve({ models: [
      { id: 'chat', provider: 'mock', name: 'Reasoning model', reasoning: true, thinkingLevels: ['off', 'low', 'high'] },
      { id: 'plain', provider: 'mock', name: 'Plain model', reasoning: false, thinkingLevels: ['off'] },
    ] }) : base(channel, request))
    render(<ChatPage onSettings={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'New chat model' })).toHaveTextContent('Reasoning model'))
    fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: 'Thinking draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Chat thinking intensity' }))
    fireEvent.click(screen.getByRole('option', { name: 'High' }))
    expect(screen.getByLabelText('Chat message')).toHaveValue('Thinking draft')
    fireEvent.click(screen.getByRole('button', { name: 'New chat model' }))
    fireEvent.click(screen.getByRole('option', { name: 'Plain model plain' }))
    expect(screen.getByRole('button', { name: 'Chat thinking intensity' })).toHaveTextContent('Off')
    fireEvent.click(screen.getByRole('button', { name: 'Chat thinking intensity' }))
    expect(screen.queryByRole('option', { name: 'High' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'New chat model' }))
    fireEvent.click(screen.getByRole('option', { name: 'Reasoning model chat' }))
    fireEvent.click(screen.getByRole('button', { name: 'Chat thinking intensity' }))
    fireEvent.click(screen.getByRole('option', { name: 'High' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send Chat message' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ipc:chat.create', { model: 'mock/chat', thinkingLevel: 'high' }))
  })

  it('displays the restored effective level and changes an idle chat only after server confirmation', async () => {
    let finishChange!: (value: unknown) => void
    const base = invoke.getMockImplementation()! as (channel: string, request?: { id?: string }) => Promise<unknown>
    const restored: ChatSessionInfo = { ...session, thinkingLevel: 'high', effectiveThinkingLevel: 'off', thinkingLevels: ['off', 'low', 'high'] }
    invoke.mockImplementation((channel: string, request?: { id?: string }) => {
      if (channel === 'ipc:chat.open') return Promise.resolve({ session: restored, messages: [] })
      if (channel === 'ipc:chat.setThinking') return new Promise((resolve) => { finishChange = resolve })
      return base(channel, request)
    })
    render(<ChatPage onSettings={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Chat conversation' }))
    const trigger = screen.getByRole('button', { name: 'Chat thinking intensity' })
    await waitFor(() => expect(trigger).not.toBeDisabled())
    expect(trigger).toHaveTextContent('Off')
    fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: 'Keep my draft' } })
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toHaveTextContent('Requested High; SDK restored Off.')
    fireEvent.click(screen.getByRole('option', { name: 'Low' }))
    expect(invoke).toHaveBeenCalledWith('ipc:chat.setThinking', { id: session.id, level: 'low' })
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveTextContent('Off')
    await act(async () => finishChange({ session: { ...restored, thinkingLevel: 'low', effectiveThinkingLevel: 'low', updatedAt: 4 } }))
    expect(trigger).toHaveTextContent('Low')
    expect(screen.getByLabelText('Chat message')).toHaveValue('Keep my draft')
    expect(screen.getByLabelText('Locked conversation model')).toHaveTextContent('Chat model')
    act(() => emit({ kind: 'session', session: { ...restored, effectiveThinkingLevel: 'low', updatedAt: 5, status: 'running' } }))
    expect(trigger).toBeDisabled()
    expect(trigger).toHaveAccessibleDescription(/while a response is running/)
  })

  it('does not show a rejected thinking change as if it had applied', async () => {
    const base = invoke.getMockImplementation()! as (channel: string, request?: { id?: string }) => Promise<unknown>
    invoke.mockImplementation((channel: string, request?: { id?: string }) => {
      if (channel === 'ipc:chat.open') return Promise.resolve({ session: { ...session, effectiveThinkingLevel: 'off', thinkingLevels: ['off', 'high'] }, messages: [] })
      if (channel === 'ipc:chat.setThinking') return Promise.reject(new Error('CHAT_THINKING_UNSUPPORTED'))
      return base(channel, request)
    })
    render(<ChatPage onSettings={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Chat conversation' }))
    const trigger = screen.getByRole('button', { name: 'Chat thinking intensity' })
    await waitFor(() => expect(trigger).not.toBeDisabled())
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('option', { name: 'High' }))
    await screen.findByRole('alert')
    expect(trigger).toHaveTextContent('Off')
    expect(invoke.mock.calls.every(([channel]) => channel.startsWith('ipc:chat.'))).toBe(true)
  })

  it('renders unlabelled flowing assistant prose with pending state, images and no invented tools', async () => {
    render(<ChatPage onSettings={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Chat conversation' }))
    await screen.findByText('Earlier answer')
    act(() => emit({ kind: 'messages', id: session.id, messages: [
      { id: 'user', role: 'user', text: 'Question', images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }] },
      { id: 'assistant', role: 'assistant', text: '# Heading\n\nShared prose with `code`.\n\n- List item', pending: true },
    ] }))
    const assistant = screen.getByRole('article', { name: 'Assistant response' })
    expect(assistant).toHaveAttribute('aria-busy', 'true')
    expect(assistant.querySelector('small')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument()
    expect(assistant.querySelector('code')).toHaveTextContent('code')
    expect(screen.getByRole('img', { name: 'User supplied image' })).toHaveAttribute('src', 'data:image/png;base64,aGVsbG8=')
    expect(screen.queryByText(/Ran .*commands|Read .*files/)).not.toBeInTheDocument()
    act(() => emit({ kind: 'messages', id: session.id, messages: [{ id: 'assistant', role: 'assistant', text: 'Complete', pending: false }] }))
    expect(screen.getByRole('article', { name: 'Assistant response' })).not.toHaveAttribute('aria-busy')
  })

  it('retains conversation draft when navigating between Chat sessions', async () => {
    render(<ChatPage onSettings={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: 'New conversation draft' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Chat conversation' }))
    await screen.findByText('Earlier answer')
    expect(screen.getByLabelText('Chat message')).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(screen.getByLabelText('Chat message')).toHaveValue('New conversation draft')
  })
  it('passes actual image data rather than a local @path to the backend', async () => {
    const { container } = render(<ChatPage onSettings={vi.fn()} />)
    await screen.findByRole('button', { name: 'Chat conversation' })
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' })
    fireEvent.change(container.querySelector('input[type=file]')!, { target: { files: [file] } })
    await screen.findByText('image.png')
    fireEvent.click(screen.getByRole('button', { name: 'Send Chat message' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ipc:chat.send', expect.objectContaining({ images: [{ data: 'iVBORw==', mimeType: 'image/png' }] })))
  })
})
