import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Check, ChevronRight, Code2, KeyRound, Menu, PanelRightOpen } from 'lucide-react';
import type { AppConfig, AttachedFile, ChatMessage, Conversation, Credentials, KeyProvider, ModelInfo, Provider, SearchMode, WorkspaceFile } from './types';
import { CURATED_MODELS, DEFAULT_MODEL, PROVIDERS, recommendedModelForProvider } from './lib/models';
import { applyWorkspaceOperations, buildCanvasContext, createDraft, downloadConversation, expandFolderPaths, extractCodeFiles, extractWorkspaceOperations, filterWorkspaceOperationsForRequest, inferFolderPaths, MAX_CANVAS_CONTEXT_CHARS, mergeGeneratedFiles, normalizeWorkspaceOperationOutput, requestsCanvasEdit, requestsCanvasMutation, toProviderMessages } from './lib/files';
import { hasSavedModel, loadActiveId, loadConversations, loadCredentials, loadModel, loadSearchMode, saveActiveId, saveConversations, saveCredentials, saveModel, saveSearchMode } from './lib/storage';
import { isUsableFreeCatalogModel } from './lib/model-policy.mjs';
import { requestChat } from './lib/chat';
import { Brand } from './components/Brand';
import Sidebar from './components/Sidebar';
import ChatPanel from './components/ChatPanel';
import Canvas from './components/Canvas';
import ModelLibrary from './components/ModelLibrary';
import SettingsModal from './components/SettingsModal';
import GitHubContextModal from './components/GitHubContextModal';
import GitHubPublishModal from './components/GitHubPublishModal';

