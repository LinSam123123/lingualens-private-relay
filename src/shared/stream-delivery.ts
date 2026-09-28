export const STREAM_DOM_FLUSH_MS = 32;
export const PAGE_PORT_NAME = 'lingualens-page';

export interface StreamBinding {
  tabId: number;
  frameId: number;
  taskId: string;
  sessionId: string;
  generation: number;
}

export interface StreamItemMessage extends StreamBinding {
  type: 'stream-item';
  batchId: string;
  requestId: string;
  item: { id: string; text: string };
}

export interface PageWriteMessage {
  type: 'page-write';
  taskId: string;
  sessionId: string;
  generation: number;
  batchId: string;
  requestId: string;
}

export interface StreamApplyState {
  taskId: string;
  sessionId: string;
  generation: number;
  closed: boolean;
  translatedIds: ReadonlySet<string>;
  expectedIds: ReadonlySet<string>;
}

function boundedId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
}

export function parseStreamBind(
  message: unknown,
  tabId: number,
  frameId: number,
): StreamBinding | null {
  if (!message || typeof message !== 'object') return null;
  const value = message as Record<string, unknown>;
  if (value.type !== 'bind') return null;
  const taskId = boundedId(value.taskId);
  const sessionId = boundedId(value.sessionId);
  const generation = value.generation;
  if (!taskId || !sessionId || !Number.isInteger(generation) || (generation as number) < 1) return null;
  if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(frameId) || frameId < 0) return null;
  return { tabId, frameId, taskId, sessionId, generation: generation as number };
}

export function sameStreamBinding(
  bound: StreamBinding,
  message: Pick<StreamBinding, 'tabId' | 'frameId' | 'taskId' | 'sessionId' | 'generation'>,
): boolean {
  return bound.tabId === message.tabId
    && bound.frameId === message.frameId
    && bound.taskId === message.taskId
    && bound.sessionId === message.sessionId
    && bound.generation === message.generation;
}

export function decideStreamApply(
  state: StreamApplyState,
  message: StreamItemMessage,
): 'apply' | 'ignore' {
  if (state.closed) return 'ignore';
  if (message.taskId !== state.taskId || message.sessionId !== state.sessionId) return 'ignore';
  if (message.generation !== state.generation) return 'ignore';
  if (!state.expectedIds.has(message.item.id)) return 'ignore';
  if (state.translatedIds.has(message.item.id)) return 'ignore';
  if (typeof message.item.text !== 'string' || !message.item.text.trim()) return 'ignore';
  return 'apply';
}

export function readyDomIds(
  nodes: Array<{ domItemId: string; chunkIds: string[] }>,
  translatedIds: ReadonlySet<string>,
): string[] {
  return nodes
    .filter((node) => node.chunkIds.length > 0 && node.chunkIds.every((id) => translatedIds.has(id)))
    .map((node) => node.domItemId);
}

export function shouldFlushDom(pending: number, elapsedMs: number, force: boolean): boolean {
  if (pending <= 0) return false;
  return force || elapsedMs >= STREAM_DOM_FLUSH_MS;
}

export interface PortLike {
  sender?: {
    id?: string;
    url?: string;
    tab?: { id?: number };
    frameId?: number;
  };
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  postMessage(message: unknown): void;
  disconnect(): void;
}

interface PortEntry {
  port: PortLike;
  binding: StreamBinding | null;
  tabId: number;
  frameId: number;
}

const ports = new Map<string, PortEntry>();
const pageWrites: PageWriteMessage[] = [];
const MAX_PAGE_WRITES = 40;

function portKey(tabId: number, frameId: number): string {
  return `${tabId}:${frameId}`;
}

export function resetPagePortsForTests(): void {
  ports.clear();
  pageWrites.length = 0;
  pageWriteListener = null;
}

export function listPageWrites(): PageWriteMessage[] {
  return pageWrites.map((entry) => ({ ...entry }));
}

let pageWriteListener: ((write: PageWriteMessage, receivedAt: number) => void) | null = null;

