import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Check, ChevronRight, Code2, KeyRound, Menu, PanelRightOpen } from 'lucide-react';
import type { AppConfig, AttachedFile, ChatMessage, Conversation, Credentials, ModelInfo, Provider, SearchMode, WorkspaceFile } from './types';
import { CURATED_MODELS, DEFAULT_MODEL } from './lib/models';
import { createDraft, downloadConversation, extractCodeFiles, mergeGeneratedFiles } from './lib/files';
import { hasSavedModel, loadActiveId, loadConversations, loadCredentials, loadModel, loadSearchMode, saveActiveId, saveConversations, saveCredentials, saveModel, saveSearchMode } from './lib/storage';
import { isUsableFreeCatalogModel } from './lib/model-policy.mjs';
import { requestChat } from './lib/chat';
import { buildProviderMessages, executeToolCall, extractToolCalls, formatToolResultMessage, injectWorkspaceSnapshot, MAX_TOOL_ROUNDS, stripToolCalls, type ToolResultMessage } from './lib/tool-use';
import { Brand } from './components/Brand';
import Sidebar from './components/Sidebar';
import ChatPanel from './components/ChatPanel';
import Canvas from './components/Canvas';
import ModelLibrary from './components/ModelLibrary';
import SettingsModal from './components/SettingsModal';

const emptyConfig: AppConfig = { configured: { openrouter: false, gemini: false, groq: false }, ollamaConfigured: false, searchConfigured: false, requiresAccessCode: false, aifluxAvailable: false };