const emptyConfig: AppConfig = { configured: { openrouter: false, xkiro: false, gemini: false, groq: false }, ollamaConfigured: false, searchConfigured: false, requiresAccessCode: false };
type DiscoverableProvider = 'gemini' | 'groq';
type DiscoveryStatus = 'idle' | 'loading' | 'ready' | 'error';

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
  const [providerModels, setProviderModels] = useState<Record<DiscoverableProvider, ModelInfo[]>>({ gemini: [], groq: [] });
  const [providerDiscovery, setProviderDiscovery] = useState<Record<DiscoverableProvider, DiscoveryStatus>>({ gemini: 'idle', groq: 'idle' });
  const [xkiroModels, setXkiroModels] = useState<ModelInfo[]>([]);
  const [ollamaModels, setOllamaModels] = useState<ModelInfo[]>([]);
  const [catalogAvailable, setCatalogAvailable] = useState<boolean | null>(null);
  const [xkiroCatalogAvailable, setXkiroCatalogAvailable] = useState<boolean | null>(null);
  const [sending, setSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const [githubPublishOpen, setGithubPublishOpen] = useState(false);
  const [settingsProvider, setSettingsProvider] = useState<Provider | undefined>();
  const [contextFile, setContextFile] = useState<AttachedFile | null>(null);
  const [canvasVisible, setCanvasVisible] = useState(true);
  const [mobileCanvasOpen, setMobileCanvasOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const catalogLoading = useRef(false);
  const catalogLoaded = useRef(false);
  const pendingAutoSelectProvider = useRef<KeyProvider | null>(null);
  const providerDiscoveryIdentity = useRef<Record<DiscoverableProvider, string>>({ gemini: '', groq: '' });
  const providerDiscoveryVersion = useRef<Record<DiscoverableProvider, number>>({ gemini: 0, groq: 0 });
  const abortRef = useRef<{ controller: AbortController; chatId: string } | null>(null);
  const storageWarned = useRef(false);
  const chatsRef = useRef(chats);
  chatsRef.current = chats;

  const activeChat = chats.find((chat) => chat.id === activeId) || draftChat;
  const models = useMemo(() => {
    const freeModels = liveModels.filter(isUsableFreeCatalogModel);
    const availableOpenRouter = new Set(freeModels.map((model) => model.id));
    const dynamicModels = [...providerModels.gemini, ...providerModels.groq];
    const dynamicById = new Map(dynamicModels.map((model) => [`${model.provider}:${model.id}`, model]));
    const curated = CURATED_MODELS
      .filter((model) => {
        if (model.provider === 'openrouter' && catalogAvailable === true && !availableOpenRouter.has(model.id)) return false;
        if ((model.provider === 'gemini' || model.provider === 'groq') && providerDiscovery[model.provider] === 'ready') {
          return dynamicById.has(`${model.provider}:${model.id}`);
        }
        return true;
      })
      .map((model) => dynamicById.get(`${model.provider}:${model.id}`) || model);
    const ids = new Set(curated.map((model) => `${model.provider}:${model.id}`));
    return [...curated, ...[...dynamicModels, ...freeModels, ...xkiroModels, ...ollamaModels]
      .filter((model) => !ids.has(`${model.provider}:${model.id}`))];
  }, [catalogAvailable, liveModels, ollamaModels, providerDiscovery, providerModels, xkiroModels]);
  const freeCatalogAvailable = catalogAvailable === true || xkiroCatalogAvailable === true
    ? true
    : catalogAvailable === false && xkiroCatalogAvailable === false ? false : null;

  const notify = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3800);
  }, []);
  const discoverProviderModels = useCallback(async (provider: DiscoverableProvider, key = '', force = false) => {
    const identity = key ? `user:${key}` : 'workspace';
    if (!force && providerDiscoveryIdentity.current[provider] === identity) return;
    providerDiscoveryIdentity.current[provider] = identity;
    const version = ++providerDiscoveryVersion.current[provider];
    setProviderDiscovery((previous) => ({ ...previous, [provider]: 'loading' }));
    setProviderModels((previous) => ({ ...previous, [provider]: [] }));
    try {
      const response = await fetch('/api/models/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, key }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'Model discovery failed.');
      if (version !== providerDiscoveryVersion.current[provider]) return;
      const discovered = Array.isArray(result.models) ? result.models as ModelInfo[] : [];
      setProviderModels((previous) => ({ ...previous, [provider]: discovered }));
      setProviderDiscovery((previous) => ({ ...previous, [provider]: 'ready' }));
    } catch {
      if (version !== providerDiscoveryVersion.current[provider]) return;
      setProviderModels((previous) => ({ ...previous, [provider]: [] }));
      setProviderDiscovery((previous) => ({ ...previous, [provider]: 'error' }));
    }
  }, []);
  const autoSelectProvider = useCallback((provider: KeyProvider) => {
    if ((provider === 'gemini' || provider === 'groq') && providerDiscovery[provider] !== 'ready') {
      pendingAutoSelectProvider.current = provider;
      return undefined;
    }
    if (provider === 'xkiro' && xkiroCatalogAvailable === null) {
      pendingAutoSelectProvider.current = provider;
      return undefined;
    }
    const model = recommendedModelForProvider(provider, models);
    if (!model) return undefined;
    pendingAutoSelectProvider.current = null;
    setManualSelection(true);
    setSelectedModel(model);
    saveModel(model);
    return model;
  }, [models, providerDiscovery, xkiroCatalogAvailable]);
  useEffect(() => {
    const provider = pendingAutoSelectProvider.current;
    if (!provider || !credentials.autoSelectOnConnect) return;
    if ((provider === 'gemini' || provider === 'groq') && providerDiscovery[provider] === 'error') {
      pendingAutoSelectProvider.current = null;
      notify(`${PROVIDERS[provider].name} key saved, but model discovery failed. Check the key, then choose or refresh models.`);
      return;
    }
    if (provider === 'xkiro' && xkiroCatalogAvailable === false) {
      pendingAutoSelectProvider.current = null;
      notify('xKiro key saved, but its free model catalog is unavailable. Refresh or choose another provider.');
      return;
    }
    const model = autoSelectProvider(provider);
    if (model) notify(`Connected ${PROVIDERS[provider].name}; selected ${model.name}.`);
    else if ((provider === 'gemini' || provider === 'groq') && providerDiscovery[provider] === 'ready') {
      pendingAutoSelectProvider.current = null;
      notify(`${PROVIDERS[provider].name} models were discovered. Only models with known free-tier picks are auto-selected; review pricing before choosing others.`);
    } else if (provider === 'xkiro' && xkiroCatalogAvailable === true) {
      pendingAutoSelectProvider.current = null;
      notify('xKiro connected, but no recommended free model was found in its current catalog.');
    }
  }, [autoSelectProvider, credentials.autoSelectOnConnect, notify, providerDiscovery, xkiroCatalogAvailable]);

  useEffect(() => {
    fetch('/api/config').then((response) => response.json()).then((result: AppConfig) => setConfig(result)).catch(() => notify('Could not load server configuration. Is the server running?'));
  }, [notify]);
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get('github');
    if (!result) return;
    url.searchParams.delete('github');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    if (result === 'connected') { setGithubOpen(true); notify('GitHub connected. Browse context or publish reviewed Canvas files.'); }
    else if (result === 'cancelled') notify('GitHub sign-in was cancelled.');
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
      setXkiroModels(Array.isArray(result.xkiroModels) ? result.xkiroModels : []);
      setOllamaModels(Array.isArray(result.ollamaModels) ? result.ollamaModels : []);
      setCatalogAvailable(Boolean(result.catalogAvailable));
      setXkiroCatalogAvailable(Boolean(result.xkiroCatalogAvailable));
      catalogLoaded.current = Boolean(result.catalogAvailable || result.xkiroCatalogAvailable);
    } catch {
      setCatalogAvailable(false);
      setXkiroCatalogAvailable(false);
      catalogLoaded.current = false;
    } finally { catalogLoading.current = false; }
  }, []);

  const isConnected = useCallback((provider: Provider) => {
    if (provider === 'ollama') return config.ollamaConfigured && ollamaModels.length > 0;
    return Boolean(credentials.keys[provider] || config.configured[provider]);
  }, [config, credentials, ollamaModels]);
  const anyConnected = (['openrouter', 'xkiro', 'gemini', 'groq', 'ollama'] as Provider[]).some(isConnected);

  useEffect(() => { void loadModels(); }, [loadModels]);
  useEffect(() => {
    for (const provider of ['gemini', 'groq'] as DiscoverableProvider[]) {
      const key = credentials.keys[provider];
      if (key || config.configured[provider]) void discoverProviderModels(provider, key);
      else if (providerDiscoveryIdentity.current[provider]) {
        providerDiscoveryIdentity.current[provider] = '';
        providerDiscoveryVersion.current[provider] += 1;
        setProviderModels((previous) => ({ ...previous, [provider]: [] }));
        setProviderDiscovery((previous) => ({ ...previous, [provider]: 'idle' }));
      }
    }
  }, [config.configured.gemini, config.configured.groq, credentials.keys.gemini, credentials.keys.groq, discoverProviderModels]);
  useEffect(() => {
    if (manualSelection || !credentials.autoSelectOnConnect) return;
    const provider = (['xkiro', 'openrouter', 'gemini', 'groq', 'ollama'] as Provider[]).find(isConnected);
    if (!provider) return;
    if ((provider === 'gemini' || provider === 'groq') && providerDiscovery[provider] !== 'ready') return;
    if (provider === 'xkiro' && xkiroCatalogAvailable === null) return;
    const preferred = recommendedModelForProvider(provider, models);
    if (!preferred) return;
    setSelectedModel((current) => current.id === preferred.id && current.provider === preferred.provider ? current : preferred);
  }, [credentials.autoSelectOnConnect, isConnected, manualSelection, models, providerDiscovery, xkiroCatalogAvailable]);
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
  useEffect(() => {
    if (xkiroCatalogAvailable !== true || selectedModel.provider !== 'xkiro' ||
        models.some((model) => model.provider === 'xkiro' && model.id === selectedModel.id)) return;
    const next = models.find((model) => isConnected(model.provider)) ?? DEFAULT_MODEL;
    setSelectedModel(next);
    if (manualSelection) {
      saveModel(next);
      notify(`${selectedModel.name} is no longer listed as free. Switched to ${next.name}.`);
    }
  }, [isConnected, manualSelection, models, notify, selectedModel, xkiroCatalogAvailable]);

  const openSettings = useCallback((provider?: Provider) => {
    setSettingsProvider(provider);
    setSettingsOpen(true);
    setMobileSidebarOpen(false);
  }, []);
  const saveSettings = (next: Credentials) => {
    const newKeys = (Object.keys(next.keys) as KeyProvider[]).filter((provider) => !credentials.keys[provider] && Boolean(next.keys[provider]));
    const providerToSelect = settingsProvider && newKeys.includes(settingsProvider as KeyProvider)
      ? settingsProvider as KeyProvider
      : newKeys[0];
    setCredentials(next);
    saveCredentials(next);
    setSettingsOpen(false);
    if (providerToSelect === 'openrouter' || providerToSelect === 'xkiro') void loadModels(true);
    if (next.autoSelectOnConnect && providerToSelect) {
      if (providerToSelect === 'gemini' || providerToSelect === 'groq') {
        pendingAutoSelectProvider.current = providerToSelect;
        notify(`${PROVIDERS[providerToSelect].name} key saved. Discovering the models available to it…`);
      } else {
        const model = autoSelectProvider(providerToSelect);
        notify(model
          ? `Connected ${PROVIDERS[providerToSelect].name}; selected ${model.name}.`
          : providerToSelect === 'xkiro' && xkiroCatalogAvailable === null
            ? `${PROVIDERS[providerToSelect].name} key saved. Its model catalog is still loading.`
            : `${PROVIDERS[providerToSelect].name} key saved. No recommended model is available yet.`);
      }
    } else notify('Connections saved. Let’s make something.');
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
    notify(next === 'auto' ? 'Web search: the AI chooses when to look things up.' : next === 'always' ? 'Web search: search for useful queries; greetings are skipped.' : 'Web search turned off.');
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
      notify(selectedModel.provider === 'ollama' ? 'Set up Ollama on the server first.' : `Connect ${PROVIDERS[selectedModel.provider].name} to start chatting.`);
      return false;
    }
    if (config.requiresAccessCode && !credentials.accessCode) { openSettings(); notify('Enter your workspace access code first.'); return false; }
    const now = Date.now();
    const chatId = activeChat.id;
    const userRequestText = text;
    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: userRequestText, createdAt: now, attachments };
    const canvasMutationRequested = requestsCanvasMutation(userRequestText);
    const canvasEditRequested = requestsCanvasEdit(userRequestText);
    const attachmentChars = attachments.reduce((total, file) => total + file.content.length, 0);
    const canvasBudget = Math.max(1_000, Math.min(MAX_CANVAS_CONTEXT_CHARS, 155_000 - text.length - attachmentChars - attachments.length * 200));
    const canvasContext = buildCanvasContext(activeChat.files, activeChat.folders || [], activeChat.selectedFileId, canvasBudget);
    const assistantId = crypto.randomUUID();
    const assistantMessage: ChatMessage = { id: assistantId, role: 'assistant', content: '', createdAt: now, status: 'streaming', model: selectedModel.name };
    const history = toProviderMessages([...activeChat.messages, userMessage], canvasContext.text);
    if (canvasContext.truncatedFiles.length || canvasContext.manifestTruncated) {
      const omitted = canvasContext.truncatedFiles.slice(0, 4).join(', ');
      const contentNote = canvasContext.truncatedFiles.length
        ? `full contents sent for ${canvasContext.editableFiles.length}/${activeChat.files.length} files; some were truncated or omitted (${omitted}${canvasContext.truncatedFiles.length > 4 ? ', …' : ''})`
        : 'some file or folder paths were omitted from the oversized manifest';
      notify(`Canvas context limit: ${contentNote}.`);
    }
    if (history.reduce((sum, message) => sum + message.content.length, 0) > 180_000) { notify('This message is too long. Remove an attachment or shorten it.'); return false; }
    const updated: Conversation = {
      ...activeChat, title: activeChat.messages.length === 0 ? text.replace(/\s+/g, ' ').slice(0, 53) + (text.length > 53 ? '…' : '') : activeChat.title,
      updatedAt: now, messages: [...activeChat.messages, userMessage, assistantMessage],
    };
    if (activeId) setChats((previous) => previous.map((chat) => chat.id === chatId ? updated : chat));
    else { setChats((previous) => [updated, ...previous]); setActiveId(chatId); }
    setSending(true);
    const controller = new AbortController();
    abortRef.current = { controller, chatId };
    let responseText = '';
    let actualModel = selectedModel.name;
    void requestChat({
      provider: selectedModel.provider,
      model: selectedModel.id,
      messages: history,
      searchQuestion: userRequestText,
      key: selectedModel.provider !== 'ollama' ? credentials.keys[selectedModel.provider] : '',
      searchKey: credentials.searchKey,
      searchMode,
      accessCode: credentials.accessCode,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'search') {
          patchMessage(chatId, assistantId, (message) => ({ ...message,
            searchStatus: event.phase === 'skipped' ? undefined : event.phase,
            searchSkipped: event.phase === 'skipped',
            searchQuery: event.query,
          }));
        }
        if (event.type === 'sources') {
          patchMessage(chatId, assistantId, (message) => ({ ...message, searchStatus: undefined, searchQuery: undefined,
            search: { query: event.query, sources: event.sources } }));
        }
        if (event.type === 'delta') {
          responseText += event.text;
          patchMessage(chatId, assistantId, (message) => ({ ...message, content: message.content + event.text }));
        }
        if (event.type === 'model' && event.model) {
          actualModel = event.model.split('/').at(-1)?.replace(':free', '') || event.model;
          patchMessage(chatId, assistantId, (message) => ({ ...message, model: actualModel }));
        }
      },
    }).then(() => {
      const rawText = responseText;
      const editableTargetMap = new Map((canvasMutationRequested ? canvasContext.editableFiles : []).map((target) => [target.id, target]));
      for (const attachment of userMessage.attachments || []) {
        if (canvasMutationRequested && attachment.canvasFileId && !editableTargetMap.has(attachment.canvasFileId)) {
          editableTargetMap.set(attachment.canvasFileId, { id: attachment.canvasFileId, name: attachment.name, content: attachment.content });
        }
      }
      const editableTargets = [...editableTargetMap.values()];
      const workspaceOperations = filterWorkspaceOperationsForRequest(extractWorkspaceOperations(rawText), userRequestText);
      const text = normalizeWorkspaceOperationOutput(rawText, workspaceOperations);
      const latestConversation = chatsRef.current.find((chat) => chat.id === chatId) || updated;
      const latestGenerated = extractCodeFiles(text, latestConversation.files, editableTargets, canvasMutationRequested, canvasEditRequested);
      const latestMerged = mergeGeneratedFiles(latestConversation.files, latestGenerated);
      const latestMutation = applyWorkspaceOperations(
        latestMerged, latestConversation.folders || [], latestConversation.deletedFiles || [], latestConversation.deletedFolders || [], workspaceOperations,
      );
      setContextFile((current) => {
        if (!current?.canvasFileId) return current;
        const refreshed = latestMutation.files.find((file) => file.id === current.canvasFileId);
        return refreshed ? { ...current, name: refreshed.name, content: refreshed.content } : null;
      });
      const count = latestGenerated.length;
      setChats((previous) => previous.map((chat) => {
        if (chat.id !== chatId) return chat;
        const generated = extractCodeFiles(text, chat.files, editableTargets, canvasMutationRequested, canvasEditRequested);
        const merged = mergeGeneratedFiles(chat.files, generated);
        const mutation = applyWorkspaceOperations(merged, chat.folders || [], chat.deletedFiles || [], chat.deletedFolders || [], workspaceOperations);
        const selectedFileId = generated[0] && mutation.files.some((file) => file.id === generated[0].id)
          ? generated[0].id
          : mutation.files.some((file) => file.id === chat.selectedFileId) ? chat.selectedFileId : mutation.files[0]?.id || null;
        return {
          ...chat, updatedAt: Date.now(), files: mutation.files, folders: mutation.folders,
          deletedFiles: mutation.deletedFiles, deletedFolders: mutation.deletedFolders, selectedFileId,
          messages: chat.messages.map((message) => message.id === assistantId ? { ...message, content: text, status: 'done', model: actualModel, searchStatus: undefined, searchQuery: undefined } : message),
        };
      }));
      const appliedSummary = [...(count ? [`${count} file ${count === 1 ? 'change' : 'changes'}`] : []), ...latestMutation.applied];
      if (appliedSummary.length || latestMutation.skipped.length) {
        notify([...appliedSummary, ...latestMutation.skipped].join(' · '));
      } else if (canvasMutationRequested) {
        notify('No Canvas changes were applied. Ask AIFLUX for a complete fenced code block with a filename or an explicit file/folder action.');
      }
    }).catch((error: unknown) => {
      const aborted = controller.signal.aborted;
      const message = error instanceof Error ? error.message : 'Something went wrong.';
      patchMessage(chatId, assistantId, (previous) => ({
        ...previous, content: previous.content || (aborted ? 'Generation stopped.' : `**Could not generate a response.** ${message}`), status: 'error', searchStatus: undefined, searchQuery: undefined,
      }));
      if (!aborted) notify(message);
    }).finally(() => {
      if (abortRef.current?.controller === controller) { abortRef.current = null; setSending(false); }
    });
    return true;
  };

  const selectFile = (id: string) => updateActive((chat) => ({ ...chat, selectedFileId: id }));
  const updateFile = (id: string, content: string) => {
    setContextFile((current) => current?.canvasFileId === id && current.content !== content ? { ...current, content } : current);
    updateActive((chat) => ({ ...chat, updatedAt: Date.now(), files: chat.files.map((file) => file.id === id ? {
      ...file, content, origin: 'user', previousContent: file.lastChangedBy === 'user' ? file.previousContent ?? file.content : file.content, lastChangedBy: 'user',
    } : file) }));
  };
  const restoreFile = (id: string) => {
    const restoredContent = activeChat.files.find((file) => file.id === id)?.previousContent;
    if (restoredContent !== undefined) setContextFile((current) => current?.canvasFileId === id ? { ...current, content: restoredContent } : current);
    updateActive((chat) => ({ ...chat, updatedAt: Date.now(), files: chat.files.map((file) => file.id === id && file.previousContent !== undefined ? {
      ...file, content: file.previousContent, previousContent: file.previousContent, origin: 'user', lastChangedBy: 'user',
    } : file) }));
    notify('Previous Canvas version restored');
  };
  const createFile = (name: string, content = '') => {
    const file: WorkspaceFile = { id: crypto.randomUUID(), name, content, origin: 'user', previousContent: content, lastChangedBy: 'user' };
    updateActive((chat) => {
      const files = [...chat.files, file];
      return { ...chat, updatedAt: Date.now(), files, folders: expandFolderPaths([...(chat.folders || []), ...inferFolderPaths(files)]), selectedFileId: file.id };
    });
    notify(`${name} added to Canvas`);
  };
  const createFolder = (path: string) => {
    const result = applyWorkspaceOperations(activeChat.files, activeChat.folders || [], activeChat.deletedFiles || [], activeChat.deletedFolders || [], [{ type: 'create-folder', path }]);
    if (!result.applied.length) { notify(result.skipped[0] || `Could not create ${path}/`); return; }
    updateActive((chat) => ({ ...chat, updatedAt: Date.now(), folders: result.folders }));
    notify(result.applied[0]);
  };
  const deleteFile = (id: string) => {
    if (contextFile?.canvasFileId === id) setContextFile(null);
    updateActive((chat) => {
      const file = chat.files.find((item) => item.id === id);
      if (!file) return chat;
      const files = chat.files.filter((item) => item.id !== id);
      return {
        ...chat, updatedAt: Date.now(), files,
        deletedFiles: [...(chat.deletedFiles || []).filter((item) => item.id !== id), file],
        selectedFileId: chat.selectedFileId === id ? files[0]?.id || null : chat.selectedFileId,
      };
    });
    notify('Moved to Recently deleted. You can restore it from the Canvas file list.');
  };
  const deleteFolder = (path: string) => {
    const attachedName = contextFile?.canvasFileId && activeChat.files.find((file) => file.id === contextFile.canvasFileId)?.name;
    if (attachedName && (attachedName === path || attachedName.startsWith(`${path}/`))) setContextFile(null);
    const result = applyWorkspaceOperations(activeChat.files, activeChat.folders || [], activeChat.deletedFiles || [], activeChat.deletedFolders || [], [{ type: 'delete-folder', path }]);
    if (!result.applied.length) { notify(result.skipped[0] || `Could not delete ${path}/`); return; }
    updateActive((chat) => ({ ...chat, updatedAt: Date.now(), files: result.files, folders: result.folders, deletedFiles: result.deletedFiles, deletedFolders: result.deletedFolders, selectedFileId: result.files.some((file) => file.id === chat.selectedFileId) ? chat.selectedFileId : result.files[0]?.id || null }));
    notify(result.applied[0]);
  };
  const restoreDeletedFile = (id: string) => {
    const deleted = activeChat.deletedFiles?.find((item) => item.id === id);
    if (!deleted) return;
    const activeFolders = expandFolderPaths([...(activeChat.folders || []), ...inferFolderPaths(activeChat.files)]);
    const fileConflict = activeChat.files.some((item) => item.name === deleted.name || deleted.name.startsWith(`${item.name}/`) || item.name.startsWith(`${deleted.name}/`));
    if (fileConflict || activeFolders.includes(deleted.name)) { notify(`Cannot restore ${deleted.name}: a file or folder conflicts with that path.`); return; }
    updateActive((chat) => {
      const file = chat.deletedFiles?.find((item) => item.id === id);
      if (!file) return chat;
      const files = [...chat.files, file];
      const parentFolders = inferFolderPaths([file]);
      return {
        ...chat, updatedAt: Date.now(), files,
        folders: expandFolderPaths([...(chat.folders || []), ...parentFolders]),
        deletedFiles: (chat.deletedFiles || []).filter((item) => item.id !== id),
        deletedFolders: (chat.deletedFolders || []).filter((folder) => !parentFolders.includes(folder)),
        selectedFileId: id,
      };
    });
    notify('File restored to Canvas');
  };
  const restoreDeletedFolder = (path: string) => {
    const activeFolders = expandFolderPaths([...(activeChat.folders || []), ...inferFolderPaths(activeChat.files)]);
    if (activeFolders.includes(path)) {
      updateActive((chat) => ({ ...chat, updatedAt: Date.now(), deletedFolders: (chat.deletedFolders || []).filter((folder) => folder !== path) }));
      notify(`Folder ${path}/ already exists; cleared its stale Recently deleted entry.`);
      return;
    }
    const fileConflict = activeChat.files.some((file) => file.name === path || path.startsWith(`${file.name}/`) || file.name.startsWith(`${path}/`));
    if (fileConflict) { notify(`Cannot restore ${path}/: a file conflicts with that path.`); return; }
    const restoredPaths = new Set(expandFolderPaths([path]));
    updateActive((chat) => ({ ...chat, updatedAt: Date.now(), folders: expandFolderPaths([...(chat.folders || []), path]), deletedFolders: (chat.deletedFolders || []).filter((folder) => !restoredPaths.has(folder)) }));
    notify(`Folder ${path}/ restored`);
  };
  const openSnippet = (content: string, info: string) => {
    const existing = activeChat.files.find((file) => file.content.trim() === content.trim());
    if (existing) selectFile(existing.id);
    else {
      const generated = extractCodeFiles(`\`\`\`${info}\n${content}\n\`\`\``, activeChat.files);
      if (generated.length) updateActive((chat) => {
        const files = mergeGeneratedFiles(chat.files, generated);
        return { ...chat, files, folders: expandFolderPaths([...(chat.folders || []), ...inferFolderPaths(files)]), selectedFileId: generated[0].id, updatedAt: Date.now() };
      });
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
        catalogAvailable={freeCatalogAvailable} connected={anyConnected} sending={sending} contextFile={contextFile}
        searchMode={searchMode} onCycleSearchMode={cycleSearchMode} isConnected={isConnected} onSend={sendMessage}
        onStop={stop} onSelectModel={chooseModel} onLoadModels={() => void loadModels()}
        onLibrary={() => changeView('library')} onOpenSnippet={openSnippet} onClearContext={() => setContextFile(null)}
        onNotify={notify} onSettings={() => openSettings()} onGitHub={() => setGithubOpen(true)} />
        : <ModelLibrary models={models} selected={selectedModel} catalogAvailable={freeCatalogAvailable} isConnected={isConnected} onSelect={chooseModel} onSettings={openSettings} onRefresh={() => void loadModels(true)} />}
    </main>
    {(canvasVisible || mobileCanvasOpen) && <Canvas conversation={activeChat} mobileOpen={mobileCanvasOpen} onClose={closeCanvas} onSelectFile={selectFile} onUpdateFile={updateFile} onRestoreFile={restoreFile} onCreateFile={createFile} onCreateFolder={createFolder} onDeleteFile={deleteFile} onDeleteFolder={deleteFolder} onRestoreDeletedFile={restoreDeletedFile} onRestoreDeletedFolder={restoreDeletedFolder} onNotify={notify} onPublishGitHub={() => setGithubPublishOpen(true)} />}
    {mobileCanvasOpen && <button className="canvas-mobile-scrim" aria-label="Close Canvas" onClick={() => setMobileCanvasOpen(false)} />}
    {settingsOpen && <SettingsModal credentials={credentials} config={config} focusProvider={settingsProvider} onSave={saveSettings} onClose={() => setSettingsOpen(false)} />}
    {githubOpen && <GitHubContextModal onClose={() => setGithubOpen(false)} onUseContext={(file) => { setContextFile(file); setGithubOpen(false); notify(`${file.name} added as context for your next message.`); }} onNotify={notify} />}
    {githubPublishOpen && <GitHubPublishModal files={activeChat.files} onClose={() => setGithubPublishOpen(false)} onNotify={notify} onConnect={() => { setGithubPublishOpen(false); setGithubOpen(true); }} />}
    {toast && <div className="toast" role="status"><span><Check size={15} /></span>{toast}</div>}
  </div>;
}