export function setPageWriteListener(
  listener: ((write: PageWriteMessage, receivedAt: number) => void) | null,
): void {
  pageWriteListener = listener;
}

function rememberPageWrite(entry: PageWriteMessage): void {
  pageWrites.push(entry);
  if (pageWrites.length > MAX_PAGE_WRITES) pageWrites.splice(0, pageWrites.length - MAX_PAGE_WRITES);
  pageWriteListener?.(entry, Date.now());
}

function senderTab(port: PortLike): { tabId: number; frameId: number } | null {
  const tabId = port.sender?.tab?.id;
  const frameId = port.sender?.frameId ?? 0;
  if (!Number.isInteger(tabId) || (tabId as number) < 0) return null;
  if (!Number.isInteger(frameId) || frameId < 0) return null;
  return { tabId: tabId as number, frameId };
}

function dispatchPortMessage(entry: PortEntry, message: unknown): void {
  const record = message && typeof message === 'object' ? message as Record<string, unknown> : null;
  if (record?.type === 'bind') {
    entry.binding = parseStreamBind(message, entry.tabId, entry.frameId);
    return;
  }
  if (record?.type === 'page-write' && entry.binding) {
    const write = parsePageWrite(message, entry.binding);
    if (write) rememberPageWrite(write);
  }
}

/** Register port listeners immediately. Sender checks run when `extensionReady` resolves. */
export function listenForPagePort(port: PortLike, extensionReady: Promise<string>): void {
  const queued: unknown[] = [];
  let entry: PortEntry | null = null;
  let closed = false;
  port.onMessage.addListener((message) => {
    if (!entry) queued.push(message);
    else dispatchPortMessage(entry, message);
  });
  port.onDisconnect.addListener(() => {
    closed = true;
    if (!entry) return;
    const key = portKey(entry.tabId, entry.frameId);
    if (ports.get(key)?.port === port) ports.delete(key);
  });
  void extensionReady.then((extensionId) => {
    if (closed) return;
    if (port.sender?.id !== extensionId) {
      port.disconnect();
      return;
    }
    const sender = senderTab(port);
    if (!sender) {
      port.disconnect();
      return;
    }
    const key = portKey(sender.tabId, sender.frameId);
    const previous = ports.get(key);
    if (previous && previous.port !== port) previous.port.disconnect();
    entry = { port, binding: null, tabId: sender.tabId, frameId: sender.frameId };
    ports.set(key, entry);
    for (const message of queued) dispatchPortMessage(entry, message);
  }).catch(() => port.disconnect());
}

export function publishStreamItem(message: StreamItemMessage): boolean {
  const entry = ports.get(portKey(message.tabId, message.frameId));
  if (!entry?.binding || !sameStreamBinding(entry.binding, message)) return false;
  if (typeof message.item?.id !== 'string' || typeof message.item.text !== 'string' || !message.item.text.trim()) {
    return false;
  }
  entry.port.postMessage({
    type: 'stream-item',
    taskId: message.taskId,
    sessionId: message.sessionId,
    generation: message.generation,
    batchId: message.batchId,
    requestId: message.requestId,
    item: { id: message.item.id, text: message.item.text },
  });
  return true;
}

export function parsePageWrite(message: unknown, bound: StreamBinding): PageWriteMessage | null {
  if (!message || typeof message !== 'object') return null;
  const value = message as Record<string, unknown>;
  if (value.type !== 'page-write') return null;
  const taskId = boundedId(value.taskId);
  const sessionId = boundedId(value.sessionId);
  const batchId = boundedId(value.batchId);
  const requestId = boundedId(value.requestId);
  const generation = value.generation;
  if (!taskId || !sessionId || !batchId || !requestId) return null;
  if (!Number.isInteger(generation) || generation !== bound.generation) return null;
  if (taskId !== bound.taskId || sessionId !== bound.sessionId) return null;
  return {
    type: 'page-write',
    taskId,
    sessionId,
    generation: generation as number,
    batchId,
    requestId,
  };
}