export default function App() {
  const [initial] = useState(() => ({ chats: loadConversations(), activeId: loadActiveId() }));
  const [chats, setChats] = useState<Conversation[]>(initial.chats);
  const [activeId, setActiveId] = useState<string | null>(initial.chats.some((chat) => chat.id === initial.activeId) ? initial.activeId : null);
  const [draftChat, setDraftChat] = useState(createDraft);
  const [view, setView] = useState<'studio' | 'library'>('studio');
  const [selectedModel, setSelectedModel] = useState<ModelInfo>(loadModel);
  const [manualSelection, setManualSelection] = useState(hasSavedModel);
  const [credentials, setCredentials] = useState<Credentials>(loadCredentials);
  const [searchMode, setSearchMode] = useState<SearchMode>(loadSearchMode);
  const [config, setConfig] = useState<AppConfig>(emptyConfig);
  const [liveModels, setLiveModels] = useState<ModelInfo[]>([]);
  const [ollamaModels, setOllamaModels] = useState<ModelInfo[]>([]);
  const [catalogAvailable, setCatalogAvailable] = useState<boolean | null>(null);
  const [sending, setSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsProvider, setSettingsProvider] = useState<Provider | undefined>();
  const [contextFile, setContextFile] = useState<AttachedFile | null>(null);
  const [canvasVisible, setCanvasVisible] = useState(true);
  const [mobileCanvasOpen, setMobileCanvasOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const catalogLoading = useRef(false);
  const catalogLoaded = useRef(false);
  const abortRef = useRef<{ controller: AbortController; chatId: string } | null>(null);
  const storageWarned = useRef(false);
  const chatsRef = useRef(chats);
  chatsRef.current = chats;

  const activeChat = chats.find((chat) => chat.id === activeId) || draftChat;
  const models = useMemo(() => {
    // Once the live catalog is available, do not advertise curated OpenRouter
    // variants that are no longer listed as free.
    const freeModels = liveModels.filter(isUsableFreeCatalogModel);
    const available = new Set(freeModels.map((model) => model.id));
    const curated = CURATED_MODELS.filter((model) => model.provider !== 'openrouter' || catalogAvailable !== true || available.has(model.id));
    const ids = new Set(curated.map((model) => `${model.provider}:${model.id}`));
    return [...curated, ...[...freeModels, ...ollamaModels]
      .filter((model) => !ids.has(`${model.provider}:${model.id}`))];
  }, [catalogAvailable, liveModels, ollamaModels]);

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3800);
  }, []);

  useEffect(() => {
    fetch('/api/config').then((response) => response.json()).then((result: AppConfig) => setConfig(result)).catch(() => notify('Could not load server configuration. Is the server running?'));
  }, [notify]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!saveConversations(chats) && !storageWarned.current) {
        storageWarned.current = true;
        notify('Browser storage is full. Export your work to keep a copy.');
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [chats, notify]);
  useEffect(() => { saveActiveId(activeId); }, [activeId]);
  useEffect(() => {
    const flush = () => { saveConversations(chatsRef.current); };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);
  useEffect(() => {
    const newChatShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'o') {
        event.preventDefault(); newChat();
      }
    };
    window.addEventListener('keydown', newChatShortcut);
    return () => window.removeEventListener('keydown', newChatShortcut);
  });

  const loadModels = useCallback(async (force = false) => {
    if (catalogLoading.current || (!force && catalogLoaded.current)) return;
    catalogLoading.current = true;
    try {
      const response = await fetch('/api/models');
      if (!response.ok) throw new Error('Catalog unavailable');
      const result = await response.json();
      setLiveModels(Array.isArray(result.models) ? result.models : []);
      setOllamaModels(Array.isArray(result.ollamaModels) ? result.ollamaModels : []);
      setCatalogAvailable(Boolean(result.catalogAvailable));
      catalogLoaded.current = Boolean(result.catalogAvailable);
    } catch {
      setCatalogAvailable(false);
      catalogLoaded.current = false;
    } finally { catalogLoading.current = false; }
  }, []);

  const isConnected = useCallback((provider: Provider) => {
    if (provider === 'ollama') return config.ollamaConfigured && ollamaModels.length > 0;
    if (provider === 'aiflux') return config.aifluxAvailable || (['openrouter', 'gemini', 'groq'] as const).some((p) => Boolean(credentials.keys[p] || config.configured[p]));
    return Boolean(credentials.keys[provider] || config.configured[provider]);
  }, [config, credentials, ollamaModels]);
  const anyConnected = (['aiflux', 'openrouter', 'gemini', 'groq', 'ollama'] as Provider[]).some(isConnected);

  useEffect(() => { void loadModels(); }, [loadModels]);
  useEffect(() => {
    if (manualSelection) return;
    const preferred = models.find((model) => isConnected(model.provider)) ?? DEFAULT_MODEL;
    setSelectedModel((current) => current.id === preferred.id && current.provider === preferred.provider ? current : preferred);
  }, [isConnected, manualSelection, models]);
  useEffect(() => {
    if (catalogAvailable !== true || selectedModel.provider !== 'openrouter' ||
        models.some((model) => model.provider === 'openrouter' && model.id === selectedModel.id)) return;
    const next = models.find((model) => isConnected(model.provider)) ?? DEFAULT_MODEL;
    setSelectedModel(next);
    if (manualSelection) {
      saveModel(next);
      notify(`${selectedModel.name} is no longer listed as free. Switched to ${next.name}.`);
    }
  }, [catalogAvailable, isConnected, manualSelection, models, notify, selectedModel]);

  const openSettings = useCallback((provider?: Provider) => {
    setSettingsProvider(provider);
    setSettingsOpen(true);
    setMobileSidebarOpen(false);
  }, []);
  const saveSettings = (next: Credentials) => {
    setCredentials(next);
    saveCredentials(next);
    setSettingsOpen(false);
    notify('Connections saved. Let’s make something.');
  };
  const chooseModel = (model: ModelInfo) => {
    setManualSelection(true);
    setSelectedModel(model);
    saveModel(model);
    if (view === 'library') { setView('studio'); notify(`${model.name} selected`); }
  };
  const cycleSearchMode = () => {
    const next: SearchMode = searchMode === 'off' ? 'auto' : searchMode === 'auto' ? 'always' : 'off';
    setSearchMode(next);
    saveSearchMode(next);
    notify(next === 'auto' ? 'Web search: the AI chooses when to look things up.' : next === 'always' ? 'Web search: search before every answer.' : 'Web search turned off.');
  };
  const changeView = (next: 'studio' | 'library') => {
    setView(next);
    setMobileSidebarOpen(false);
    if (next === 'library') void loadModels();
  };
  const stop = () => { abortRef.current?.controller.abort(); };
  const newChat = () => {
    stop(); setActiveId(null); setDraftChat(createDraft()); setContextFile(null);
    setView('studio'); setMobileSidebarOpen(false); setMobileCanvasOpen(false);
  };
  const selectChat = (id: string) => {
    if (activeId !== id) stop();
    setActiveId(id); setContextFile(null); setView('studio'); setMobileSidebarOpen(false); setMobileCanvasOpen(false);
  };
  const deleteChat = (id: string) => {
    if (!window.confirm('Delete this conversation and its Canvas files? This cannot be undone.')) return;
    if (abortRef.current?.chatId === id) stop();
    setChats((previous) => previous.filter((chat) => chat.id !== id));
    if (activeId === id) { setActiveId(null); setDraftChat(createDraft()); setContextFile(null); }
    notify('Conversation deleted');
  };
  const updateActive = (updater: (chat: Conversation) => Conversation) => {
    if (activeId) setChats((previous) => previous.map((chat) => chat.id === activeId ? updater(chat) : chat));
    else setDraftChat((previous) => updater(previous));
  };
  const patchMessage = (chatId: string, messageId: string, updater: (message: ChatMessage) => ChatMessage) => {
    setChats((previous) => previous.map((chat) => chat.id === chatId ? {
      ...chat, updatedAt: Date.now(), messages: chat.messages.map((message) => message.id === messageId ? updater(message) : message),
    } : chat));
  };

  const sendMessage = (text: string, attachments: AttachedFile[]): boolean => {
    if (sending) return false;
    if (!isConnected(selectedModel.provider)) {
      openSettings(selectedModel.provider);
      notify(selectedModel.provider === 'ollama' ? 'Set up Ollama on the server first.' : `Connect ${selectedModel.provider === 'gemini' ? 'Gemini' : selectedModel.provider === 'groq' ? 'Groq' : 'OpenRouter'} to start chatting.`);
      return false;
    }
    if (config.requiresAccessCode && !credentials.accessCode) { openSettings(); notify('Enter your workspace access code first.'); return false; }
    const now = Date.now();
    const chatId = activeChat.id;
    const initialFiles = activeChat.files;
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: text, createdAt: now, attachments };
    const assistantId = crypto.randomUUID();
    // Toki is the dedicated live-web persona and forces search even when the
    // user left the toggle off. Flux gets normal auto behavior — the server
    // decides turn-by-turn whether current facts matter.
    const forcedSearch = selectedModel.provider === 'aiflux' && selectedModel.id === 'toki';
    const effectiveSearchMode: SearchMode = forcedSearch && searchMode === 'off' ? 'auto' : searchMode;
    const assistantMessage: ChatMessage = { id: assistantId, role: 'assistant', content: '', createdAt: now, status: 'streaming', model: selectedModel.name, toolCalls: [], ...(effectiveSearchMode !== 'off' ? { searchStatus: 'planning' } : {}) };
    const firstPassHistory = buildProviderMessages([...activeChat.messages, userMessage], initialFiles);
    if (firstPassHistory.reduce((sum, message) => sum + message.content.length, 0) > 180_000) { notify('This message is too long. Remove an attachment or shorten it.'); return false; }
    const updated: Conversation = {
      ...activeChat, title: activeChat.messages.length === 0 ? text.replace(/\s+/g, ' ').slice(0, 53) + (text.length > 53 ? '…' : '') : activeChat.title,
      updatedAt: now, messages: [...activeChat.messages, userMessage, assistantMessage],
    };
    if (activeId) setChats((previous) => previous.map((chat) => chat.id === chatId ? updated : chat));
    else { setChats((previous) => [updated, ...previous]); setActiveId(chatId); }
    setSending(true);

    const runTurn = async (params: {
      messages: { role: 'user' | 'assistant'; content: string }[];
      files: WorkspaceFile[];
      selectedFileId: string | null;
      roundsLeft: number;
    }) => {
      const controller = new AbortController();
      abortRef.current = { controller, chatId };
      let responseText = '';
      let actualModel = selectedModel.name;
      let searchDone = false;
      let searchSkipped = false;
      let searchInfo: ChatMessage['search'];
      try {
        await requestChat({
          provider: selectedModel.provider,
          model: selectedModel.id,
          messages: params.messages,
          keys: credentials.keys,
          searchKey: credentials.searchKey,
          // Only run web search on the FIRST assistant turn of a user message;
          // subsequent tool-loop turns should not re-trigger web searches.
          searchMode: params.roundsLeft === MAX_TOOL_ROUNDS ? effectiveSearchMode : 'off',
          accessCode: credentials.accessCode,
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type === 'search') {
              searchDone = true;
              if (event.phase === 'skipped') searchSkipped = true;
              patchMessage(chatId, assistantId, (message) => ({ ...message,
                searchStatus: event.phase === 'skipped' ? undefined : event.phase,
                searchSkipped: event.phase === 'skipped',
                searchQuery: event.phase === 'skipped' ? undefined : event.query,
              }));
            }
            if (event.type === 'sources') {
              searchInfo = { query: event.query, sources: event.sources };
              patchMessage(chatId, assistantId, (message) => ({ ...message, searchStatus: undefined, searchQuery: undefined, search: searchInfo }));
            }
            if (event.type === 'delta') {
              responseText += event.text;
              // Strip any <af-tool> blocks (complete or partial/truncated) so
              // the user never sees raw XML while streaming or after a cut-off
              // (rate-limit, timeout, abort).
              const visible = stripToolCalls(responseText);
              patchMessage(chatId, assistantId, (message) => ({ ...message, content: visible, status: 'streaming' }));
            }
            if (event.type === 'model' && event.model) {
              actualModel = event.model.split('/').at(-1)?.replace(':free', '') || event.model;
              patchMessage(chatId, assistantId, (message) => ({ ...message, model: actualModel }));
            }
          },
        });
      } catch (error) {
        const aborted = controller.signal.aborted;
        const message = error instanceof Error ? error.message : 'Something went wrong.';
        // If the response was cut off mid tool-call (rate limit, provider abort,
        // timeout), show whatever prose we already received plus a gentle note
        // rather than a wall of raw XML.
        const visible = stripToolCalls(responseText || '').trim();
        const midTool = /<(?:af-tool|list_files|read_file|write_file|create_file|edit_file|delete_file|view_preview)\b/i.test(responseText || '')
                     || /&lt;(?:af-tool|list_files|read_file|write_file|create_file|edit_file|delete_file|view_preview)\b/i.test(responseText || '');
        if (visible || midTool) {
          patchMessage(chatId, assistantId, (previous) => ({
            ...previous,
            content: visible + (visible && midTool ? '\n\n' : '') + (midTool ? '⚠️ *The AI was interrupted while working on the Canvas. Try sending the request again to finish the edit.*' : ''),
            status: 'error', searchStatus: undefined, searchQuery: undefined,
          }));
          if (midTool) notify('The AI was interrupted mid-edit. The Canvas may be only partially updated — try again to finish.');
        } else {
          patchMessage(chatId, assistantId, (previous) => ({
            ...previous, content: previous.content || (aborted ? 'Generation stopped.' : `**Could not generate a response.** ${message}`),
            status: 'error', searchStatus: undefined, searchQuery: undefined,
          }));
          if (!aborted) notify(message);
        }
        return;
      }

      // Parse and execute any <af-tool> calls the model emitted.
      const calls = extractToolCalls(responseText);
      if (calls.length && params.roundsLeft > 0) {
        // Record the tool calls on the assistant message for UI display.
        let workingFiles = params.files;
        let workingSelected = params.selectedFileId;
        const recordedCalls: NonNullable<ChatMessage['toolCalls']> = [];
        const toolResults: ToolResultMessage[] = [];
        patchMessage(chatId, assistantId, (message) => ({
          ...message, content: stripToolCalls(responseText),
          status: 'tooling', model: actualModel, toolCalls: [...(message.toolCalls || [])],
        }));
        for (const call of calls) {
          const result = executeToolCall(call, { files: workingFiles, selectedFileId: workingSelected });
          if (result.files) workingFiles = result.files;
          if ('selectedFileId' in result && result.selectedFileId !== undefined) workingSelected = result.selectedFileId;
          recordedCalls.push({ id: call.id, name: call.name, args: call.args, ok: result.ok, note: result.ok ? result.output.split('\n')[0] : result.output });
          toolResults.push(formatToolResultMessage(result));
        }
        // Persist file changes to the chat so the user sees them immediately.
        setChats((previous) => previous.map((chat) => {
          if (chat.id !== chatId) return chat;
          return { ...chat, updatedAt: Date.now(), files: workingFiles, selectedFileId: workingSelected,
            messages: chat.messages.map((message) => message.id === assistantId
              ? { ...message, content: stripToolCalls(responseText), status: 'tooling', model: actualModel,
                  searchStatus: undefined, searchQuery: undefined, ...(searchInfo ? { search: searchInfo } : searchDone ? { searchSkipped } : {}),
                  toolCalls: [...(message.toolCalls || []), ...recordedCalls] }
              : message),
          };
        }));
        // Append tool-result messages and recurse. We append them after the
        // assistant message so they feed into the next model call but do not
        // render as user-visible bubbles.
        const assistantHistoryEntry: { role: 'assistant'; content: string } = { role: 'assistant', content: responseText };
        const nextMessagesBase = [...params.messages, assistantHistoryEntry];
        // Append tool results as user-role messages (one per call) so the model
        // can correlate by id. Then tack on the workspace snapshot on the last.
        let nextMessages: { role: 'user' | 'assistant'; content: string }[] = nextMessagesBase;
        for (const result of toolResults) nextMessages = [...nextMessages, { role: 'user', content: result.content }];
        // Re-inject the workspace snapshot so it reflects post-tool state.
        nextMessages = injectWorkspaceSnapshot(nextMessages, workingFiles);
        return runTurn({ messages: nextMessages, files: workingFiles, selectedFileId: workingSelected, roundsLeft: params.roundsLeft - 1 });
      }

      // Final turn: no more tool calls. Persist files (legacy code-block
      // extraction still applies to non-tool answers) and finalize.
      const finalText = stripToolCalls(responseText);
      setChats((previous) => previous.map((chat) => {
        if (chat.id !== chatId) return chat;
        // Merge any legacy fenced-code files (e.g. older providers / fallback answers).
        const generated = extractCodeFiles(finalText, params.files);
        const files = mergeGeneratedFiles(params.files, generated);
        return {
          ...chat, updatedAt: Date.now(), files,
          selectedFileId: generated[0]?.id || params.selectedFileId,
          messages: chat.messages.map((message) => message.id === assistantId
            ? { ...message, content: finalText, status: 'done', model: actualModel,
                searchStatus: undefined, searchQuery: undefined,
                ...(searchInfo ? { search: searchInfo } : searchDone ? { searchSkipped } : {}) }
            : message),
        };
      }));
      const legacyCount = extractCodeFiles(finalText, params.files).length;
      if (legacyCount) notify(`${legacyCount} ${legacyCount === 1 ? 'file' : 'files'} added to Canvas`);
    };

    runTurn({
      messages: firstPassHistory,
      files: initialFiles,
      selectedFileId: activeChat.selectedFileId,
      roundsLeft: MAX_TOOL_ROUNDS,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Something went wrong running tools.';
      patchMessage(chatId, assistantId, (previous) => ({ ...previous, status: 'error', content: previous.content || `**Could not finish.** ${message}` }));
      notify(message);
    }).finally(() => {
      if (abortRef.current?.chatId === chatId) { abortRef.current = null; setSending(false); }
    });
    return true;
  };

  const selectFile = (id: string) => updateActive((chat) => ({ ...chat, selectedFileId: id }));
  const updateFile = (id: string, content: string) => updateActive((chat) => ({ ...chat, updatedAt: Date.now(), files: chat.files.map((file) => file.id === id ? { ...file, content, origin: 'user' } : file) }));
  const createFile = (name: string, content = '') => {
    const file: WorkspaceFile = { id: crypto.randomUUID(), name, content, origin: 'user' };
    updateActive((chat) => ({ ...chat, updatedAt: Date.now(), files: [...chat.files, file], selectedFileId: file.id }));
    notify(`${name} added to Canvas`);
  };
  const deleteFile = (id: string) => {
    updateActive((chat) => {
      const files = chat.files.filter((file) => file.id !== id);
      return { ...chat, updatedAt: Date.now(), files, selectedFileId: chat.selectedFileId === id ? files[0]?.id || null : chat.selectedFileId };
    });
    notify('File deleted');
  };
  const addContext = (file: WorkspaceFile) => {
    setContextFile({ name: file.name, content: file.content.slice(0, 30_000) });
    if (file.content.length > 30_000) notify('The first 30 KB of this file was added to your next message.');
    else notify(`${file.name} attached to your next message`);
    setMobileCanvasOpen(false);
    setView('studio');
  };
  const openSnippet = (content: string, info: string) => {
    const existing = activeChat.files.find((file) => file.content.trim() === content.trim());
    if (existing) selectFile(existing.id);
    else {
      const generated = extractCodeFiles(`\`\`\`${info}\n${content}\n\`\`\``, activeChat.files);
      if (generated.length) updateActive((chat) => ({ ...chat, files: mergeGeneratedFiles(chat.files, generated), selectedFileId: generated[0].id, updatedAt: Date.now() }));
    }
    setView('studio');
    setCanvasVisible(true);
    if (window.matchMedia('(max-width: 1100px)').matches) setMobileCanvasOpen(true);
  };
  const toggleCanvas = () => {
    if (window.matchMedia('(max-width: 1100px)').matches) setMobileCanvasOpen(true);
    else setCanvasVisible((visible) => !visible);
  };
  const closeCanvas = () => {
    if (window.matchMedia('(max-width: 1100px)').matches) setMobileCanvasOpen(false);
    else setCanvasVisible(false);
  };

  return <div className={`app-shell ${canvasVisible ? '' : 'canvas-is-hidden'}`}>
    {mobileSidebarOpen && <button className="mobile-scrim" aria-label="Close menu" onClick={() => setMobileSidebarOpen(false)} />}
    <Sidebar chats={chats} activeId={activeId} view={view} connected={anyConnected} mobileOpen={mobileSidebarOpen} onCloseMobile={() => setMobileSidebarOpen(false)} onNew={newChat} onSelect={selectChat} onDelete={deleteChat} onView={changeView} onSettings={() => openSettings()} />
    <main className="main-column">
      <header className="topbar"><div className="topbar-left"><button className="icon-button mobile-menu-button" onClick={() => setMobileSidebarOpen(true)} aria-label="Open menu"><Menu size={21} /></button><span className="mobile-brand"><Brand /></span><div className="topbar-breadcrumb"><span>Workspace</span><ChevronRight size={15} /><strong>{view === 'library' ? 'Model library' : activeChat.messages.length ? activeChat.title : 'New conversation'}</strong></div></div><div className="topbar-actions"><button className={`topbar-connection ${anyConnected ? 'connected' : ''}`} onClick={() => openSettings()} title={anyConnected ? 'Manage AI connections' : 'Connect an AI model'} aria-label={anyConnected ? 'Manage AI connections' : 'Connect an AI model'}><span className="topbar-connection-dot" /> <span>{anyConnected ? 'Models connected' : 'Connect a model'}</span><KeyRound size={14} /></button>{view === 'studio' && activeChat.messages.length > 0 && <button className="topbar-action-button export-button" onClick={() => downloadConversation(activeChat)} title="Export conversation as Markdown"><ArrowDownToLine size={17} /><span>Export</span></button>}<span className="topbar-divider" /><button className={`topbar-canvas-button ${canvasVisible ? 'is-open' : ''}`} onClick={toggleCanvas}><Code2 size={17} /><span>Canvas</span>{!canvasVisible ? <PanelRightOpen size={15} /> : <span className="canvas-button-spark">✳</span>}</button><button className="topbar-avatar" onClick={() => openSettings()} aria-label="Open settings">AF</button></div></header>
      {view === 'studio' ? <ChatPanel conversation={activeChat} selectedModel={selectedModel || DEFAULT_MODEL} models={models}
        catalogAvailable={catalogAvailable} connected={anyConnected} sending={sending} contextFile={contextFile}
        searchMode={searchMode} onCycleSearchMode={cycleSearchMode} isConnected={isConnected} onSend={sendMessage}
        onStop={stop} onSelectModel={chooseModel} onLoadModels={() => void loadModels()}
        onLibrary={() => changeView('library')} onOpenSnippet={openSnippet} onClearContext={() => setContextFile(null)}
        onNotify={notify} onSettings={() => openSettings()} />
        : <ModelLibrary models={models} selected={selectedModel} catalogAvailable={catalogAvailable} isConnected={isConnected} onSelect={chooseModel} onSettings={openSettings} onRefresh={() => void loadModels(true)} />}
    </main>
    {(canvasVisible || mobileCanvasOpen) && <Canvas conversation={activeChat} mobileOpen={mobileCanvasOpen} onClose={closeCanvas} onSelectFile={selectFile} onUpdateFile={updateFile} onCreateFile={createFile} onDeleteFile={deleteFile} onAddContext={addContext} onNotify={notify} />}
    {mobileCanvasOpen && <button className="canvas-mobile-scrim" aria-label="Close Canvas" onClick={() => setMobileCanvasOpen(false)} />}
    {settingsOpen && <SettingsModal credentials={credentials} config={config} focusProvider={settingsProvider} onSave={saveSettings} onClose={() => setSettingsOpen(false)} />}
    {toast && <div className="toast" role="status"><span><Check size={15} /></span>{toast}</div>}
  </div>;
}
